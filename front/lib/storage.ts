// chrome.storage.local 的薄封装。
// 所有持久化项的 key 都集中在这里，方便审计。

import type { ProviderConfig } from './local-engine/types';
import { isPinProtected, getUnlockedKey } from './local-engine/key-vault';

// 平台 key 不再走 storage（改由 .env 注入，见 lib/config.ts）；这里管白名单 / 设置 /
// BYOK（买断用户自带模型）配置。BYOK 的 apiKey 存本地、永不上传（见 BYOK-第二批方案 §2）。
const KEYS = {
  whitelist: 'whitelist_domains',
  cacheEnabled: 'cache_enabled',
  buyout: 'buyout', // { active, code?, activatedAt? }
  byokEnabled: 'byok_enabled', // 买断后是否启用自带模型（关则仍走平台）
  byokConfig: 'byok_config', // ProviderConfig | 无
} as const;

/** 买断态：解锁 BYOK 的凭据（设备绑定，不送平台额度）。 */
export interface BuyoutState {
  active: boolean;
  code?: string;
  activatedAt?: number;
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

// —— 买断态 ——
export async function getBuyout(): Promise<BuyoutState> {
  const raw = await chrome.storage.local.get(KEYS.buyout);
  const v = raw[KEYS.buyout];
  return v && typeof v === 'object' ? (v as BuyoutState) : { active: false };
}

export async function setBuyout(state: BuyoutState): Promise<void> {
  await chrome.storage.local.set({ [KEYS.buyout]: state });
}

// —— BYOK 启用开关（默认关：买断后用户须显式开自带模型）——
export async function getByokEnabled(): Promise<boolean> {
  const raw = await chrome.storage.local.get(KEYS.byokEnabled);
  return raw[KEYS.byokEnabled] === true;
}

export async function setByokEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [KEYS.byokEnabled]: enabled });
}

// —— BYOK provider 配置（含 apiKey，永不上传）——
export async function getByokConfig(): Promise<ProviderConfig | null> {
  const raw = await chrome.storage.local.get(KEYS.byokConfig);
  const v = raw[KEYS.byokConfig];
  return v && typeof v === 'object' ? (v as ProviderConfig) : null;
}

export async function setByokConfig(cfg: ProviderConfig | null): Promise<void> {
  await chrome.storage.local.set({ [KEYS.byokConfig]: cfg });
}

/** 翻译路由三态：平台后端 / BYOK 直连 / BYOK 已加密但未解锁。 */
export type TranslateRoute =
  | { mode: 'platform' }
  | { mode: 'byok'; cfg: ProviderConfig }
  | { mode: 'locked' };

/**
 * 决定本次翻译走哪条路：
 *  - 未买断 / 未启用 BYOK / 配置不全 → platform（平台后端）。
 *  - 买断 + 启用 + 配置完整：
 *      · 开了 PIN 加密但 session 无解锁明文 → locked（引导用户在 popup 输 PIN）。
 *      · 否则 → byok，cfg.apiKey 取明文（PIN 关＝config 里的明文；PIN 开＝session 解锁明文）。
 */
export async function resolveTranslateRoute(): Promise<TranslateRoute> {
  const [buyout, enabled, cfg] = await Promise.all([getBuyout(), getByokEnabled(), getByokConfig()]);
  if (!buyout.active || !enabled || !cfg || !cfg.endpoint || !cfg.model) return { mode: 'platform' };

  if (await isPinProtected()) {
    const unlocked = await getUnlockedKey();
    if (unlocked === null) return { mode: 'locked' };
    return { mode: 'byok', cfg: { ...cfg, apiKey: unlocked } };
  }
  return { mode: 'byok', cfg };
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
