// 抽取器：用 TreeWalker 遍历 document.body，按"块级元素"切分翻译单元。
//
// 关键决策：
// - 块级元素：p / li / h1~h6 / td / th / blockquote / dt / dd / figcaption / summary。
//   还允许"叶子块"——含直接文本子节点、且没有再嵌套块级后代的 div/section/aside/article/header/footer 等。
//   例外：纯链接 / 按钮组容器（裸 <a>/<button> 导航条、无 <li>）不整体认领，下沉让每项各成块——
//   否则双语对照时多个导航项译文挤成一团无法逐项对齐（isLinkGroupContainer）。
// - 抽取时跳过 code / pre / script / style / noscript / template；行内 <code> 同样跳过其文字。
// - 含可翻译文字的元素（内联样式 span/a/strong/em… 或 div/section 等容器）转成 <gN>...</gN>，保留属性壳。
// - 无文字子树（br/img/svg/input，或仅裹图标/图片的容器如 .navbar__logo）整体转成 <xN/>，深克隆保形。
// - 标记编号在每个块内独立从 0 开始。
//
// 副作用：抽取阶段会在每个块的 DOM 根节点写上 data-trans-id；保存 originalHTML
// 不在这里做（content script 在替换前再 cache，避免抽取期就持有一份大字符串）。

import { pairMarker, selfMarker, stripMarkers } from './markers';
import type { TransBlock } from './types';

const BLOCK_TAGS = new Set([
  'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TD', 'TH',
  'BLOCKQUOTE', 'DT', 'DD', 'FIGCAPTION', 'SUMMARY', 'CAPTION',
]);

// 硬块 CSS 选择器：从 BLOCK_TAGS 派生一次，供 hasDescendantHardBlock 复用（避免每块都重建字符串）。
const BLOCK_SELECTOR = Array.from(BLOCK_TAGS).join(',').toLowerCase();

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
      // 硬块：含其他硬块（如 <li> 里嵌 <p>）时一般跳过自己、让深层来认领。
      // 但若自己**还含直接文字 / 内联内容**（典型：紧凑列表项带子列表
      // `<li>正文…<ul>…</ul></li>`、单元格 `<td>正文…<table>…</table></td>`），
      // 那段直接文字不属于任何深层硬块——必须由自己认领整体，否则会漏翻（见经验库 #7）。
      // 反例不受影响：松散列表 `<li><p>…</p></li>` 的文字都在 <p> 里、li 无直接文字
      //（hasDirectText=false），仍让深层 <p> 认领，不会退化成大块。
      claim = !hasDescendantHardBlock(el) || hasDirectText(el);
    } else if (isSoft) {
      // 软块认领条件：自己直接含可见文字 / 内联文字、且不含硬块。
      // 软块不放开「有直接文字就认领整体」——div/main/section 等可能是整页级容器，
      // 一旦认领整体会把大量后代硬块吞成一个巨型块；混合内容只在硬块（粒度可控）上处理。
      // 例外：纯链接 / 按钮组容器（导航条 <div><a>Docs</a><a>Skills</a>…，裸 <a> 无 <li>）
      // 不认领整体——否则多个导航项被并成一块，双语对照时整段译文挤在末尾、无法逐项对齐
      //（「Docs Skills Download」后跟一团「文档 技能 下载」）。下沉让每个 <a>/<button> 各成一块，
      // 渲染即逐项交错「Docs 文档」「Skills 技能」。见 isLinkGroupContainer 的保守判定。
      claim = hasDirectText(el) && !hasDescendantHardBlock(el) && !isLinkGroupContainer(el);
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

/**
 * 按需抽取「单个元素」为一个翻译块（供 Ctrl+悬停整段翻译用）。
 * 与 extractBlocks 不同：不遍历后代找块根，而是直接把传入元素当作块根序列化——
 * 调用方（content 的 paragraphRootOf）负责挑出合适的「段落级」元素。
 * 返回 null 的情形：元素自身/祖先已被认领（含 data-trans-id）、序列化后无可翻译字母。
 * 副作用：成功时给元素写上 data-trans-id（沿用传入 id），后续整页抽取会自动跳过其子树。
 */
export function extractElement(el: HTMLElement, id: string): TransBlock | null {
  if (el.closest('[data-trans-id]')) return null;
  const styleMap = new Map<number, Element>();
  const source = serializeBlock(el, styleMap).trim();
  if (source.length === 0 || !containsLetter(source)) return null;
  el.dataset['transId'] = id;
  return { id, source, styleMap };
}

function hasDescendantHardBlock(el: Element): boolean {
  // querySelector 比再开一个 walker 简单可靠。
  return el.querySelector(BLOCK_SELECTOR) !== null;
}

/**
 * 「纯链接 / 按钮组容器」：直接子节点里**带文字的元素全是 `<a>`/`<button>`（≥2 个）、且无松散文本节点**。
 * 典型即裸链接导航条 `<div><a>Docs</a><a>Skills</a><a>Download</a></div>`（无 <li> 包裹）。
 * 保守：只要出现①任何非空松散文本节点（句子），或②带文字的非链接子元素（span 片段 / 嵌套容器），
 * 即判否（整体认领，维持原行为）——保证句子 / 混排绝不被拆坏，只命中干净的链接 / 按钮条。
 * 命中后调用方不认领该容器、下沉让每个 `<a>`/`<button>` 各自成块。
 */
function isLinkGroupContainer(el: Element): boolean {
  let links = 0;
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      if ((node.textContent ?? '').trim().length > 0) return false; // 松散文本＝句子，不拆
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const child = node as Element;
    if ((child.textContent ?? '').trim().length === 0) continue; // 图标 / 图片 wrapper 等无文字子树，忽略
    if (child.tagName === 'A' || child.tagName === 'BUTTON') {
      links++;
      continue;
    }
    return false; // 带文字的非链接子元素 → 可能是句子片段 / 嵌套容器，整体认领更安全
  }
  return links >= 2;
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

function containsLetter(source: string): boolean {
  // 判断块里有没有「真正需要翻译的英文字母」。
  // 关键：必须先剥掉占位标记再判断——否则标记里的 g/x 字母会被误当成正文字母，
  // 把纯图片单元格（source 仅 "<x0/>"）、纯数字（"<g0>1.</g0>"）等无文字块也抽进来，
  // 白白多发请求、拉低翻译占比（HN 的排名格 / 投票箭头格就是这么混进来的）。
  const text = stripMarkers(source);
  return /[A-Za-z]/.test(text);
}

/**
 * aria-hidden="true"：对辅助技术隐藏，按 ARIA 规范属装饰性 / 重复内容（图标、标题的阴影副本等），
 * 不该承载"别处没有的有效信息"。一律不翻译、原样保留——见 serializeBlock 里的踩坑说明。
 */
function isAriaHidden(el: Element): boolean {
  return el.getAttribute('aria-hidden') === 'true';
}

/**
 * 子树内是否存在「会被翻译的文字」：含字母、且不在 code / 媒体（SKIP）/ aria-hidden 子树内。
 * 决定一个容器是整体保形（<xN/>，无可翻译文字时）还是保壳递归（<gN>，有文字时）。
 * 与 containsLetter 的字母判定保持一致（[A-Za-z]）。
 */
function hasTranslatableText(el: Element): boolean {
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (/[A-Za-z]/.test(node.textContent ?? '')) return true;
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const child = node as Element;
    // code / svg / 媒体里的文字不译；无文字内联对象本就没文字；aria-hidden 是装饰/重复——都不算可翻译文字。
    if (SKIP_TAGS.has(child.tagName) || INLINE_VOID_TAGS.has(child.tagName) || isAriaHidden(child)) continue;
    if (hasTranslatableText(child)) return true;
  }
  return false;
}

