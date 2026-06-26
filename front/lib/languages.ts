// 目标语言清单 + 界面语言判定。
// 数据来自 languages-{zh,en}.json（DeepSeek V4 支持的语种，两份只是排序/名称取向不同：
// zh 版把中文系语种排前、用中文名；en 版把英语系排前、用英文名）。
// popup 的目标语言下拉据「界面语言」二选一：浏览器是中文 6 变体 → 中文清单，否则英文清单。

import zhRaw from './languages-zh.json';
import enRaw from './languages-en.json';

/** languages-*.json 单条结构。 */
interface RawLanguage {
  code: string;
  en: string;
  zh: string;
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

// 中文界面：navigator.language 为 6 种中文变体之一（zh / zh-CN / zh-TW / zh-HK / zh-SG / zh-MO）。
// 统一按主标签 zh 前缀判定即覆盖这 6 种（含未来同族变体）。
const ZH_UI_LOCALES = ['zh', 'zh-CN', 'zh-TW', 'zh-HK', 'zh-SG', 'zh-MO'];

/** 当前浏览器界面语言是否为中文（6 变体之一）。 */
export function isZhUi(lang: string = navigator.language || ''): boolean {
  const l = lang.toLowerCase();
  return ZH_UI_LOCALES.some((z) => l === z.toLowerCase()) || l.startsWith('zh');
}

/** 目标语言下拉选项：中文界面用中文清单+中文名，其余用英文清单+英文名。 */
export function targetLanguages(zhUi: boolean = isZhUi()): LangOption[] {
  return zhUi
    ? zhList.map((x) => ({ code: x.code, label: x.zh }))
    : enList.map((x) => ({ code: x.code, label: x.en }));
}

/** 默认目标语言：取所选清单首项（中文清单首项=中文，英文清单首项=英语）。 */
export function defaultTargetLang(zhUi: boolean = isZhUi()): string {
  return (zhUi ? zhList[0]?.code : enList[0]?.code) ?? 'zh';
}
