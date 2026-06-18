// 结构分区：把抽取出的块按所属「页面地标」分到正文(content) / 外框(chrome) 两层，
// 供 background 按区域并发提交翻译、正文优先（见 translate-cached.ts 的 translateByRegion）。
//
// 为什么做（反转旧「不做正文识别/视口优先」原则）：DOM 顶部多是导航/页眉，按 DOM 顺序翻会让
// 用户正在读的正文排在导航后面才出。识别 <main>/<article> 让正文先翻，导航/页脚慢半拍没人在意。

export type Tier = 'content' | 'chrome';

// 正文地标：<main>/<article> 及 role 等价。
const CONTENT_SEL = 'main, [role="main"], article';
// 外框地标：导航/页眉/侧栏/页脚/搜索等「整站复用、用户不盯着读」的区域。
const CHROME_SEL =
  'nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"], [role="search"]';

/**
 * 按「最近的地标祖先」把块归到 content / chrome。
 * - 无任何地标 → 归 content（简单页 = 历史 DOM 顺序行为，零回归）。
 * - 谁更近算谁：<main> 里嵌 <aside> 的侧栏归 chrome；<aside> 里嵌 <article> 归 content。
 */
export function classifyTier(el: Element): Tier {
  const landmark = el.closest(`${CONTENT_SEL}, ${CHROME_SEL}`);
  if (!landmark) return 'content';
  return landmark.matches(CONTENT_SEL) ? 'content' : 'chrome';
}

export interface Tiered {
  tier?: Tier;
}

/** 把带 tier 的块拆成 content / chrome 两组（缺省 tier 视作 content）。纯函数，便于单测。 */
export function splitByTier<T extends Tiered>(blocks: T[]): { content: T[]; chrome: T[] } {
  const content: T[] = [];
  const chrome: T[] = [];
  for (const b of blocks) (b.tier === 'chrome' ? chrome : content).push(b);
  return { content, chrome };
}
