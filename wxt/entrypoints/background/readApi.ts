// 阅读任务的 OAuth 与 Rewards 接口访问层。
//
// 原脚本用 GM_xmlhttpRequest + @connect 直接访问 login.live.com 与
// prod.rewardsplatform.microsoft.com；在扩展里，这两步由后台的 fetch 承担，
// 跨域由 manifest 的 host_permissions 放行（MV2 下并入 permissions）。
//
// 与脚本的差异：
// - 令牌只写 local storage，不随设置同步，也不进诊断导出；
// - 换 token 用 POST 表单而不是把 code/token 拼在 URL 上；
// - 错误只保留一句脱敏后的中文原因，不保留响应正文。

import { getStorageItem, setStorageItem } from '@/entrypoints/hooks/useStorage';
import { StorageValues } from '@/entrypoints/enums/storageValues';
import {
    READ_API_BASE,
    READ_APP_ID,
    READ_AUTH_KEY,
    READ_CLIENT_ID,
    READ_COUNTRY,
    READ_OFFER_ID,
    READ_REDIRECT_URI,
    READ_REQUEST_TIMEOUT_MS,
    READ_SCOPE,
    READ_TOKEN_URL,
    extractAuthCode,
    hasReadCredentials,
    readAuthIsFresh,
    readTaskFromMe,
    type ReadAuth,
    type ReadTaskInfo,
} from '@/entrypoints/utils/readTask';

export class ReadApiError extends Error {
    status: number;
    code: string;

    constructor(message: string, status = 0, code = '') {
        super(message);
        this.name = 'ReadApiError';
        this.status = status;
        this.code = code;
    }
}

export interface ReadAuthResult {
    ok: boolean;
    message: string;
    task?: ReadTaskInfo;
}

function trimmed(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function positiveNumber(value: unknown): number | undefined {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

// 只留下这一层确实需要的字段，避免把接口返回的账号信息顺手写进存储。
function normalizeAuth(raw: unknown): ReadAuth | null {
    if (raw == null || typeof raw !== 'object') return null;
    const source = raw as Record<string, unknown>;
    const auth: ReadAuth = {};
    const code = trimmed(source.code);
    const refreshToken = trimmed(source.refreshToken);
    const accessToken = trimmed(source.accessToken);
    const lastError = trimmed(source.lastError);
    const accessTokenExpiresAt = positiveNumber(source.accessTokenExpiresAt);
    const authorizedAt = positiveNumber(source.authorizedAt);
    const lastErrorAt = positiveNumber(source.lastErrorAt);
    if (code) auth.code = code;
    if (refreshToken) auth.refreshToken = refreshToken;
    if (accessToken) auth.accessToken = accessToken;
    if (lastError) auth.lastError = lastError;
    if (accessTokenExpiresAt) auth.accessTokenExpiresAt = accessTokenExpiresAt;
    if (authorizedAt) auth.authorizedAt = authorizedAt;
    if (lastErrorAt) auth.lastErrorAt = lastErrorAt;
    return auth;
}

export async function getReadAuth(): Promise<ReadAuth | null> {
    return normalizeAuth(await getStorageItem<ReadAuth>(READ_AUTH_KEY, StorageValues.LOCAL));
}

// 串行化授权信息的读改写：并发的刷新或清除不会用旧快照覆盖新值。
let authChain: Promise<void> = Promise.resolve();

// 授权代次。用户重新授权或清除授权时递增；在此之前发出的刷新即使晚一步
// 返回，也不能把新写入的 code/refresh token 覆盖掉。
let authGeneration = 0;

function enqueueAuth<T>(operation: () => Promise<T>): Promise<T> {
    const run = authChain.then(operation, operation);
    authChain = run.then(() => undefined, () => undefined);
    return run;
}

export function patchReadAuth(patch: Partial<ReadAuth>): Promise<void> {
    return enqueueAuth(async () => {
        const current = await getReadAuth();
        const next: ReadAuth = { ...(current ?? {}), ...patch };
        // undefined 表示删除该字段；JSON 序列化会把它丢掉，读取时空值即视为没有。
        await setStorageItem(READ_AUTH_KEY, next, StorageValues.LOCAL);
    });
}

// 只有代次没变时才写入刷新结果。返回 false 表示这次刷新属于已经被替换或
// 清除的授权，结果直接丢弃。
function commitTokenPatch(generation: number, patch: Partial<ReadAuth>): Promise<boolean> {
    return enqueueAuth(async () => {
        if (generation !== authGeneration) return false;
        const current = await getReadAuth();
        await setStorageItem(READ_AUTH_KEY, { ...(current ?? {}), ...patch }, StorageValues.LOCAL);
        return true;
    });
}

export function clearReadAuth(reason?: string): Promise<void> {
    authGeneration += 1;
    return enqueueAuth(async () => {
        await setStorageItem(
            READ_AUTH_KEY,
            reason
                ? { lastError: sanitize(reason), lastErrorAt: Date.now() }
                : null,
            StorageValues.LOCAL
        );
    });
}

function sanitize(message: string): string {
    return message
        .replace(/https?:\/\/\S+/gi, '[链接]')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160);
}

function reasonOf(error: unknown): string {
    if (error instanceof Error && error.message) return sanitize(error.message);
    return '网络请求失败';
}

interface RawResponse {
    status: number;
    ok: boolean;
    json: unknown;
}

async function fetchJson(url: string, init: RequestInit): Promise<RawResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), READ_REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            ...init,
            signal: controller.signal,
            // 认证靠 Bearer 头。不带 cookie，避免把浏览器的 Rewards 会话也卷进来。
            credentials: 'omit',
            cache: 'no-store',
        });
        const text = await response.text();
        let json: unknown = null;
        try {
            json = text ? JSON.parse(text) : null;
        } catch {
            json = null;
        }
        return { status: response.status, ok: response.ok, json };
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            throw new ReadApiError('请求超时');
        }
        throw new ReadApiError('网络请求失败');
    } finally {
        clearTimeout(timer);
    }
}

