// chrome.storage.local 的薄封装。
// 所有持久化项的 key 都集中在这里，方便审计。

// 平台 key 不走 storage（改由 .env 注入，见 lib/config.ts）；这里只管白名单 / 设置。

import { defaultTargetLang } from './languages';
const KEYS = {
  whitelist: 'whitelist_domains',
  cacheEnabled: 'cache_enabled',
  targetLang: 'target_lang',
  bilingual: 'bilingual',
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

/** 本地译文缓存开关，默认开启：仅显式存 false 才算关闭。 */
export async function getCacheEnabled(): Promise<boolean> {
  const raw = await chrome.storage.local.get(KEYS.cacheEnabled);
  return raw[KEYS.cacheEnabled] !== false;
}

export async function setCacheEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [KEYS.cacheEnabled]: enabled });
}

/** 目标语言代码（如 'zh' / 'ja' / 'en-US'）。未设置时回退到按界面语言推断的默认值。 */
export async function getTargetLang(): Promise<string> {
  const raw = await chrome.storage.local.get(KEYS.targetLang);
  const v = raw[KEYS.targetLang];
  return typeof v === 'string' && v ? v : defaultTargetLang();
}

export async function setTargetLang(code: string): Promise<void> {
  await chrome.storage.local.set({ [KEYS.targetLang]: code });
}

/**
 * 双语对照开关，默认关闭：仅显式存 true 才算开启。
 * 开启时译文「追加」在原文下方（原文不被替换）；关闭时译文「替换」原文（默认隐形模式）。
 */
export async function getBilingual(): Promise<boolean> {
  const raw = await chrome.storage.local.get(KEYS.bilingual);
  return raw[KEYS.bilingual] === true;
}

export async function setBilingual(on: boolean): Promise<void> {
  await chrome.storage.local.set({ [KEYS.bilingual]: on });
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
