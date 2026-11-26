// 阅读任务的执行器。
//
// 原脚本在页面里用一个 while 循环 + setTimeout 跑完，页面一刷新就断。扩展的
// 后台是随时会被回收的 MV3 service worker，因此这里沿用搜索任务的写法：
// 每一步由一个 durable alarm 兜底，短间隔再用一个 worker 内定时器抢先执行；
// 步骤号写在 storage 里，定时器与报警同时到达时只有一次能认领。
//
// 与页面无关：阅读任务不打开标签页，也不操作 Rewards 页面，只调用移动端接口。

import { browser } from 'wxt/browser';
import { getStorageItem, setStorageItem } from '@/entrypoints/hooks/useStorage';
import { StorageValues } from '@/entrypoints/enums/storageValues';
import {
    READ_MAX_SUBMISSIONS,
    READ_PROGRESS_KEY,
    hasReadCredentials,
    isReadAlarm,
    isReadStartAlarm,
    nextReadDelayMs,
    parseReadAlarm,
    parseReadStartAlarm,
    readAlarmName,
    readStartAlarmName,
    readTargetFor,
    type ReadRunProgress,
    type ReadTaskInfo,
} from '@/entrypoints/utils/readTask';
import { getReadAuth, getReadTask, submitReadActivity } from './readApi';
import { currentRun, endRun, noteReadDeadline, recordResult } from './taskRun';
import { ensureCleanupAlarm } from './cleanupAlarm';
import { RESULTS_KEY, type TaskResult, type TaskResults } from '@/entrypoints/utils/runState';

// Chrome 会把短于 30 秒的 alarm 抬到 30 秒，所以 15–20 秒的间隔只能靠
// worker 内定时器。报警仍按 30 秒安排，作为 worker 被回收后的兜底。
const ALARM_MIN_DELAY_MS = 30000;
// 报警迟到多久仍算 "正常等待"。超过这个余量的轮次由 tabCleanup 判为中断。
const STEP_WAKE_ALLOWANCE_MS = 120000;

type FinishResult = Pick<TaskResult, 'status' | 'reason'> & {
    status: 'completed' | 'cancelled' | 'failed' | 'unconfirmed';
};

let shortStepTimer: ReturnType<typeof setTimeout> | undefined;
// 搜索结束后那段可调等待的 worker 内定时器（短于报警下限时使用）。
let startTimer: ReturnType<typeof setTimeout> | undefined;

async function readProgress(): Promise<ReadRunProgress | null> {
    return await getStorageItem<ReadRunProgress>(READ_PROGRESS_KEY, StorageValues.LOCAL);
}

async function writeProgress(progress: ReadRunProgress | null): Promise<void> {
    await setStorageItem(READ_PROGRESS_KEY, progress, StorageValues.LOCAL);
}

export async function clearReadProgress(): Promise<void> {
    await writeProgress(null);
}

// 认领与写入必须串行：定时器和兜底报警可能在同一拍到达，两次读改写会互相覆盖。
let stepChain: Promise<void> = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = stepChain.then(operation, operation);
    stepChain = run.then(() => undefined, () => undefined);
    return run;
}

function claimReadStep(runId: number, step: number): Promise<boolean> {
    return enqueue(async () => {
        const state = await readProgress();
        if (!state || state.runId !== runId || !state.isReading) return false;
        if (state.claimed >= step) return false;
        await writeProgress({ ...state, claimed: step });
        return true;
    });
}

function markSubmitted(runId: number, step: number): Promise<ReadRunProgress | null> {
    return enqueue(async () => {
        const state = await readProgress();
        if (!state || state.runId !== runId) return null;
        const next: ReadRunProgress = { ...state, submitted: Math.max(state.submitted, step) };
        await writeProgress(next);
        return next;
    });
}

async function readRunLive(runId: number): Promise<boolean> {
    const run = await currentRun();
    return run?.id === runId && run.phase === 'running' && Boolean(run.read);
}

function clearShortTimer(): void {
    if (shortStepTimer !== undefined) {
        clearTimeout(shortStepTimer);
        shortStepTimer = undefined;
    }
}

function clearStartTimer(): void {
    if (startTimer !== undefined) {
        clearTimeout(startTimer);
        startTimer = undefined;
    }
}

