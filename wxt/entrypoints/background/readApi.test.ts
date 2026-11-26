// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { applyAuthCode, getReadAuth, getReadTask, patchReadAuth } from './readApi';
import {
    READ_API_BASE,
    READ_OFFER_ID,
    READ_REDIRECT_URI,
    READ_TOKEN_URL,
} from '@/entrypoints/utils/readTask';

function jsonResponse(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function meResponse(progress: number, max: number): Response {
    return jsonResponse({
        response: { promotions: [{ attributes: { offerid: READ_OFFER_ID, progress, max } }] },
    });
}

function tokenBody(init: RequestInit | undefined): URLSearchParams {
    return new URLSearchParams(String(init?.body ?? ''));
}

describe('阅读任务接口层', () => {
    beforeEach(() => fakeBrowser.reset());
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('用 POST 表单把授权码换成令牌，并存下 refresh token', async () => {
        const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
            const target = String(url);
            if (target === READ_TOKEN_URL) {
                return jsonResponse({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 });
            }
            if (target.startsWith(`${READ_API_BASE}/me`)) return meResponse(2, 11);
            return jsonResponse({}, 404);
        });
        vi.stubGlobal('fetch', fetchMock);

        const result = await applyAuthCode('https://login.live.com/oauth20_desktop.srf?code=THE_CODE');

        expect(result).toEqual({ ok: true, message: '授权有效，阅读任务 2/11', task: { progress: 2, max: 11 } });
        const tokenCall = fetchMock.mock.calls.find(([url]) => String(url) === READ_TOKEN_URL);
        expect(tokenCall).toBeDefined();
        expect(tokenCall?.[1]?.method).toBe('POST');
        const body = tokenBody(tokenCall?.[1]);
        expect(body.get('grant_type')).toBe('authorization_code');
        expect(body.get('code')).toBe('THE_CODE');
        expect(body.get('redirect_uri')).toBe(READ_REDIRECT_URI);

        const auth = await getReadAuth();
        expect(auth).toMatchObject({ refreshToken: 'rt-1', accessToken: 'at-1' });
        // 授权码只能换一次，换到令牌后就不再保留。
        expect(auth?.code).toBeUndefined();
    });

    it('Rewards 接口 401 时刷新一次令牌并重发，使用的是新 access token', async () => {
        await patchReadAuth({
            refreshToken: 'rt-old',
            accessToken: 'at-stale',
            accessTokenExpiresAt: Date.now() + 3600_000,
        });
        const authorized: string[] = [];
        const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
            const target = String(url);
            if (target === READ_TOKEN_URL) {
                return jsonResponse({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 });
            }
            const header = (init?.headers as Record<string, string> | undefined)?.Authorization ?? '';
            authorized.push(header);
            if (header === 'Bearer at-stale') return jsonResponse({ error: 'expired' }, 401);
            return meResponse(4, 11);
        });
        vi.stubGlobal('fetch', fetchMock);

        await expect(getReadTask()).resolves.toEqual({ progress: 4, max: 11 });

        expect(authorized).toEqual(['Bearer at-stale', 'Bearer at-new']);
        const tokenCall = fetchMock.mock.calls.find(([url]) => String(url) === READ_TOKEN_URL);
        expect(tokenBody(tokenCall?.[1]).get('grant_type')).toBe('refresh_token');
        expect(tokenBody(tokenCall?.[1]).get('refresh_token')).toBe('rt-old');
        await expect(getReadAuth()).resolves.toMatchObject({
            accessToken: 'at-new',
            refreshToken: 'rt-new',
        });
    });

    it('令牌接口返回 invalid_grant 时清掉不能再用凭证，并留下原因', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
            error: 'invalid_grant',
            error_description: 'The provided value for the input parameter code is not valid.',
        }, 400)));

        const result = await applyAuthCode('?code=expired-code');

        expect(result.ok).toBe(false);
        expect(result.message).toContain('not valid');
        const auth = await getReadAuth();
        expect(auth?.refreshToken).toBeUndefined();
        expect(auth?.code).toBeUndefined();
        expect(auth?.lastError).toContain('not valid');
    });
});
