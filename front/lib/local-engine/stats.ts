// BYOK 降级率反馈（§7.4）的共享存储键：background 翻译结束写入本次 success/total，popup 读取后
// 在降级率偏高时给柔提示「当前模型对占位符支持不佳，建议换 X」。放 storage.session（内存态、随
// 浏览器关闭清空——降级提示是即时反馈，不必跨会话持久）。

import type { LocalStats } from './local-translator';

export const LAST_STATS_SESSION_KEY = 'byok_last_stats';

/** 降级率高于此值即提示（success/total 低于 1-阈值）。 */
export const DOWNGRADE_NOTICE_THRESHOLD = 0.3;

export async function writeLastStats(s: LocalStats): Promise<void> {
  await chrome.storage.session.set({ [LAST_STATS_SESSION_KEY]: s });
}

export async function readLastStats(): Promise<LocalStats | null> {
  const g = await chrome.storage.session.get(LAST_STATS_SESSION_KEY);
  const v = g[LAST_STATS_SESSION_KEY];
  return v && typeof v === 'object' ? (v as LocalStats) : null;
}

/** 降级率 = 1 - success/total；total=0 视为 0。 */
export function downgradeRate(s: LocalStats): number {
  if (s.total <= 0) return 0;
  return 1 - s.success / s.total;
}
