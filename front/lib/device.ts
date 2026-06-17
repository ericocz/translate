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

/** chrome.instanceID：清 storage 免疫的实例标识（须卸载重装才变），比 deviceId 难重置。
 *  用作赠送 ¥2 的防薅幂等键——「清缓存换 deviceId 反复领」会被同一 instanceID 拦下。
 *  取不到（API 失败 / 缺 gcm 权限）则返回空串，后端回退 deviceId 幂等。 */
export async function getInstanceId(): Promise<string> {
  try {
    return await chrome.instanceID.getID();
  } catch {
    return '';
  }
}

/** 用户本地时区的 YYYY-MM-DD（用本地 getFullYear/getMonth/getDate，不是 UTC）。 */
export function localDateString(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 非加密快速哈希（cyrb53）：把页面 URL 压成短稳定 key，URL 不出本机（只发哈希给后端）。
function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** 页面身份 key：规范化（去 #fragment，保留 query）后哈希。用于匿名「每页一次」去重。 */
export function pageKeyFromUrl(url: string | undefined): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    return cyrb53(u.origin + u.pathname + u.search);
  } catch {
    return cyrb53(url);
  }
}
