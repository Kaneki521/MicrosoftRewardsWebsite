// 巡检报警的共享定义。
//
// 单独放一个模块，是因为它同时被 tabCleanup（标签页与轮次的收尾）和
// readRunner（阅读不打开标签页，但同样需要一条耐久的兜底）使用；两边互相
// import 会形成环，报警名本身也不该各写一份。

import { browser } from 'wxt/browser';

export const CLEANUP_ALARM = 'closeStaleTabs';

// Chrome 对重复报警的下限。巡检因此最迟在一分钟左右处理一个到期的标签页
// 或轮次，而不是等到下一次浏览器启动。
const SWEEP_PERIOD_MINUTES = 1;

export function isCleanupAlarm(name: string): boolean {
    return name === CLEANUP_ALARM;
}

// 已经存在时保留原计划：重复 create 会重置周期，把即将到来的巡检推后。
export async function ensureCleanupAlarm(): Promise<void> {
    if (await browser.alarms.get(CLEANUP_ALARM)) return;
    // 调用方刚刚登记了一个只能靠巡检收尾的对象，create 没有落地就必须让调用
    // 方知道，而不是把巡检报告成已安排。
    await browser.alarms.create(CLEANUP_ALARM, { periodInMinutes: SWEEP_PERIOD_MINUTES });
}
