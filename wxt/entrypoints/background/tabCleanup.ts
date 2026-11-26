import { browser } from 'wxt/browser';
import { getStorageItem, setStorageItem } from '@/entrypoints/hooks/useStorage';
import { StorageValues } from '@/entrypoints/enums/storageValues';
import { DASHBOARD_MAX_LIFETIME_MS, RUN_KEY, type TaskRunState } from '@/entrypoints/utils/runState';
import { READ_ROUND_FALLBACK_MS } from '@/entrypoints/utils/readTask';
import { endRun, recordResult } from './taskRun';
import { finishSearch } from './searchRunner';
import { finishRead } from './readRunner';
import { CLEANUP_ALARM, ensureCleanupAlarm, isCleanupAlarm } from './cleanupAlarm';

// Re-exported for the worker's alarm router and the tests that already import
// it from this module.
export { isCleanupAlarm };

// Tab ids the extension opened, each mapped to the wall-clock time by which it
// must be gone.
type TrackedTabs = Record<string, number>;

const REGISTRY_KEY = 'trackedTabs';

// How long a search round may go without recording a next-step deadline before
// a sweep treats it as abandoned. Generous on purpose: the longest legitimate
// wait is one gap plus the platform's alarm floor, and this must not cut a slow
// but healthy round short.
const SEARCH_ROUND_FALLBACK_MS = 30 * 60 * 1000;

// Records a tab the extension opened so that it still gets closed when the
// setTimeout meant to close it never runs. That is the normal case in an MV3
// service worker: it is torn down after ~30s idle, taking pending timers and
// runtime-registered tab listeners with it, which is why search and daily-set
// tabs used to pile up. Alarms survive that teardown, so the sweep does not.
export function trackTab(tabId: number, closeAfterMs: number): Promise<void> {
    return enqueue(async () => {
        const tracked = await readRegistry();
        await writeRegistry({ ...tracked, [tabId]: Date.now() + closeAfterMs });
        await ensureCleanupAlarm();
    });
}

// Called once a tab has closed on time, so the sweep has nothing left to do.
export function untrackTab(tabId: number): Promise<void> {
    return enqueue(async () => {
        const tracked = await readRegistry();
        if (!(String(tabId) in tracked)) return;
        await saveRemaining(without(tracked, tabId));
    });
}

export function sweepStaleTabs(): Promise<void> {
    return enqueue(async () => {
        const entries = Object.entries(await readRegistry());
        const now = Date.now();
        const due = entries.filter(([, deadline]) => deadline <= now);
        const remaining = Object.fromEntries(entries.filter(([, deadline]) => deadline > now));

        await Promise.all(due.map(([tabId]) => closeTab(Number(tabId))));
        // Settle before the registry write. saveRemaining decides whether to
        // keep the sweep alarm, and it used to run while the dashboard flags
        // were still set. With the search tabs already gone, that cleared the
        // alarm while search was still running; a worker death after the step
        // alarm had fired then left the record blocking every later start.
        // The in-worker lifetime timer is gone after a worker restart, so a
        // dashboard whose deadline has passed would otherwise stay `running`
        // (or `stopping`) for good. Closing the tab is not enough: the result
        // has to be written and the record has to end.
        await settleDashboardIfGone();
        await saveRemaining(remaining);
    });
}

// Settles the parts of a round that have outlived their deadlines: the
// dashboard tab, an abandoned search schedule, and an abandoned reading run.
//
// The dashboard has to be this round's tab, not "any Rewards page": the user may
// have the dashboard open themselves, and counting that as ours would leave the
// round hanging. It also has to run for a `stopping` round — a stop whose
// in-worker cleanup was lost is exactly the state that would otherwise never
// end. Reading and search have no page to judge, so their recorded deadlines
// stand in.
async function settleDashboardIfGone(): Promise<void> {
    const run = await getStorageItem<TaskRunState>(RUN_KEY, StorageValues.LOCAL);
    if (!run) return;
    const stopping = run.phase === 'stopping';
    const dashboardKinds = (['daily', 'claim'] as const).filter((kind) => run[kind]);
    // A stopped round has no live page left to report, so whatever it still
    // held is over too.
    const stoppingSearch = stopping && run.search;
    const stoppingRead = stopping && run.read;
    // A search round is judged on the deadline its next step was due by: its
    // worker can die between opening a tab and arming that step, and nothing
    // else would ever end the record. That includes a round that also ran the
    // dashboard — those flags do not keep the search alive. A round that died
    // before recording that deadline falls back to its start time plus one full
    // step allowance.
    const searchDeadline = run.searchDeadline ?? roundStart(run) + SEARCH_ROUND_FALLBACK_MS;
    const abandonedSearch = run.search && !stopping && searchDeadline <= Date.now();
    // Reading has no page at all, so this deadline is its only evidence of
    // life. While search is still part of the round, reading is legitimately
    // waiting for it to finish (the configurable delay), and search has its own
    // deadline — judging read then would abandon a healthy round.
    const readDeadline = run.readDeadline ?? roundStart(run) + READ_ROUND_FALLBACK_MS;
    const abandonedRead = Boolean(run.read) && !run.search && !stopping && readDeadline <= Date.now();
    if (dashboardKinds.length === 0 && !stoppingSearch && !abandonedSearch && !stoppingRead && !abandonedRead) return;

    // The dashboard half still owns its page: if its own tab is alive and its
    // deadline has not passed, only the search half may be settled here.
    const dashboardDone =
        dashboardKinds.length === 0 ||
        (dashboardDeadlinePassed(run) && !(await tabIsStillOpen(run)));

    const cancelled = { status: 'cancelled' as const, reason: '已停止' };
    if (dashboardDone) {
        const result = stopping ? cancelled : { status: 'unconfirmed' as const, reason: '页面未在时限内返回结果' };
        for (const kind of dashboardKinds) {
            await recordResult(run.id, kind, result);
            await endRun(run.id, kind);
        }
    }
    // The search half ends through the same end step as every other ending, so
    // the sweep also clears the search flag, the badge and the alarms a round
    // abandoned mid-flight left behind — not just the result and the record.
    if (stoppingSearch) {
        await finishSearch(run.id, cancelled);
    } else if (abandonedSearch) {
        await finishSearch(run.id, { status: 'unconfirmed', reason: '后台中断，未能确认本轮搜索' });
    }
    // Reading ends through its own end step too, so its alarms, its short timer
    // and its "正在阅读" flag cannot outlive the round.
    if (stoppingRead) {
        await finishRead(run.id, cancelled);
    } else if (abandonedRead) {
        await finishRead(run.id, { status: 'unconfirmed', reason: '后台中断，未能确认本轮阅读' });
    }
}

