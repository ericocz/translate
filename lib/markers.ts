// 占位标记协议：<gN>...</gN> 成对；<xN/> 自闭合。
//
// 抽取时：内联样式元素（<a>/<strong>/<em>/<code> 等）被转成成对标记，
// 无文字内联对象（<br>/<img>/<input> 等）转成自闭合。
// 校验时：标记必须平衡、编号合法、与原 styleMap 一一对应；
// 任何不通过都判定为整块失败，保持英文原文，绝不展示半成品。

const PAIR_TAG_RE = /<\/?g(\d+)>/g;
const SELF_TAG_RE = /<x(\d+)\/>/g;

export interface ValidateResult {
  ok: boolean;
  /** 失败原因（仅在 ok=false 时有意义）。 */
  reason?: string;
}

/**
 * 校验译文里的标记。
 * 规则：
 *  - 所有出现过的 gN 必须严格 LIFO 配对（允许移动、可嵌套，但不能交叉）。
 *  - 所有出现过的编号都必须在 styleMap 中存在。
 *  - 不允许出现 styleMap 之外的新编号。
 *  - styleMap 中的编号是否必须全部出现？——不强求：模型若决定省略某个无意义的内联包装是允许的；
 *    但绝大多数情况下模型会保留。这里只做"不多不错"。
 */
export function validateMarkers(translated: string, allowedIds: ReadonlySet<number>): ValidateResult {
  // 用栈做 LIFO 匹配；记录出现过的编号用来交叉对照 allowedIds。
  const stack: number[] = [];
  const seen = new Set<number>();
  let m: RegExpExecArray | null;

  // 先扫描成对标记。
  PAIR_TAG_RE.lastIndex = 0;
  while ((m = PAIR_TAG_RE.exec(translated)) !== null) {
    const isClose = m[0].startsWith('</');
    const n = Number(m[1]);
    if (!allowedIds.has(n)) {
      return { ok: false, reason: `未知的成对标记编号 g${n}` };
    }
    seen.add(n);
    if (isClose) {
      const top = stack.pop();
      if (top !== n) {
        return { ok: false, reason: `成对标记交叉或未匹配：期望关闭 g${top}，遇到 </g${n}>` };
      }
    } else {
      stack.push(n);
    }
  }
  if (stack.length > 0) {
    return { ok: false, reason: `未关闭的成对标记：${stack.map((n) => `g${n}`).join(',')}` };
  }

  // 自闭合标记：只校验编号合法、出现次数 ≤ 1（同一个无文字对象不应被复制）。
  SELF_TAG_RE.lastIndex = 0;
  const selfSeen = new Set<number>();
  while ((m = SELF_TAG_RE.exec(translated)) !== null) {
    const n = Number(m[1]);
    if (!allowedIds.has(n)) {
      return { ok: false, reason: `未知的自闭合标记编号 x${n}` };
    }
    if (selfSeen.has(n)) {
      return { ok: false, reason: `自闭合标记 x${n} 重复出现` };
    }
    selfSeen.add(n);
    seen.add(n);
  }

  // 防御：不应残留疑似的 < g 或 < x 写法（模型偶尔会加空格）。
  if (/<\s*\/?\s*[gx]\s*\d+\s*\/?>/i.test(translated) && !/<\/?g\d+>|<x\d+\/>/.test(translated)) {
    return { ok: false, reason: '标记格式有空格或大小写不一致' };
  }
  void seen;
  return { ok: true };
}

/**
 * 抽取阶段：序列化原始内联元素为占位标记。
 * - tagSeq：闭包计数器，调用者保证同块内单调递增。
 * - styleMap：编号 → 元素（克隆，避免后续 DOM 改动污染）。
 */
export function nextPairMarker(n: number): [open: string, close: string] {
  return [`<g${n}>`, `</g${n}>`];
}

export function selfMarker(n: number): string {
  return `<x${n}/>`;
}

/**
 * 从块的 source 里反推出现过的标记编号集合。
 * background 端没有 styleMap，但 source 里的 <gN>/<xN/> 编号与 content 端 styleMap.keys()
 * 一一对应——据此可在缓存前做与 content 等价的标记校验，只缓存合法译文。
 */
export function allowedIdsFromSource(source: string): Set<number> {
  const ids = new Set<number>();
  const re = /<\/?[gx](\d+)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    ids.add(Number(m[1]));
  }
  return ids;
}
