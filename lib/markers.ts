// 占位标记协议：<gN>...</gN> 成对；<xN/> 自闭合。
//
// 抽取时：内联样式元素（<a>/<strong>/<em> 等）→ 成对标记；
// 无文字内联对象（<br>/<img>/被跳过的代码块 等）→ 自闭合标记。
//
// 整套标记语法只在本文件定义一次（tokenizeMarkers）：validateMarkers 与 rebuilder 都基于它。
// 历史教训：曾经校验器用一组正则、重建器用另一组，导致 <gN/> 这类畸形被校验放过、却被
// 重建器当成自闭合注入空壳而丢字。统一词法后这种不一致从根上消除。

/** 译文切分出的 token。 */
export type MarkerToken =
  | { type: 'text'; text: string }
  | { type: 'open'; n: number } // <gN>
  | { type: 'close'; n: number } // </gN>
  | { type: 'void'; n: number }; // <xN/>

// 唯一的标记词法：< (前导 /?) (g|x) (数字) (后随 /?) >
const MARKER_RE = /<(\/?)([gx])(\d+)(\/?)>/g;
// 形似标记但夹了空格 / 大小写不规范的写法（模型偶发）——用来兜底拒绝，避免漏到页面上。
const LOOSE_MARKER_RE = /<\s*\/?\s*[gx]\s*\d+\s*\/?\s*>/i;

/**
 * 把译文切成 token 序列。
 * 只有四种合法标记形态：开 <gN>、闭 </gN>、自闭 <xN/>、以及普通文本。
 * 任一标记落在合法形态之外（如 <gN/> 把成对标记自闭了、<xN> 未自闭、</xN> 关闭了自闭标记）
 * 即判定整块词法非法，返回 null。
 */
export function tokenizeMarkers(s: string): MarkerToken[] | null {
  const tokens: MarkerToken[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  MARKER_RE.lastIndex = 0;
  while ((m = MARKER_RE.exec(s)) !== null) {
    if (m.index > last) tokens.push({ type: 'text', text: s.slice(last, m.index) });
    const [, lead, kind, numStr, trail] = m;
    const n = Number(numStr);
    if (kind === 'g' && lead === '' && trail === '') tokens.push({ type: 'open', n });
    else if (kind === 'g' && lead === '/' && trail === '') tokens.push({ type: 'close', n });
    else if (kind === 'x' && lead === '' && trail === '/') tokens.push({ type: 'void', n });
    else return null; // <gN/> / <xN> / </xN> / </gN/> 等畸形组合
    last = MARKER_RE.lastIndex;
  }
  if (last < s.length) tokens.push({ type: 'text', text: s.slice(last) });
  // 残留"形似标记"的文本说明模型把标记写坏了（如 < g0 >）——拒绝，绝不展示半成品。
  for (const t of tokens) {
    if (t.type === 'text' && LOOSE_MARKER_RE.test(t.text)) return null;
  }
  return tokens;
}

export interface ValidateResult {
  ok: boolean;
  /** 失败原因（仅在 ok=false 时有意义）。 */
  reason?: string;
}

/**
 * 校验译文标记。规则：
 *  - 词法合法（见 tokenizeMarkers）。
 *  - 成对标记严格 LIFO 配对：允许移动、可嵌套，但不得交叉、不得提前关闭。
 *  - 所有出现的编号都必须在 allowedIds 内（不得凭空新增）。
 *  - 自闭合标记不得重复（同一个无文字对象不应被复制）。
 *  - 不强求 allowedIds 全部出现：模型省略某个无意义的内联包装是允许的。
 */
export function validateMarkers(translated: string, allowedIds: ReadonlySet<number>): ValidateResult {
  const tokens = tokenizeMarkers(translated);
  if (tokens === null) return { ok: false, reason: '标记词法非法（畸形或含空格的标记）' };

  const stack: number[] = [];
  const voidSeen = new Set<number>();
  for (const t of tokens) {
    if (t.type === 'text') continue;
    if (!allowedIds.has(t.n)) return { ok: false, reason: `未知标记编号 ${t.n}` };
    if (t.type === 'open') {
      stack.push(t.n);
    } else if (t.type === 'close') {
      const top = stack.pop();
      if (top !== t.n) {
        return { ok: false, reason: `成对标记交叉或未匹配：期望关闭 g${top}，遇到 </g${t.n}>` };
      }
    } else {
      if (voidSeen.has(t.n)) return { ok: false, reason: `自闭合标记 x${t.n} 重复出现` };
      voidSeen.add(t.n);
    }
  }
  if (stack.length > 0) {
    return { ok: false, reason: `未关闭的成对标记：${stack.map((n) => `g${n}`).join(',')}` };
  }
  return { ok: true };
}

// —— 抽取阶段：序列化原始内联元素为占位标记 ——

/** 成对标记的开 / 闭字符串。 */
export function pairMarker(n: number): [open: string, close: string] {
  return [`<g${n}>`, `</g${n}>`];
}

/** 自闭合标记字符串。 */
export function selfMarker(n: number): string {
  return `<x${n}/>`;
}

/**
 * 从块的 source 反推出现过的标记编号集合。
 * background 端没有 styleMap，但 source 里的标记编号与 content 端 styleMap.keys()
 * 一一对应——据此可在缓存前做与 content 等价的标记校验，只缓存合法译文。
 */
export function allowedIdsFromSource(source: string): Set<number> {
  const ids = new Set<number>();
  MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER_RE.exec(source)) !== null) ids.add(Number(m[3]));
  return ids;
}