// 搜索任务结束后由 finishSearch 调用：按本轮冻结的等待时间安排阅读起跑。
// 等待可以是 0 秒；短于报警下限时用 worker 内定时器按时起跑，报警只作兜底。
export async function scheduleReadingStart(runId: number, delayMs: number): Promise<void> {
    const run = await currentRun();
    if (!run || run.id !== runId || run.phase !== 'running' || !run.read) return;

    const results = await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL);
    if (results?.read?.status !== 'running') return;
    const progress = await readProgress();
    if (progress?.runId === runId && progress.isReading) return;

    clearStartTimer();
    const name = readStartAlarmName(runId);
    await browser.alarms.clear(name);

    const waitMs = Math.max(0, Math.trunc(delayMs));
    if (waitMs === 0) {
        // 不 await：起跑第一步要访问网络，搜索那一半已经收尾，没必要让它等着。
        void startReading(runId).catch(() => {});
        return;
    }

    const alarmDelayMs = Math.max(waitMs, ALARM_MIN_DELAY_MS);
    await browser.alarms.create(name, { delayInMinutes: alarmDelayMs / 60000 });
    // The wait is part of the round's lifetime: if the worker dies here, the
    // sweep must be able to settle the reading half instead of leaving the
    // record blocking every later start.
    await noteReadDeadline(runId, Date.now() + alarmDelayMs + STEP_WAKE_ALLOWANCE_MS);
    if (waitMs < ALARM_MIN_DELAY_MS) {
        startTimer = setTimeout(() => {
            startTimer = undefined;
            void handleReadStartAlarm({ name }).catch(() => {});
        }, waitMs);
    }
}

export async function handleReadStartAlarm(alarm: { name: string }): Promise<void> {
    if (!isReadStartAlarm(alarm.name)) return;
    const target = parseReadStartAlarm(alarm.name);
    if (!target) return;

    const run = await currentRun();
    if (!run || run.id !== target.runId || run.phase !== 'running' || !run.read) {
        await browser.alarms.clear(alarm.name);
        return;
    }
    const results = await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL);
    if (results?.read?.status !== 'running') {
        await browser.alarms.clear(alarm.name);
        return;
    }
    // 定时器与报警谁先到都只起跑一次：清掉另一个与这条报警本身。
    clearStartTimer();
    await browser.alarms.clear(alarm.name);
    try {
        await startReading(target.runId);
    } catch {
        // 收尾写入失败时留待巡检按期限处理，别让报警处理器带着拒绝退出。
    }
}

// 一轮的入口。先读一次服务器进度，再决定是直接完成、报告不可执行，还是开始提交。
export async function startReading(runId: number): Promise<void> {
    try {
        // 起跑定时器与兜底报警可能同时到达；已经开跑就不再重复读任务。
        const existing = await readProgress();
        if (existing?.runId === runId && existing.isReading) return;

        const auth = await getReadAuth();
        if (!hasReadCredentials(auth)) {
            await finishRead(runId, { status: 'failed', reason: '阅读任务未授权，请在扩展设置中完成授权' });
            return;
        }
        // A stop can land between the round starting and this task reaching the
        // network. Nothing has been submitted yet, so just leave.
        if (!(await readRunLive(runId))) return;

        // Arm the durable sweep before the first network call: reading has no
        // tab, and a worker lost during this read would otherwise leave the
        // record with nothing to settle it.
        await ensureCleanupAlarm();

        const task = await getReadTask();
        if (!task) {
            await finishRead(runId, { status: 'failed', reason: '未找到阅读任务（该账号可能没有此 offer）' });
            return;
        }

        const target = readTargetFor(task.max);
        if (target === 0) {
            await finishRead(runId, { status: 'failed', reason: '阅读任务上限未知，本轮未提交' });
            return;
        }

        if (task.progress >= target) {
            await writeProgress({ runId, baseline: task.progress, max: task.max, target, submitted: 0, claimed: 0, isReading: false });
            // progress >= target can mean the task really is finished, or that
            // the server cap is higher and the extension's own 11-submission
            // ceiling is what was reached. Say which one it is.
            const reason = target < task.max
                ? `已达单轮上限 ${READ_MAX_SUBMISSIONS} 次：${task.progress}/${task.max}`
                : `阅读任务已完成：${task.progress}/${task.max}`;
            await finishRead(runId, { status: 'completed', reason });
            return;
        }

        await writeProgress({
            runId,
            baseline: task.progress,
            max: task.max,
            target,
            submitted: 0,
            claimed: 0,
            isReading: true,
        });
        // 第一步之前也记一个期限：worker 恰好在读任务与第一步之间被回收时，
        // 巡检仍能结束这一轮，而不是让 run 记录一直挡住后续启动。
        await noteReadDeadline(runId, Date.now() + ALARM_MIN_DELAY_MS + STEP_WAKE_ALLOWANCE_MS);
        await runReadStep(runId, 1);
    } catch (error) {
        await finishRead(runId, { status: 'failed', reason: reasonOf(error) });
    }
}

async function runReadStep(runId: number, step: number): Promise<void> {
    if (!(await claimReadStep(runId, step))) return;
    if (!(await readRunLive(runId))) return;

    try {
        await submitReadActivity();
    } catch (error) {
        await finishRead(runId, { status: 'failed', reason: reasonOf(error) });
        return;
    }

    const state = await markSubmitted(runId, step);
    if (!state) return;

    if (state.baseline + state.submitted >= state.target) {
        await completeReading(runId, state);
        return;
    }
    if (!(await readRunLive(runId))) return;

    try {
        await scheduleNextStep(runId, step + 1);
    } catch {
        await finishRead(runId, { status: 'failed', reason: '未能安排下一次阅读提交' });
    }
}