function field(source: unknown, key: string): unknown {
    return source != null && typeof source === 'object' ? (source as Record<string, unknown>)[key] : undefined;
}

// 令牌接口失败时的原因：优先 error_description，其次是 error，最后是 HTTP 状态。
function tokenFailure(status: number, payload: unknown): { message: string; fatal: boolean } {
    const code = trimmed(field(payload, 'error'));
    const description = trimmed(field(payload, 'error_description'));
    const message = description || code || (status ? `令牌接口返回 HTTP ${status}` : '令牌获取失败');
    // invalid_grant / invalid_request 说明 code 或 refresh token 已经不能再用，
    // 继续留着只会让每次任务都重试同一个坏凭证。
    return { message: sanitize(message), fatal: code === 'invalid_grant' || code === 'invalid_request' || status === 400 };
}

interface TokenRequest {
    generation: number;
    promise: Promise<string | null>;
}

let tokenInFlight: TokenRequest | null = null;

// 返回可用的 access token；没有可续期的凭证时返回 null。
// 同一个 worker 内的并发调用共享一次刷新：refresh token 轮换后旧值会失效，
// 两个并发刷新可能让其中一个拿到已作废的凭证，所以 forceRefresh 也走同一次
// 进行中的请求。重新授权会递增代次，旧刷新不会被复用。
export function getAccessToken(options: { forceRefresh?: boolean } = {}): Promise<string | null> {
    if (tokenInFlight && tokenInFlight.generation === authGeneration) return tokenInFlight.promise;
    const generation = authGeneration;
    const task = refreshAccessToken(Boolean(options.forceRefresh), generation);
    tokenInFlight = { generation, promise: task };
    void task.then(
        () => { if (tokenInFlight?.promise === task) tokenInFlight = null; },
        () => { if (tokenInFlight?.promise === task) tokenInFlight = null; }
    );
    return task;
}

async function refreshAccessToken(forceRefresh: boolean, generation: number): Promise<string | null> {
    const auth = await getReadAuth();
    if (!forceRefresh && readAuthIsFresh(auth)) return auth!.accessToken!;
    if (!hasReadCredentials(auth)) return null;

    const refreshToken = trimmed(auth?.refreshToken);
    const code = trimmed(auth?.code);
    const body = new URLSearchParams({ client_id: READ_CLIENT_ID, scope: READ_SCOPE });
    if (refreshToken) {
        body.set('grant_type', 'refresh_token');
        body.set('refresh_token', refreshToken);
    } else {
        body.set('grant_type', 'authorization_code');
        body.set('code', code);
        body.set('redirect_uri', READ_REDIRECT_URI);
    }

    try {
        const response = await fetchJson(READ_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
        });
        const accessToken = trimmed(field(response.json, 'access_token'));
        if (response.ok && accessToken) {
            const expiresIn = Number(field(response.json, 'expires_in')) || 3600;
            const nextRefresh = trimmed(field(response.json, 'refresh_token')) || refreshToken;
            const committed = await commitTokenPatch(generation, {
                accessToken,
                accessTokenExpiresAt: Date.now() + expiresIn * 1000,
                // 授权码换过一次就不能再用；之后靠 refresh token 续期。
                code: undefined,
                refreshToken: nextRefresh || undefined,
                authorizedAt: Date.now(),
                lastError: undefined,
                lastErrorAt: undefined,
            });
            // 授权在刷新期间被替换：不要把旧凭证换来的 token 交给调用方，
            // 让这一步按失败收尾，下一轮用新授权重试。
            return committed ? accessToken : null;
        }
        const failure = tokenFailure(response.status, response.json);
        await commitTokenPatch(generation, {
            accessToken: undefined,
            accessTokenExpiresAt: undefined,
            ...(failure.fatal ? { code: undefined, refreshToken: undefined } : {}),
            lastError: failure.message,
            lastErrorAt: Date.now(),
        });
        return null;
    } catch (error) {
        // 网络错误不销毁凭证：用户下次点 “验证” 或下一轮任务还能再试。
        const message = reasonOf(error);
        await commitTokenPatch(generation, { lastError: message, lastErrorAt: Date.now() });
        return null;
    }
}

