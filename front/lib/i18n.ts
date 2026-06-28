// 界面语言（i18n）核心——无框架依赖，content 脚本与 React 页面都可用。
// React 组件用的 useT hook 在 lib/i18n-react.ts（单独文件，避免 content 脚本打包进 React）。
//
// 支持 4 种界面语言：简体中文 / 繁体中文（台湾）/ 繁体中文（香港）/ 英文。
// 判定优先级：用户在设置页手动选的 > 浏览器首选语言（navigator.language）。
//   (a) 浏览器首选简体中文 → zh-CN
//   (b) 台湾繁体 → zh-TW；香港（及澳门）繁体 → zh-HK
//   (c) 其余所有语言 → en

import { MESSAGES, type Messages } from './i18n-messages';

export type { Messages };

/** 4 种界面语言代码。 */
export type UiLocale = 'zh-CN' | 'zh-TW' | 'zh-HK' | 'en';

/** 全部界面语言（设置页下拉用此顺序）。 */
export const UI_LOCALES: readonly UiLocale[] = ['zh-CN', 'zh-TW', 'zh-HK', 'en'] as const;

/** 各界面语言的自称名（设置页下拉显示）。 */
export const UI_LOCALE_NAMES: Record<UiLocale, string> = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文（台灣）',
  'zh-HK': '繁體中文（香港）',
  en: 'English',
};

export function isUiLocale(x: unknown): x is UiLocale {
  return typeof x === 'string' && (UI_LOCALES as readonly string[]).includes(x);
}

/**
 * 由浏览器首选语言推断界面语言。
 * 简体（zh / zh-CN / zh-Hans / zh-SG）→ zh-CN；台湾（含通用 Hant）→ zh-TW；
 * 香港 / 澳门 → zh-HK；其余一律 en。
 */
export function detectUiLocale(nav: string = navigator.language || ''): UiLocale {
  const l = nav.toLowerCase();
  if (l.startsWith('zh')) {
    if (l.includes('tw')) return 'zh-TW';
    if (l.includes('hk') || l.includes('mo')) return 'zh-HK';
    if (l.includes('hant')) return 'zh-TW'; // 通用繁体（无地区）默认台湾正体
    return 'zh-CN'; // zh / zh-cn / zh-hans / zh-sg / 其余中文
  }
  return 'en';
}

/** 取某界面语言的全部文案。 */
export function getMessages(locale: UiLocale): Messages {
  return MESSAGES[locale];
}

/* ───────────────────────── 界面语言的持久化（用户覆盖） ───────────────────────── */
// 单独存在这里（不进 storage.ts 的 KEYS）：让 i18n.ts 自包含、与 storage.ts 零循环依赖。

const UI_LANG_KEY = 'ui_lang';

/** 读取用户手动设置的界面语言；未设置返回 null（= 跟随浏览器）。 */
export async function getStoredUiLocale(): Promise<UiLocale | null> {
  const raw = await chrome.storage.local.get(UI_LANG_KEY);
  const v = raw[UI_LANG_KEY];
  return isUiLocale(v) ? v : null;
}

/** 当前生效的界面语言：用户设置优先，否则按浏览器首选语言推断。 */
export async function getUiLocale(): Promise<UiLocale> {
  return (await getStoredUiLocale()) ?? detectUiLocale();
}

/** 设置界面语言；传 null 清除手动设置（恢复跟随浏览器）。 */
export async function setUiLocale(locale: UiLocale | null): Promise<void> {
  if (locale === null) await chrome.storage.local.remove(UI_LANG_KEY);
  else await chrome.storage.local.set({ [UI_LANG_KEY]: locale });
}

/** 订阅界面语言变化（设置页改了即时通知其它页面 / content）。返回取消订阅函数。 */
export function onUiLocaleChanged(cb: () => void): () => void {
  const listener = (changes: { [k: string]: chrome.storage.StorageChange }, area: string) => {
    if (area === 'local' && UI_LANG_KEY in changes) cb();
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
