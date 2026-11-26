// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { getStorageItem } from '@/entrypoints/hooks/useStorage';
import { StorageValues } from '@/entrypoints/enums/storageValues';
import { READ_PROGRESS_KEY, readAlarmName, readStartAlarmName, type ReadRunProgress } from '@/entrypoints/utils/readTask';
import { RESULTS_KEY, RUN_KEY, type TaskResults } from '@/entrypoints/utils/runState';
import { beginRun } from './taskRun';
import { handleReadAlarm, handleReadStartAlarm, scheduleReadingStart, startReading, stopReading } from './readRunner';
import { getReadAuth, getReadTask, submitReadActivity } from './readApi';

vi.mock('./readApi', () => ({
    getReadAuth: vi.fn(),
    getReadTask: vi.fn(),
    submitReadActivity: vi.fn(),
}));

const CONFIG = { searches: 5, timeout: 60, closeTime: 5 };

describe('阅读任务执行器', () => {
    beforeEach(() => {
        fakeBrowser.reset();
        vi.clearAllMocks();
        vi.mocked(getReadAuth).mockResolvedValue({ refreshToken: 'refresh-token' });
        vi.mocked(submitReadActivity).mockResolvedValue(undefined);
    });

    it('先提交第一步，再按轮次与步骤安排下一次报警', async () => {
        vi.mocked(getReadTask).mockResolvedValue({ progress: 0, max: 2 });
        const run = await beginRun(['read'], CONFIG);

        await startReading(run.id);

        expect(submitReadActivity).toHaveBeenCalledTimes(1);
        const progress = await getStorageItem<ReadRunProgress>(READ_PROGRESS_KEY, StorageValues.LOCAL);
        expect(progress).toMatchObject({ runId: run.id, baseline: 0, target: 2, submitted: 1, claimed: 1, isReading: true });

        const alarms = (await fakeBrowser.alarms.getAll()).map((alarm) => alarm.name);
        expect(alarms).toContain(readAlarmName(run.id, 2));
    });

    it('达到目标后写入完成结果、清掉轮次记录并放下正在阅读标记', async () => {
        vi.mocked(getReadTask)
            .mockResolvedValueOnce({ progress: 0, max: 2 })
            .mockResolvedValueOnce({ progress: 2, max: 2 });
        const run = await beginRun(['read'], CONFIG);
        await startReading(run.id);

        await handleReadAlarm({ name: readAlarmName(run.id, 2) });

        expect(submitReadActivity).toHaveBeenCalledTimes(2);
        const results = await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL);
        expect(results?.read?.status).toBe('completed');
        expect(results?.read?.reason).toContain('2/2');
        expect(await getStorageItem(RUN_KEY, StorageValues.LOCAL)).toBeNull();

        const progress = await getStorageItem<ReadRunProgress>(READ_PROGRESS_KEY, StorageValues.LOCAL);
        expect(progress?.isReading).toBe(false);
        expect((await fakeBrowser.alarms.getAll()).filter((alarm) => alarm.name.startsWith('readActivity'))).toHaveLength(0);
    });

    it('同一报警重复到达时只提交一次', async () => {
        vi.mocked(getReadTask).mockResolvedValue({ progress: 0, max: 5 });
        const run = await beginRun(['read'], CONFIG);
        await startReading(run.id);

        await handleReadAlarm({ name: readAlarmName(run.id, 2) });
        await handleReadAlarm({ name: readAlarmName(run.id, 2) });

        expect(submitReadActivity).toHaveBeenCalledTimes(2);
    });

    it('搜索结束后按等待时间安排起跑：等待期间不提交，报警到达才开始', async () => {
        vi.mocked(getReadTask).mockResolvedValue({ progress: 0, max: 5 });
        const run = await beginRun(['read'], CONFIG);

        await scheduleReadingStart(run.id, 20000);

        expect(submitReadActivity).not.toHaveBeenCalled();
        expect(await fakeBrowser.alarms.get(readStartAlarmName(run.id))).toBeDefined();

        await handleReadStartAlarm({ name: readStartAlarmName(run.id) });

        expect(submitReadActivity).toHaveBeenCalledTimes(1);
        const progress = await getStorageItem<ReadRunProgress>(READ_PROGRESS_KEY, StorageValues.LOCAL);
        expect(progress).toMatchObject({ runId: run.id, isReading: true, submitted: 1 });
        await stopReading();
    });

    it('停止会清掉等待中的起跑报警', async () => {
        const run = await beginRun(['read'], CONFIG);
        await scheduleReadingStart(run.id, 20000);
        expect(await fakeBrowser.alarms.get(readStartAlarmName(run.id))).toBeDefined();

        await stopReading();

        expect(await fakeBrowser.alarms.get(readStartAlarmName(run.id))).toBeUndefined();
    });

    it('等待时间为 0 时直接开始', async () => {
        vi.mocked(getReadTask).mockResolvedValue({ progress: 0, max: 5 });
        const run = await beginRun(['read'], CONFIG);

        await scheduleReadingStart(run.id, 0);
        // 起跑不 await 网络：让挂起的 promise 跑完。
        await vi.waitFor(() => expect(submitReadActivity).toHaveBeenCalledTimes(1));

        await stopReading();
    });

    it('没有授权时结果是失败，并说明要去设置里授权', async () => {
        vi.mocked(getReadAuth).mockResolvedValue(null);
        const run = await beginRun(['read'], CONFIG);

        await startReading(run.id);

        expect(submitReadActivity).not.toHaveBeenCalled();
        const results = await getStorageItem<TaskResults>(RESULTS_KEY, StorageValues.LOCAL);
        expect(results?.read?.status).toBe('failed');
        expect(results?.read?.reason).toContain('未授权');
        expect(await getStorageItem(RUN_KEY, StorageValues.LOCAL)).toBeNull();
    });
});
