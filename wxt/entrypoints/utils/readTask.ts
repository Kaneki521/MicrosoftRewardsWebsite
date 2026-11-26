// Microsoft Rewards 阅读任务的协议常量与纯函数。
//
// 从油猴脚本 “Microsoft Rewards - Reading Only” 1.7.0 迁移而来。这里只保留
// 与浏览器无关的部分：OAuth 参数、接口地址、报警名、授权码提取和任务进度判读。
// 页面上下文里的东西（右下角浮动面板、GM_* 存储、prompt/alert、完成后跳转）
// 不随之迁移，它们在扩展里分别由弹窗、storage、内联提示和轮次结束代替。

// 阅读任务在 Rewards 里的 offer id。
export const READ_OFFER_ID = 'ENUS_readarticle3_30points';

// 脚本使用的公开 OAuth 客户端（Microsoft 账号的 “desktop” 流程）。
export const READ_CLIENT_ID = '0000000040170455';
export const READ_SCOPE = 'service::prod.rewardsplatform.microsoft.com::MBI_SSL';
export const READ_REDIRECT_URI = 'https://login.live.com/oauth20_desktop.srf';
export const READ_AUTHORIZE_URL = 'https://login.live.com/oauth20_authorize.srf';
export const READ_TOKEN_URL = 'https://login.live.com/oauth20_token.srf';

// Rewards 移动端接口。AppId 与 country 必须与请求头、请求体一致，
// 否则同一个账号读不到这份 offer。
export const READ_API_BASE = 'https://prod.rewardsplatform.microsoft.com/dapi';
export const READ_APP_ID = 'SAAndroid/31.4.2110003555';
// 原脚本固定使用 cn；这是该 offer 的账号区域标记，不是界面语言。
export const READ_COUNTRY = 'cn';

// 单轮最多提交次数，沿用原脚本的 11 次上限。服务端 max 更小的时候以服务端为准。
export const READ_MAX_SUBMISSIONS = 11;

// 每次提交之间的随机间隔（原脚本 15–20 秒）。
export const READ_DELAY_MIN_MS = 15000;
export const READ_DELAY_MAX_MS = 20000;

// 单次 HTTP 请求超时（原脚本 GM_xmlhttpRequest 的 timeout）。
export const READ_REQUEST_TIMEOUT_MS = 20000;

// 本地存储键。授权信息只写 local：令牌不应随 sync 设置同步到其他设备。
export const READ_AUTH_KEY = 'readAuth';
export const READ_PROGRESS_KEY = 'readProgress';

// 报警名带上轮次与步骤，过期报警因此只能被它自己那一轮认领。
export const READ_ALARM_PREFIX = 'readActivity';

// “搜索结束后等待若干秒再开始阅读”的起跑报警。与提交步骤分开命名，
// 这样停止时能一起清掉，又不会被步骤解析误认。
export const READ_START_ALARM_PREFIX = 'readStart';

// 一轮阅读在没有任何新步骤记录时的兜底时限。正常等待是 15–20 秒加报警下限；
// 远超这个值说明后台在两步之间被销毁了，由 tabCleanup 的巡检收尾。
export const READ_ROUND_FALLBACK_MS = 15 * 60 * 1000;

export interface ReadAuth {
    // Authorization Code 只在首次换 token 时有值，换到 refresh token 后即失效。
    code?: string;
    refreshToken?: string;
    // Access Token 的缓存。服务工作线程会被回收，缓存必须落在 storage 里。
    accessToken?: string;
    accessTokenExpiresAt?: number;
    // 最近一次成功授权的时刻，弹窗用来显示 “已授权”。
    authorizedAt?: number;
    // 最近一次失败的简短原因。不含 URL、令牌或响应正文。
    lastError?: string;
    lastErrorAt?: number;
}

// 一轮阅读的进度。baseline 是开始时的服务器进度，submitted 是本轮已确认提交的次数。
export interface ReadRunProgress {
    runId: number;
    baseline: number;
    max: number;
    target: number;
    submitted: number;
    // 已经认领（正在提交或已提交）的步骤号，用于让定时器和兜底报警只跑一次。
    claimed: number;
    isReading: boolean;
}

