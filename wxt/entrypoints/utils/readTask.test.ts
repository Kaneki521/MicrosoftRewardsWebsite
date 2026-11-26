import { describe, expect, it } from 'vitest';
import {
    READ_MAX_SUBMISSIONS,
    READ_REDIRECT_URI,
    buildReadAuthUrl,
    extractAuthCode,
    hasReadCredentials,
    isReadAlarm,
    isReadStartAlarm,
    nextReadDelayMs,
    parseReadAlarm,
    parseReadStartAlarm,
    readAlarmName,
    readStartAlarmName,
    readTargetFor,
    readTaskFromMe,
} from '@/entrypoints/utils/readTask';

describe('buildReadAuthUrl', () => {
    it('按原脚本的参数打开 desktop 授权流程', () => {
        const url = new URL(buildReadAuthUrl());
        expect(url.origin).toBe('https://login.live.com');
        expect(url.pathname).toBe('/oauth20_authorize.srf');
        expect(url.searchParams.get('client_id')).toBe('0000000040170455');
        expect(url.searchParams.get('response_type')).toBe('code');
        expect(url.searchParams.get('redirect_uri')).toBe(READ_REDIRECT_URI);
        expect(url.searchParams.get('scope')).toBe('service::prod.rewardsplatform.microsoft.com::MBI_SSL');
    });
});

describe('extractAuthCode', () => {
    it('从完整回调地址里取 code', () => {
        expect(extractAuthCode('https://login.live.com/oauth20_desktop.srf?code=M.abc123&lc=2052')).toBe('M.abc123');
    });

    it('兼容只有查询片段和直接粘贴的 code', () => {
        expect(extractAuthCode('?code=ABC%2B123')).toBe('ABC+123');
        expect(extractAuthCode('M.C125_BAY.2.U.xyz')).toBe('M.C125_BAY.2.U.xyz');
    });

    it('无法识别的 URL 不返回内容', () => {
        expect(extractAuthCode('https://example.com/callback')).toBe('');
        expect(extractAuthCode('   ')).toBe('');
    });
});

describe('readTargetFor', () => {
    it('不超过单轮 11 次，并以服务端上限为准', () => {
        expect(readTargetFor(30)).toBe(READ_MAX_SUBMISSIONS);
        expect(readTargetFor(3)).toBe(3);
    });

    it('上限缺失时返回 0，交由调用方判为不可执行', () => {
        expect(readTargetFor(0)).toBe(0);
        expect(readTargetFor(Number.NaN)).toBe(0);
    });
});

describe('readTaskFromMe', () => {
    it('从 promotions 里找到阅读 offer 的进度', () => {
        const payload = {
            response: {
                promotions: [
                    { attributes: { offerid: 'other', progress: 1, max: 2 } },
                    { attributes: { offerid: 'ENUS_readarticle3_30points', progress: '4', max: 11 } },
                ],
            },
        };
        expect(readTaskFromMe(payload)).toEqual({ progress: 4, max: 11 });
    });

    it('没有该 offer 或结构不认识时返回 null', () => {
        expect(readTaskFromMe({ response: { promotions: [] } })).toBeNull();
        expect(readTaskFromMe({ response: {} })).toBeNull();
        expect(readTaskFromMe(null)).toBeNull();
    });
});

describe('报警名', () => {
    it('带轮次与步骤，并能只认领自己的报警', () => {
        const name = readAlarmName(7, 2);
        expect(name).toBe('readActivity:7:2');
        expect(isReadAlarm(name)).toBe(true);
        expect(isReadAlarm('openTabAlarm:7:2')).toBe(false);
        expect(parseReadAlarm(name)).toEqual({ runId: 7, step: 2 });
        expect(parseReadAlarm('readActivity')).toBeNull();
    });
});

describe('起跑报警名', () => {
    it('只认自己的轮次，不与提交步骤报警混淆', () => {
        const name = readStartAlarmName(7);
        expect(name).toBe('readStart:7');
        expect(isReadStartAlarm(name)).toBe(true);
        expect(isReadStartAlarm('readActivity:7:1')).toBe(false);
        expect(parseReadStartAlarm(name)).toEqual({ runId: 7 });
        expect(parseReadStartAlarm('readStart')).toBeNull();
        expect(isReadAlarm(name)).toBe(false);
    });
});

describe('nextReadDelayMs', () => {
    it('间隔落在原脚本的 15–20 秒之内', () => {
        expect(nextReadDelayMs(() => 0)).toBe(15000);
        expect(nextReadDelayMs(() => 0.999999)).toBe(20000);
    });
});

describe('hasReadCredentials', () => {
    it('只有 access token 不算可续期', () => {
        expect(hasReadCredentials({ accessToken: 'x' })).toBe(false);
        expect(hasReadCredentials({ refreshToken: 'r' })).toBe(true);
        expect(hasReadCredentials({ code: 'c' })).toBe(true);
        expect(hasReadCredentials(null)).toBe(false);
    });
});