// 达到本轮目标后再读一次服务器进度，用真实进度写结果，而不是把 "提交成功"
// 当成 "已到账"。接口读不到时保留已完成流程的结论，并在原因里说明。
async function completeReading(runId: number, state: ReadRunProgress): Promise<void> {
    let confirmed: ReadTaskInfo | null = null;
    try {
        confirmed = await getReadTask();
    } catch {
        confirmed = null;
    }

    const submitted = state.submitted;
    const capped = state.target < state.max;
    const capNote = capped ? `（单轮上限 ${READ_MAX_SUBMISSIONS} 次）` : '';

    if (confirmed) {
        const done = confirmed.max > 0 && confirmed.progress >= confirmed.max;
        const reason = done
            ? `阅读任务已完成：${confirmed.progress}/${confirmed.max}`
            : `已提交 ${submitted} 次，服务器进度 ${confirmed.progress}/${confirmed.max}${capNote}`;
        // 提交过但服务器进度没有完全跟上：流程走完了，结果仍需确认。
        const status = done || confirmed.progress >= state.target ? 'completed' : 'unconfirmed';
        await finishRead(runId, { status, reason });
        return;
    }

    await finishRead(runId, {
        status: 'completed',
        reason: `已提交 ${submitted} 次${capNote}，未能再次读取服务器进度`,
    });
}

export async function scheduleNextStep(runId: number, step: number): Promise<void> {
    const delayMs = nextReadDelayMs();
    const name = readAlarmName(runId, step);
    const alarmDelayMs = Math.max(delayMs, ALARM_MIN_DELAY_MS);

    // The previous step's 30s backstop is still armed when the short timer won
    // the race. Drop it so a finished step cannot fire later; only the pending
    // step keeps an alarm.
    await browser.alarms.clear(readAlarmName(runId, step - 1));
    await browser.alarms.create(name, { delayInMinutes: alarmDelayMs / 60000 });
    await noteReadDeadline(runId, Date.now() + alarmDelayMs + STEP_WAKE_ALLOWANCE_MS);

    clearShortTimer();
    if (delayMs < ALARM_MIN_DELAY_MS) {
        shortStepTimer = setTimeout(() => {
            shortStepTimer = undefined;
            void handleReadAlarm({ name });
        }, delayMs);
    }
}

export async function handleReadAlarm(alarm: { name: string }): Promise<void> {
    if (!isReadAlarm(alarm.name)) return;
    const target = parseReadAlarm(alarm.name);
    // 没有轮次与步骤的裸报警无法归属，直接丢弃。
    if (!target) return;

    const run = await currentRun();
    if (!run || run.id !== target.runId || run.phase !== 'running' || !run.read) {
        await browser.alarms.clear(alarm.name);
        return;
    }

    const state = await readProgress();
    if (!state || state.runId !== target.runId) {
        await browser.alarms.clear(alarm.name);
        return;
    }
    // 只跑下一个该跑的步骤。已认领过的（另一个触发器先到）或更早的报警都是陈旧的。
    if (target.step !== state.claimed + 1) {
        await browser.alarms.clear(alarm.name);
        return;
    }

    await runReadStep(target.runId, target.step);
}

// 清掉所有阅读报警（含等待起跑的那一个）、两个定时器，并把 "正在阅读" 标记
// 放下。只清这一功能的报警，不动搜索步骤与巡检报警。
export async function stopReading(): Promise<void> {
    clearShortTimer();
    clearStartTimer();
    const all = await browser.alarms.getAll();
    await Promise.all(
        all
            .filter((alarm) => isReadAlarm(alarm.name) || isReadStartAlarm(alarm.name))
            .map((alarm) => browser.alarms.clear(alarm.name))
    );
    const state = await readProgress();
    if (state?.isReading) await writeProgress({ ...state, isReading: false });
}

// 本轮阅读的统一收尾：结果、报警、轮次记录一起更新。
export async function finishRead(runId: number, result: FinishResult): Promise<void> {
    let settled = false;
    try {
        await recordResult(runId, 'read', result);
        settled = true;
    } finally {
        try {
            // 清理是全局的（所有阅读报警），所以只有本轮仍持有记录时才能做。
            if ((await currentRun())?.id === runId) await stopReading();
        } finally {
            if (settled) await endRun(runId, 'read');
        }
    }
}

// 用户在弹窗里清除授权时调用：正在跑的一轮不能继续用旧令牌，按取消收尾。
export async function cancelReading(reason: string): Promise<void> {
    const run = await currentRun();
    if (run?.read && run.phase === 'running') {
        await finishRead(run.id, { status: 'cancelled', reason });
        return;
    }
    await stopReading();
}

function reasonOf(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    return '阅读任务执行失败';
}