export interface ReadTaskInfo {
    progress: number;
    max: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value != null && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function toCount(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// 授权 URL。与原脚本一致，不带 state：这是公开客户端的 desktop 流程，
// 回调页把 code 交回扩展后立刻换取令牌，code 不会被复用。
export function buildReadAuthUrl(): string {
    const params = new URLSearchParams({
        client_id: READ_CLIENT_ID,
        scope: READ_SCOPE,
        response_type: 'code',
        redirect_uri: READ_REDIRECT_URI,
    });
    return `${READ_AUTHORIZE_URL}?${params.toString()}`;
}

// 兼容三种输入：完整回调 URL、`?code=XXX` 片段、直接粘贴的 Authorization Code。
// 与脚本的 extractCode 行为一致，包括 M. 开头的旧式 code。
export function extractAuthCode(input: unknown): string {
    const text = String(input ?? '').trim();
    if (!text) return '';

    try {
        const url = new URL(text);
        const code = url.searchParams.get('code');
        if (code) return code;
    } catch {
        // 不是完整 URL，继续按片段或裸 code 处理。
    }

    const matchCode = /[?&]code=([^&\s]+)/i.exec(text);
    if (matchCode) {
        try {
            return decodeURIComponent(matchCode[1]);
        } catch {
            return matchCode[1];
        }
    }

    const matchM = /M\.[^&\s]+/.exec(text);
    if (matchM) return matchM[0];

    if (!text.includes('://')) return text;

    return '';
}

// 服务端 max 与扩展单轮上限取小。max 缺失或非正数时返回 0，由调用方判为不可执行。
export function readTargetFor(max: number): number {
    const safeMax = toCount(max);
    if (safeMax === 0) return 0;
    return Math.min(safeMax, READ_MAX_SUBMISSIONS);
}

export function nextReadDelayMs(random: () => number = Math.random): number {
    const spread = READ_DELAY_MAX_MS - READ_DELAY_MIN_MS;
    return READ_DELAY_MIN_MS + Math.floor(random() * (spread + 1));
}

export function readAlarmName(runId: number, step: number): string {
    return `${READ_ALARM_PREFIX}:${runId}:${step}`;
}

export function isReadAlarm(name: string): boolean {
    return name === READ_ALARM_PREFIX || name.startsWith(`${READ_ALARM_PREFIX}:`);
}

export function parseReadAlarm(name: string): { runId: number; step: number } | null {
    const match = /^readActivity:(\d+):(\d+)$/.exec(name);
    if (!match) return null;
    return { runId: Number(match[1]), step: Number(match[2]) };
}

export function readStartAlarmName(runId: number): string {
    return `${READ_START_ALARM_PREFIX}:${runId}`;
}

export function isReadStartAlarm(name: string): boolean {
    return name.startsWith(`${READ_START_ALARM_PREFIX}:`);
}

export function parseReadStartAlarm(name: string): { runId: number } | null {
    const match = /^readStart:(\d+)$/.exec(name);
    if (!match) return null;
    return { runId: Number(match[1]) };
}

// 从 /dapi/me 的响应里取出阅读任务的进度。找不到 offer 时返回 null，
// 由调用方区分 “没有这个任务” 和 “接口失败”。
export function readTaskFromMe(payload: unknown): ReadTaskInfo | null {
    const response = asRecord(asRecord(payload)?.response);
    const promotions = response?.promotions;
    if (!Array.isArray(promotions)) return null;

    for (const item of promotions) {
        const attributes = asRecord(asRecord(item)?.attributes);
        if (attributes?.offerid !== READ_OFFER_ID) continue;
        return { progress: toCount(attributes.progress), max: toCount(attributes.max) };
    }
    return null;
}

// 授权信息是否足以发起一次请求：refresh token 或尚未使用过的授权码。
// access token 只是缓存，单凭它过期后无法续期。
export function hasReadCredentials(auth: ReadAuth | null | undefined): boolean {
    if (!auth) return false;
    return Boolean(String(auth.refreshToken ?? '').trim() || String(auth.code ?? '').trim());
}

export function readAuthIsFresh(auth: ReadAuth | null | undefined): boolean {
    if (!auth?.accessToken) return false;
    const expiresAt = Number(auth.accessTokenExpiresAt) || 0;
    // 留一分钟余量，避免请求发出时刚好过期。
    return expiresAt > Date.now() + 60000;
}
