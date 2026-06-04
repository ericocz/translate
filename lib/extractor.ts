// 抽取器：用 TreeWalker 遍历 document.body，按"块级元素"切分翻译单元。
//
// 关键决策：
// - 块级元素：p / li / h1~h6 / td / th / blockquote / dt / dd / figcaption / summary。
//   还允许"叶子块"——含直接文本子节点、且没有再嵌套块级后代的 div/section/aside/article/header/footer 等。
// - 抽取时跳过 code / pre / script / style / noscript / template；行内 <code> 同样跳过其文字。
// - 内联样式元素（带语义的 span/a/strong/em/b/i/u/sub/sup/small/mark/kbd/abbr）转成 <gN>...</gN>。
// - 无文字内联对象（br/img/svg/input/button-without-text 等）转成 <xN/>。
// - 标记编号在每个块内独立从 0 开始。
//
// 副作用：抽取阶段会在每个块的 DOM 根节点写上 data-trans-id；保存 originalHTML
// 不在这里做（content script 在替换前再 cache，避免抽取期就持有一份大字符串）。

import { nextPairMarker, selfMarker } from './markers';
import type { TransBlock } from './types';

const BLOCK_TAGS = new Set([
  'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TD', 'TH',
  'BLOCKQUOTE', 'DT', 'DD', 'FIGCAPTION', 'SUMMARY', 'CAPTION',
]);

// "叶子块"：仅当其内部不含上面那种典型块标签时，才被当作单独翻译单元。
// 这样可以处理 <div>顶栏按钮文字</div>、<button>Submit</button> 这种界面文字。
const SOFT_BLOCK_TAGS = new Set([
  'DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'HEADER', 'FOOTER', 'NAV', 'MAIN',
  'BUTTON', 'A', 'SPAN', 'LABEL', 'OPTION',
]);

// 完全跳过的元素：进去会破坏代码 / 注入异物。
const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'CODE', 'PRE', 'TEXTAREA', 'KBD', 'SAMP', 'VAR',
  'IFRAME', 'OBJECT', 'EMBED', 'VIDEO', 'AUDIO', 'CANVAS', 'SVG',
]);

// 内联且带样式语义：会被转成 <gN>...</gN>。
const INLINE_STYLE_TAGS = new Set([
  'A', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'SUB', 'SUP', 'SMALL',
  'MARK', 'INS', 'DEL', 'CITE', 'Q', 'ABBR', 'DFN', 'TIME', 'BDI', 'BDO',
  'SPAN', 'FONT',
]);

// 内联无文字对象：转成 <xN/>。
const INLINE_VOID_TAGS = new Set([
  'BR', 'IMG', 'INPUT', 'WBR', 'HR', 'PICTURE',
]);

export interface ExtractResult {
  blocks: TransBlock[];
  /** 块根节点 → block。content script 用它做替换定位。 */
  rootById: Map<string, HTMLElement>;
}

/**
 * 抽取阶段入口。
 */
