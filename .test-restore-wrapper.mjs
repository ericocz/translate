// 单测 restoreSoleWrapper：模型整对省略「最外层唯一内联包装」时把壳补回。
// 与 lib/markers.ts 的实现保持一致（这里内联一份，node 直接跑）。

const SOLE_WRAPPER_RE = /^\s*((?:<x\d+\/>\s*)*)<g(\d+)>([\s\S]*)<\/g\2>\s*((?:<x\d+\/>\s*)*)\s*$/;
const LEADING_VOIDS_RE = /^\s*((?:<x\d+\/>\s*)*)/;
const TRAILING_VOIDS_RE = /((?:\s*<x\d+\/>)*\s*)$/;

function restoreSoleWrapper(translated, source) {
  const m = SOLE_WRAPPER_RE.exec(source);
  if (!m) return translated;
  const wrapperId = m[2];
  if (new RegExp(`<g${wrapperId}>`).test(translated)) return translated;
  const lead = (LEADING_VOIDS_RE.exec(translated) ?? ['', ''])[1] ?? '';
  const afterLead = translated.slice(lead.length);
  const trail = (TRAILING_VOIDS_RE.exec(afterLead) ?? ['', ''])[1] ?? '';
  const mid = afterLead.slice(0, afterLead.length - trail.length);
  if (mid.trim().length === 0) return translated;
  return `${lead}<g${wrapperId}>${mid}</g${wrapperId}>${trail}`;
}

// 词法（与 markers.ts tokenizeMarkers 同义）——用来证明：修复前没有 open token（rebuild 不建 <a>），修复后有。
const MARKER_RE = /<(\/?)([gx])(\d+)(\/?)>/g;
function hasOpen(s) {
  MARKER_RE.lastIndex = 0;
  let m;
  while ((m = MARKER_RE.exec(s)) !== null) {
    if (m[2] === 'g' && m[1] === '' && m[4] === '') return true;
  }
  return false;
}

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (got === want) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got:  ${got}\n       want: ${want}`); }
}
function truthy(name, got) {
  if (got) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name} (expected truthy, got ${got})`); }
}

// 1) 真实 bug 复现：超链接块，模型保留前导 favicon 占位、省略整对 <g1>。
{
  const source = '<x0/><g1>What would a player gain from giving his/her opponent an extra piece?</g1>';
  const modelOut = '<x0/>玩家把额外一枚棋子让给对手能获得什么好处呢？';
  // 修复前：没有 open token → rebuild 不会建 <a> → 文字落进 nowrap 的 li → 溢出
  eq('bug 复现：修复前无 open token', String(hasOpen(modelOut)), 'false');
  const fixed = restoreSoleWrapper(modelOut, source);
  eq('修复后补回 <g1> 壳', fixed, '<x0/><g1>玩家把额外一枚棋子让给对手能获得什么好处呢？</g1>');
  truthy('修复后有 open token（rebuild 会建 <a>）', hasOpen(fixed));
}

// 2) 模型正常保留包装 → 不改动
{
  const source = '<x0/><g1>Hello world</g1>';
  const modelOut = '<x0/><g1>你好世界</g1>';
  eq('已含包装不改动', restoreSoleWrapper(modelOut, source), modelOut);
}

// 3) 无前导占位的纯超链接块
{
  const source = '<g0>Click here</g0>';
  eq('无前导占位也能补', restoreSoleWrapper('点击这里', source), '<g0>点击这里</g0>');
}

// 4) 并列多包装（非单一最外层）→ 绝不误裹
{
  const source = '<g0>foo</g0> <g1>bar</g1>';
  eq('并列多包装不动', restoreSoleWrapper('甲 乙', source), '甲 乙');
}

// 5) 嵌套：外层被省、内层保留 → 补回外层
{
  const source = '<g0>a <g1>b</g1> c</g0>';
  eq('嵌套补回外层', restoreSoleWrapper('甲 <g1>乙</g1> 丙', source), '<g0>甲 <g1>乙</g1> 丙</g0>');
}

// 6) 纯文本块（无标记）→ 不动
{
  eq('纯文本不动', restoreSoleWrapper('你好', 'Hello'), '你好');
}

// 7) 译文只剩占位、无文字 → 放弃（不产生空 <gN></gN>）
{
  const source = '<x0/><g1>x</g1>';
  eq('纯占位放弃', restoreSoleWrapper('<x0/>', source), '<x0/>');
}

// 8) 尾随占位也保位
{
  const source = '<g0>word</g0><x1/>';
  eq('尾随占位保位', restoreSoleWrapper('词<x1/>', source), '<g0>词</g0><x1/>');
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
