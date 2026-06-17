// 轻量本地 token 估算：CJK 字符按 ~0.6 token/字，其余按 ~4 char/token。
// 照搬后端 server/app/core/tokens.py，用于 batchByTokenBudget 装箱。
//
// 双端一致性（金标向量）：必须与 Python 版逐数值对齐——
//  · CJK 字符类与 Python 同（基本/扩展 A、兼容表意、扩展 B）。
//  · 按「码点」计数，不按 UTF-16 码元：扩展 B（U+20000+）在 JS 里占 2 码元，Python str 按码点，
//    若用 String.length 会把这些字符各多算 1，破坏对齐。故用 [...text] 取码点。

// 等价于 Python 的 r"[㐀-鿿豈-﫿\U00020000-\U0002ffff]"，用纯 \u 码点区间避免字面字符歧义：
//   U+3400–U+9FFF（基本+扩展A）、U+F900–U+FBFF（兼容表意）、U+20000–U+2FFFF（扩展B）。
const CJK_RE = /[㐀-鿿豈-ﯿ\u{20000}-\u{2ffff}]/gu;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const total = [...text].length; // 码点数（对齐 Python len(str)）
  const cjk = (text.match(CJK_RE) ?? []).length;
  const other = total - cjk;
  return Math.ceil(cjk * 0.6 + other / 4);
}
