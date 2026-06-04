// chrome.storage.local 的薄封装。
// 所有持久化项的 key 都集中在这里，方便审计。

const KEYS = {
  apiKey: 'deepseek_api_key',
  whitelist: 'whitelist_domains',
  shortcut: 'shortcut_flip',
} as const;

export interface Settings {
  apiKey: string;
  /** 已开启自动翻译的域名集合。 */
  whitelist: string[];
  /** 仅用于设置页提示展示；真正的快捷键在 manifest commands 里。 */
  shortcutLabel: string;
}

export async function getSettings(): Promise<Settings> {
  const raw = await chrome.storage.local.get([KEYS.apiKey, KEYS.whitelist, KEYS.shortcut]);
  return {
    apiKey: typeof raw[KEYS.apiKey] === 'string' ? raw[KEYS.apiKey] : '',
    whitelist: Array.isArray(raw[KEYS.whitelist]) ? raw[KEYS.whitelist] : [],
    shortcutLabel: typeof raw[KEYS.shortcut] === 'string' ? raw[KEYS.shortcut] : 'Ctrl+A',
  };
}

export async function setApiKey(key: string): Promise<void> {
  await chrome.storage.local.set({ [KEYS.apiKey]: key });
}

export async function getWhitelist(): Promise<string[]> {
  const raw = await chrome.storage.local.get(KEYS.whitelist);
  return Array.isArray(raw[KEYS.whitelist]) ? raw[KEYS.whitelist] : [];
}

export async function setWhitelist(list: string[]): Promise<void> {
  // 去重 + 小写 + 排序，方便比对与展示。
  const cleaned = Array.from(new Set(list.map((d) => d.trim().toLowerCase()).filter(Boolean))).sort();
  await chrome.storage.local.set({ [KEYS.whitelist]: cleaned });
}

export async function isDomainEnabled(domain: string): Promise<boolean> {
  const list = await getWhitelist();
  return list.includes(domain.toLowerCase());
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