// A round that never recorded its tab (the create() failed, or the worker died
// in the gap between starting the round and opening the page) is judged on its
// own start time instead, so a round that just began is never mistaken for an
// abandoned one.
function dashboardDeadlinePassed(run: TaskRunState): boolean {
    const deadline = run.dashboardDeadline ?? roundStart(run) + DASHBOARD_MAX_LIFETIME_MS;
    return deadline <= Date.now();
}

// `startedAt` was added after the first release of this state model, so a record
// written by an older build has none. Its id is a millisecond timestamp, which is
// the same moment — using it keeps such a record from being settled instantly on
// a NaN comparison. A record with neither is left alone rather than guessed at.
function roundStart(run: TaskRunState): number {
    if (Number.isFinite(run.startedAt)) return run.startedAt;
    if (Number.isFinite(run.id)) return run.id;
    return Number.POSITIVE_INFINITY;
}

async function tabIsStillOpen(run: TaskRunState, tabId = run.dashboardTabId): Promise<boolean> {
    if (tabId == null) return false;
    try {
        const tab = await browser.tabs.get(tabId);
        return tab != null;
    } catch {
        return false;
    }
}

// Tab ids do not survive a browser restart, so a registry carried over from the
// previous session points at tabs that no longer exist.
export function clearTrackedTabs(): Promise<void> {
    return enqueue(() => saveRemaining({}));
}

// One chain for every read-modify-write of the registry. A second call that
// arrives while the first is still awaiting its snapshot has to wait, or the
// older snapshot is written back over the newer registration. A failure is
// reported to that caller and then dropped here, so the next operation still runs.
let registryChain: Promise<void> = Promise.resolve();

function enqueue(operation: () => Promise<void>): Promise<void> {
    const run = registryChain.then(operation, operation);
    registryChain = run.then(() => {}, () => {});
    return run;
}

async function readRegistry(): Promise<TrackedTabs> {
    return (await getStorageItem<TrackedTabs>(REGISTRY_KEY, StorageValues.LOCAL)) ?? {};
}

async function writeRegistry(tracked: TrackedTabs): Promise<void> {
    await setStorageItem(REGISTRY_KEY, tracked, StorageValues.LOCAL);
}

// Nothing tracked means nothing to close, so the alarm is dropped rather than
// waking the worker every minute for the rest of the session — unless a round
// is still open. Tabs leave this registry as soon as they close, which is
// before that record is cleared: dashboard finish untracks its tab first, and
// a search spends the gap until its next step with no tab at all. The sweep is
// what settles the record if the worker dies after a step alarm has fired and
// before the next one is armed. Limiting that to a search-only or stopping
// round dropped the alarm while a mixed round's search was still running.
async function saveRemaining(tracked: TrackedTabs): Promise<void> {
    await writeRegistry(tracked);
    if (Object.keys(tracked).length === 0 && !(await runNeedsSweep())) {
        await browser.alarms.clear(CLEANUP_ALARM);
        return;
    }
    await ensureCleanupAlarm();
}

async function runNeedsSweep(): Promise<boolean> {
    const run = await getStorageItem<TaskRunState>(RUN_KEY, StorageValues.LOCAL);
    return run != null;
}

function without(tracked: TrackedTabs, tabId: number): TrackedTabs {
    return Object.fromEntries(Object.entries(tracked).filter(([id]) => id !== String(tabId)));
}

async function closeTab(tabId: number): Promise<void> {
    try {
        await browser.tabs.get(tabId);
        await browser.tabs.remove(tabId);
    } catch {
        // Already gone — closed by its own timer, or by the user.
    }
}
