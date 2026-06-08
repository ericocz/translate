// 匿名身份：首次运行生成并持久化 deviceId（UUID），随每次翻译请求带给后端。
// 本地日期（用户时区 YYYY-MM-DD）：匿名「每页一次 / 3 页一天」按本地日跨天重置（P2 用）。

const DEVICE_KEY = 'device_id';

/** 取或建匿名设备 ID（持久在 chrome.storage.local）。 */
export async function getDeviceId(): Promise<string> {
  const got = await chrome.storage.local.get(DEVICE_KEY);
  const existing = got[DEVICE_KEY];
  if (typeof existing === 'string' && existing) return existing;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [DEVICE_KEY]: id });
  return id;
}

/** 用户本地时区的 YYYY-MM-DD（用本地 getFullYear/getMonth/getDate，不是 UTC）。 */
export function localDateString(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