function apiHeaders(token: string, json: boolean): Record<string, string> {
    return {
        Authorization: `Bearer ${token}`,
        'X-Rewards-AppId': READ_APP_ID,
        'X-Rewards-IsMobile': 'true',
        ...(json ? { 'Content-Type': 'application/json', 'X-Rewards-Country': READ_COUNTRY } : {}),
    };
}

async function rewardsRequest(path: string, init: RequestInit = {}): Promise<unknown> {
    const send = async (token: string): Promise<RawResponse> => fetchJson(`${READ_API_BASE}${path}`, {
        ...init,
        headers: { ...apiHeaders(token, init.body != null), ...(init.headers as Record<string, string> | undefined) },
    });

    let token = await getAccessToken();
    if (!token) throw new ReadApiError('未授权', 401, 'unauthorized');

    let response = await send(token);
    if (response.status === 401) {
        token = await getAccessToken({ forceRefresh: true });
        if (!token) throw new ReadApiError('授权已失效，请重新授权', 401, 'unauthorized');
        response = await send(token);
    }
    if (!response.ok) {
        const errorCode = trimmed(field(response.json, 'code')) || trimmed(field(response.json, 'error'));
        throw new ReadApiError(
            response.status ? `Rewards 接口返回 HTTP ${response.status}` : 'Rewards 接口请求失败',
            response.status,
            errorCode
        );
    }
    return response.json;
}

export async function getRewardsMe(): Promise<unknown> {
    const payload = await rewardsRequest('/me?channel=SAAndroid&options=613', { method: 'GET' });
    // A 200 that is not JSON is a login/consent page or a changed endpoint, not
    // an account without the offer. Say so instead of reporting "no task".
    if (payload == null || typeof payload !== 'object') {
        throw new ReadApiError('Rewards 接口返回的不是 JSON，请检查授权或稍后重试');
    }
    return payload;
}

export async function getReadTask(): Promise<ReadTaskInfo | null> {
    return readTaskFromMe(await getRewardsMe());
}

// 一次阅读提交。id 是幂等键，必须每次新生成；offer 与 country 要和请求头一致。
export async function submitReadActivity(): Promise<void> {
    await rewardsRequest('/me/activities', {
        method: 'POST',
        body: JSON.stringify({
            amount: 1,
            country: READ_COUNTRY,
            id: uuid(),
            type: 101,
            attributes: { offerid: READ_OFFER_ID },
        }),
    });
}

// crypto.randomUUID 在 Firefox 95 之前没有；manifest 的 strict_min_version 是
// 91，所以保留一个 RFC 4122 v4 的等价实现。
function uuid(): string {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function validateReadAccess(): Promise<ReadAuthResult> {
    try {
        const task = await getReadTask();
        if (!task) {
            return { ok: false, message: '授权可用，但账号下没有阅读任务（该 offer 可能未开放）' };
        }
        return { ok: true, message: `授权有效，阅读任务 ${task.progress}/${task.max}`, task };
    } catch (error) {
        return { ok: false, message: reasonOf(error) };
    }
}

// 把用户粘贴的回调地址（或授权码）换成可用令牌，并读一次任务确认接口权限。
export async function applyAuthCode(input: string): Promise<ReadAuthResult> {
    const code = extractAuthCode(input);
    if (!code) return { ok: false, message: '无法从输入内容中提取授权码' };

    // 新授权开始：此前进行中的刷新即使晚一步返回，也不允许写回旧凭证。
    authGeneration += 1;
    await patchReadAuth({
        code,
        refreshToken: undefined,
        accessToken: undefined,
        accessTokenExpiresAt: undefined,
        authorizedAt: undefined,
        lastError: undefined,
        lastErrorAt: undefined,
    });

    const token = await getAccessToken({ forceRefresh: true });
    if (!token) {
        const message = (await getReadAuth())?.lastError ?? '令牌获取失败';
        return { ok: false, message };
    }
    return validateReadAccess();
}
