// chrome.storage.local 的薄封装。
// 所有持久化项的 key 都集中在这里，方便审计。

// API Key 不再走 storage（改由 .env 注入，见 lib/config.ts）；这里只管白名单与设置。
const KEYS = {
  whitelist: 'whitelist_domains',
} as const;

export async function getWhitelist(): Promise<string[]> {
  const raw = await chrome.storage.local.get(KEYS.whitelist);
  return Array.isArray(raw[KEYS.whitelist]) ? raw[KEYS.whitelist] : [];
}

export async function setWhitelist(list: string[]): Promise<void> {
  // 去重 + 小写 + 排序，方便比对与展示。
  const cleaned = Array.from(new Set(list.map((d) => d.trim().toLowerCase()).filter(Boolean))).sort();
  await chrome.storage.local.set({ [KEYS.whitelist]: cleaned });
}

/**
 * 当前域名是否在白名单。匹配规则：精确命中，或是某条白名单的子域。
 * 这样开启 `example.com` 即覆盖 `docs.example.com`、`www.example.com`，
 * 符合"按域名粒度"的直觉（白名单项已在写入时做过小写/去前缀规整）。
 */
export async function isDomainEnabled(domain: string): Promise<boolean> {
  const host = domain.toLowerCase();
  const list = await getWhitelist();
  return list.some((entry) => host === entry || host.endsWith('.' + entry));
}

export async function setDomainEnabled(domain: string, enabled: boolean): Promise<void> {
  const list = await getWhitelist();
  const lower = domain.toLowerCase();
  const set = new Set(list);
  if (enabled) set.add(lower);
  else set.delete(lower);
  await setWhitelist(Array.from(set));
}

export function onSettingsChanged(cb: (changes: chrome.storage.StorageChange) => void): () => void {
  const listener = (changes: { [k: string]: chrome.storage.StorageChange }, area: string) => {
    if (area !== 'local') return;
    // 任一相关键变化都回调一次。
    for (const k of Object.values(KEYS)) {
      if (k in changes) {
        cb(changes[k]!);
        return;
      }
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