/**
 * 把一个块内部序列化为带占位标记的纯文本。
 * 递归遍历子节点，按「子树里有没有可翻译文字」分流：
 *   - 有文字的元素（内联样式或 div/section 等容器）→ 保留属性壳，包成 <gN>...</gN> 再递归内部；
 *   - 无文字的子树（code/媒体、br/img、或只裹图片/图标的容器 wrapper）→ 单个 <xN/> 占位，
 *     原元素整体深克隆进 styleMap[n]，重建时原样贴回（保住其结构与 class，不破坏依赖它的 CSS）。
 */
function serializeBlock(root: Element, styleMap: Map<number, Element>): string {
  let counter = 0;
  const out: string[] = [];

  // 占位 + 深克隆原物：自闭合 <xN/>，重建时整段贴回。代码/媒体/无文字容器共用。
  const emitVoid = (el: Element) => {
    const n = counter++;
    styleMap.set(n, el.cloneNode(true) as Element);
    out.push(selfMarker(n));
  };

  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out.push(node.textContent ?? '');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.tagName;

    // aria-hidden 子树：装饰性 / 重复内容（最典型：标题的阴影副本——一份可见正文 + 一份
    // aria-hidden 的同字绝对定位副本）。整体当 <xN/> 深克隆原样保留，绝不送翻。
    // 踩坑：若把它和它所复制的可见文字一起送给模型，模型会"去重"只回一份、把另一份连标记带文字
    // 一起丢掉（省略标记能过 validateMarkers）。一旦丢的是 in-flow 那份、留下的是绝对定位副本，
    // 容器就没有了参与流式布局的内容，width:max-content 塌缩到≈0，中文随即逐字竖排并溢出。
    if (isAriaHidden(el)) {
      emitVoid(el);
      return;
    }
    // 代码 / SVG / 媒体：一律自闭合占位，原物深克隆进 styleMap，重建时整段贴回。
    if (SKIP_TAGS.has(tag)) {
      emitVoid(el);
      return;
    }
    // 无文字内联对象（br / img / hr / input / picture …）：同样自闭合深克隆。
    if (INLINE_VOID_TAGS.has(tag)) {
      emitVoid(el);
      return;
    }
    // 不含「可翻译文字」的子树（典型：只裹 logo 图片的 <div class="navbar__logo">）：
    // 整体按 <xN/> 深克隆保形，绝不拆开。拆开会丢掉这层 wrapper 的 class，依赖它的 CSS
    // （如 .navbar__logo img { height:100% }）随之失配，图片回退到自然尺寸而异常放大。
    // 用单个 <xN/> 也比「成对空壳 <gN></gN>」更稳：模型不会把一个独立占位删掉。
    if (!hasTranslatableText(el)) {
      emitVoid(el);
      return;
    }

    // 含可翻译文字的元素——内联样式（<a>/<strong>…）或容器（<div>/<section>…）一视同仁：
    // 保留「壳」（属性，清空 children）成对包裹，再递归处理内部文字。
    // 历史坑：早期非内联容器走「透明递归」被丢弃，重建后这层 wrapper 的 class 消失。
    const n = counter++;
    const shell = el.cloneNode(false) as Element;
    styleMap.set(n, shell);
    const [open, close] = pairMarker(n);
    out.push(open);
    for (const child of Array.from(el.childNodes)) visit(child);
    out.push(close);
  };

  for (const child of Array.from(root.childNodes)) visit(child);
  return collapseSpaces(out.join(''));
}

function collapseSpaces(s: string): string {
  // 多空白折叠为单空格，避免抽取出来一堆换行喂给模型浪费 token。
  return s.replace(/[\t\n\r ]+/g, ' ').replace(/ +([,.;:!?])/g, '$1').trim();
}