export function extractBlocks(root: HTMLElement): ExtractResult {
  const blocks: TransBlock[] = [];
  const rootById = new Map<string, HTMLElement>();
  let nextId = 1;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      const el = node as HTMLElement;
      if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
      if (el.closest('[contenteditable="true"]')) return NodeFilter.FILTER_REJECT;
      // 已被认领的块（含自身或祖先）整体跳过，避免一段文本被翻译两次。
      if (el.closest('[data-trans-id]')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  // 用 walker 找候选块根：先确定一个候选，再判断它内部是否还有更深的"硬块"。
  let cursor: Element | null = walker.currentNode as Element;
  // currentNode 初始就是 root；先 nextNode 进到第一个后代。
  cursor = walker.nextNode() as Element | null;
  while (cursor) {
    const el = cursor as HTMLElement;
    const isHard = BLOCK_TAGS.has(el.tagName);
    const isSoft = !isHard && SOFT_BLOCK_TAGS.has(el.tagName);
    let claim = false;

    if (isHard) {
      // 硬块：再看看里面是否含其他硬块（如 <li> 里嵌 <p>），若有则跳过自己，让深层来认领。
      claim = !hasDescendantHardBlock(el);
    } else if (isSoft) {
      // 软块认领条件：自己直接含可见文字 / 内联文字、且不含硬块。
      claim = hasDirectText(el) && !hasDescendantHardBlock(el);
    }

    if (claim) {
      const id = `b${nextId++}`;
      const styleMap = new Map<number, Element>();
      const source = serializeBlock(el, styleMap).trim();
      if (source.length > 0 && containsLetter(source)) {
        // 必须在 walker.nextNode() 之前打标，下一步 acceptNode 的 closest 检查就能
        // 自动跳过该子树。
        el.dataset['transId'] = id;
        blocks.push({ id, source, styleMap });
        rootById.set(id, el);
      }
    }
    cursor = walker.nextNode() as Element | null;
  }

  return { blocks, rootById };
}

function hasDescendantHardBlock(el: Element): boolean {
  // querySelector 比再开一个 walker 简单可靠。
  const sel = Array.from(BLOCK_TAGS).join(',').toLowerCase();
  return el.querySelector(sel) !== null;
}

function hasDirectText(el: Element): boolean {
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE && node.textContent && node.textContent.trim().length > 0) {
      return true;
    }
    // 直接子元素是内联样式且自身含文字，也算。
    if (node.nodeType === Node.ELEMENT_NODE) {
      const child = node as Element;
      if (INLINE_STYLE_TAGS.has(child.tagName) && child.textContent && child.textContent.trim().length > 0) {
        return true;
      }
    }
  }
  return false;
}

function containsLetter(s: string): boolean {
  // 没有任何字母字符的块（纯标点 / 数字 / 表情）不必翻。
  return /[A-Za-z]/.test(s);
}

/**
 * 把一个块内部序列化为带占位标记的纯文本。
 * 递归遍历子节点；遇到内联样式元素 → 包成 <gN>...</gN>；遇到无文字内联对象 → <xN/>；
 * 遇到 code/pre 等跳过元素 → 整段以其原始 textContent 嵌入（但不能翻），用 <xN/> 替代更稳。
 * 这里选择：跳过元素用单个 <xN/> 占位，把原元素整体存入 styleMap[n] 以便重建时直接放回去。
 */
function serializeBlock(root: Element, styleMap: Map<number, Element>): string {
  let counter = 0;
  const out: string[] = [];

  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out.push(node.textContent ?? '');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.tagName;

    if (SKIP_TAGS.has(tag)) {
      // 代码 / SVG / 媒体 一律占位，原物在 styleMap，重建时整段贴回。
      const n = counter++;
      styleMap.set(n, el.cloneNode(true) as Element);
      out.push(selfMarker(n));
      return;
    }
    if (INLINE_VOID_TAGS.has(tag)) {
      const n = counter++;
      styleMap.set(n, el.cloneNode(true) as Element);
      out.push(selfMarker(n));
      return;
    }
    if (INLINE_STYLE_TAGS.has(tag)) {
      const n = counter++;
      // 克隆一份"壳"：保留属性，但清空 children，重建时把译文塞回去。
      const shell = el.cloneNode(false) as Element;
      styleMap.set(n, shell);
      const [open, close] = nextPairMarker(n);
      out.push(open);
      for (const child of Array.from(el.childNodes)) visit(child);
      out.push(close);
      return;
    }
    // 其他元素（不太可能在块内出现）按容器递归。
    for (const child of Array.from(el.childNodes)) visit(child);
  };

  for (const child of Array.from(root.childNodes)) visit(child);
  return collapseSpaces(out.join(''));
}

function collapseSpaces(s: string): string {
  // 多空白折叠为单空格，避免抽取出来一堆换行喂给模型浪费 token。
  return s.replace(/[\t\n\r ]+/g, ' ').replace(/ +([,.;:!?])/g, '$1').trim();
}
