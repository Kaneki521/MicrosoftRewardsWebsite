import { defineBackground } from '#imports';
import { browser } from 'wxt/browser';
import {
    handleDailyCheckAlarm,
    handleInstallOrUpdate,
    handleStartup,
    isDailyCheckAlarm,
    runRewards,
    scheduleDailyCheckAlarm,
    stopRewards,
    watchDailyFeatureToggles,
} from './background/dailySchedule';
import { migrateRunState } from './background/stateMigration';
import { handleAlarmStep, mayOpenFirstResult, watchSearchesToggle } from './background/searchRunner';
import { cancelReading, clearReadProgress, handleReadAlarm, handleReadStartAlarm } from './background/readRunner';
import { applyAuthCode, clearReadAuth, patchReadAuth, validateReadAccess } from './background/readApi';
import { isCleanupAlarm, sweepStaleTabs } from './background/tabCleanup';
import { TASK_KINDS, type TaskKind } from './utils/runState';
import { buildReadAuthUrl, isReadAlarm, isReadStartAlarm } from './utils/readTask';
import type { CommandReceipt } from './background/taskRun';

interface ReadAuthReply {
    ok: boolean;
    message: string;
}

function requestedTasks(value: unknown): TaskKind[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const kinds = value.filter((item): item is TaskKind => TASK_KINDS.includes(item as TaskKind));
    return kinds.length > 0 ? kinds : undefined;
}

// runRewards and stopRewards refuse with their own reasons; an unexpected throw
// still has to answer, or the popup's request would hang until its channel
// closes with the popup.
function failedReceipt(): CommandReceipt {
    return { accepted: false, reason: '操作未能完成，请重试' };
}

function failedAuth(message: string): ReadAuthReply {
    return { ok: false, message };
}

export default defineBackground(() => {
    browser.runtime.onInstalled.addListener(handleInstallOrUpdate);
    browser.runtime.onStartup.addListener(handleStartup);
    watchSearchesToggle();
    watchDailyFeatureToggles();
    // Covers a fresh install and any other worker wake-up that isn't a full
    // browser restart, so the daily-check alarm doesn't wait on onStartup.
    // Migration is idempotent and opens nothing; a wake that is the first one
    // after an update has to run it before the alarm is armed.
    void migrateRunState().then(() => scheduleDailyCheckAlarm());
    browser.runtime.onMessage.addListener((request: {
        action?: string;
        only?: unknown;
        code?: unknown;
        error?: unknown;
        errorDescription?: unknown;
        value?: unknown;
    }, sender: { tab?: { id?: number } }, sendResponse: (response?: unknown) => void) => {
        // The button is a manual start: it may re-run a task already attempted
        // today. `only` limits that to the tasks the button named, so a retry of
        // one failure does not restart the others. Start and stop answer with a
        // receipt, so a click the background refused is shown as refused.
        if (request.action === 'popup') {
            void runRewards({ manual: true, only: requestedTasks(request.only) }).then(
                (receipt) => sendResponse(receipt),
                () => sendResponse(failedReceipt())
            );
            return true;
        } else if (request.action === 'stop') {
            void stopRewards().then(
                (receipt) => sendResponse(receipt),
                () => sendResponse(failedReceipt())
            );
            return true;
        } else if (request.action === 'bingFirstResult') {
            // The bing-result content script asks this before leaving the
            // results page, and awaits the reply. Returning true keeps the
            // channel open for it. An unexpected throw still has to answer —
            // the script reads anything but an explicit yes as a no, so a
            // missing reply would keep it waiting until the page unloads.
            void mayOpenFirstResult(sender.tab?.id).then(
                (allowed) => sendResponse({ allowed }),
                () => sendResponse({ allowed: false })
            );
            return true;
        } else if (request.action === 'readAuthOpen') {
            // Opened by the background, not the popup: the popup closes as soon
            // as the auth tab takes focus, and the round has to survive that.
            void browser.tabs.create({ url: buildReadAuthUrl(), active: true }).then(
                () => sendResponse({ accepted: true }),
                () => sendResponse({ accepted: false, reason: '无法打开授权页面' })
            );
            return true;
        } else if (request.action === 'readAuthCallback') {
            // Sent by the content script on login.live.com's desktop callback
            // page. The tab is closed once the code has been exchanged, so the
            // popup can be reopened on a settled state rather than a blank page.
            const tabId = sender.tab?.id;
            const code = typeof request.code === 'string' ? request.code : '';
            const error = typeof request.error === 'string' ? request.error : '';
            const description = typeof request.errorDescription === 'string' ? request.errorDescription : '';
            void (async (): Promise<ReadAuthReply> => {
                if (error) {
                    const message = `授权失败：${description || error}`;
                    await clearReadAuth(message);
                    return failedAuth(message);
                }
                if (!code) return failedAuth('回调里没有授权码');
                const result = await applyAuthCode(code);
                // Keep a failure visible after the tab closes. A success clears
                // it inside applyAuthCode's token exchange.
                if (!result.ok) await patchReadAuth({ lastError: result.message, lastErrorAt: Date.now() });
                return { ok: result.ok, message: result.message };
            })().then(
                (reply) => {
                    sendResponse(reply);
                    // A successful exchange leaves nothing to read on that page.
                    // A failure stays visible there instead of being closed away;
                    // the popup also keeps it as `lastError`.
                    if (reply.ok && tabId != null) void browser.tabs.remove(tabId).catch(() => {});
                },
                () => sendResponse(failedAuth('授权处理失败，请重试'))
            );
            return true;
        } else if (request.action === 'readAuthSubmit') {
            // Manual fallback for the same flow: the user pastes the callback
            // URL or the bare code into the popup.
            const value = typeof request.value === 'string' ? request.value : '';
            void applyAuthCode(value).then(
                (result) => sendResponse({ ok: result.ok, message: result.message }),
                () => sendResponse(failedAuth('授权处理失败，请重试'))
            );
            return true;
        } else if (request.action === 'readAuthValidate') {
            void validateReadAccess().then(
                (result) => sendResponse({ ok: result.ok, message: result.message }),
                () => sendResponse(failedAuth('验证失败，请重试'))
            );
            return true;
        } else if (request.action === 'readAuthClear') {
            // Clearing the token must also end a read that is using it, or the
            // next step would run with credentials the user just removed.
            void (async (): Promise<ReadAuthReply> => {
                await cancelReading('已清除阅读授权');
                await clearReadAuth();
                await clearReadProgress();
                return { ok: true, message: '授权已清除' };
            })().then(
                (reply) => sendResponse(reply),
                () => sendResponse(failedAuth('清除授权失败，请重试'))
            );
            return true;
        }
    });
    // Registered here, at the worker's top level, so the browser wakes a
    // torn-down service worker for it — the only kind of timer that survives.
    browser.alarms.onAlarm.addListener((alarm) => {
        if (isCleanupAlarm(alarm.name)) void sweepStaleTabs();
        else if (isDailyCheckAlarm(alarm.name)) void handleDailyCheckAlarm(alarm);
        else if (isReadStartAlarm(alarm.name)) void handleReadStartAlarm(alarm);
        else if (isReadAlarm(alarm.name)) void handleReadAlarm(alarm);
        else void handleAlarmStep(alarm);
    });
});
