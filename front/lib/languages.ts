// 目标语言清单 + 按界面语言取显示名 / 排序。
// 数据来自 languages-{zh,en}.json（DeepSeek V4 支持的语种，两份只是排序取向不同：
// zh 版把中文系语种排前、en 版把英语系排前；每条带 zh(简体) / zhHant(繁体) / en(英文) 三种名）。
//
// 目标语言下拉据「界面语言」取清单与显示名（与界面语言保持一致）：
//   - 中文界面（zh-CN/zh-TW/zh-HK）→ 中文清单（中文系排前），名按简体 / 繁体取；
//   - 英文界面（en）→ 英文清单（英语系排前），用英文名。
// 默认目标语言「跟随界面语言」：zh-CN→zh、zh-TW→zh-TW、zh-HK→zh-HK、en→en-US。

import zhRaw from './languages-zh.json';
import enRaw from './languages-en.json';
import type { UiLocale } from './i18n';

/** languages-*.json 单条结构。 */
interface RawLanguage {
  code: string;
  en: string;
  zh: string; // 简体名
  zhHant: string; // 繁体名（台湾/香港语言名写法一致，单一繁体集）
  native: string;
  family: string;
}

/** 下拉用的精简项：code = 目标语言代码，label = 按界面语言取的显示名。 */
export interface LangOption {
  code: string;
  label: string;
}

const zhList = zhRaw as RawLanguage[];
const enList = enRaw as RawLanguage[];

/** 界面语言是否为中文（三种中文变体之一）。 */
function isZhLocale(locale: UiLocale): boolean {
  return locale === 'zh-CN' || locale === 'zh-TW' || locale === 'zh-HK';
}

/** 取某条语种在某界面语言下的显示名。 */
function labelOf(x: RawLanguage, locale: UiLocale): string {
  if (locale === 'zh-CN') return x.zh;
  if (locale === 'zh-TW' || locale === 'zh-HK') return x.zhHant;
  return x.en;
}

/**
 * 目标语言下拉选项：中文界面用中文清单（中文系排前）+ 简体/繁体名，英文界面用英文清单 + 英文名。
 * 排序逻辑与目标一致：中文界面中文排前、其余英文排前（由两份清单各自的固有顺序保证）。
 */
export function targetLanguages(locale: UiLocale): LangOption[] {
  const list = isZhLocale(locale) ? zhList : enList;
  return list.map((x) => ({ code: x.code, label: labelOf(x, locale) }));
}

/** 默认目标语言：跟随界面语言（zh-CN→zh、zh-TW→zh-TW、zh-HK→zh-HK、en→en-US）。 */
export function defaultTargetLang(locale: UiLocale): string {
  switch (locale) {
    case 'zh-CN':
      return 'zh';
    case 'zh-TW':
      return 'zh-TW';
    case 'zh-HK':
      return 'zh-HK';
    default:
      return enList[0]?.code ?? 'en-US';
  }
}
