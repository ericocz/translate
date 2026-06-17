// 单测 BYOK 本地引擎的纯函数：estimateTokens / BlockSplitter（含容错）。
// 与 lib/local-engine/{estimate-tokens,block-splitter}.ts 实现保持一致（这里内联一份，node 直接跑）。
// 金标向量 test-vectors/local-engine.json 与后端 tests/test_golden_vectors.py 共读 → 双端逐值对齐。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(__dirname, 'test-vectors/local-engine.json'), 'utf8'));

// —— 内联：estimate-tokens.ts ——
const CJK_RE = /[㐀-鿿豈-ﯿ\u{20000}-\u{2ffff}]/gu;
function estimateTokens(text) {
  if (!text) return 0;
  const total = [...text].length;
  const cjk = (text.match(CJK_RE) ?? []).length;
  return Math.ceil(cjk * 0.6 + (total - cjk) / 4);
}

// —— 内联：block-splitter.ts ——
const MARKER_RE = /\[\[([A-Za-z0-9_.\-]+)\]\]/g;
function normalize(s) {
  return s
    .replace(/[［]/g, '[')
    .replace(/[］]/g, ']')
    .replace(/\[[ \t]+\[/g, '[[')
    .replace(/\][ \t]+\]/g, ']]');
}
class BlockSplitter {
  constructor(cb) {
    this.acc = '';
    this.cb = cb;
  }
  feed(c) {
    this.acc += c;
    this.process(false);
  }
  flush() {
    this.process(true);
  }
  process(flushAll) {
    this.acc = normalize(this.acc);
    const marks = [];
    MARKER_RE.lastIndex = 0;
    let m;
    while ((m = MARKER_RE.exec(this.acc)) !== null) {
      marks.push({ id: m[1], start: m.index, end: MARKER_RE.lastIndex });
    }
    if (!marks.length) return;
    const upto = flushAll ? marks.length : marks.length - 1;
    for (let i = 0; i < upto; i++) {
      const te = i + 1 < marks.length ? marks[i + 1].start : this.acc.length;
      this.cb(marks[i].id, this.acc.slice(marks[i].end, te).trim());
    }
    this.acc = flushAll ? '' : this.acc.slice(marks[marks.length - 1].start);
  }
}
function split(chunks) {
  const out = [];
  const bs = new BlockSplitter((i, t) => out.push([i, t]));
  for (const c of chunks) bs.feed(c);
  bs.flush();
  return out;
}

// —— 断言 ——
let pass = 0,
  fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got),
    w = JSON.stringify(want);
  if (g === w) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}\n       got:  ${g}\n       want: ${w}`);
  }
};

console.log('estimateTokens（金标向量，对齐后端）:');
for (const { text, expected } of vectors.tokens) {
  eq(`tokens(${JSON.stringify(text).slice(0, 24)})`, estimateTokens(text), expected);
}

console.log('BlockSplitter（金标向量，对齐后端）:');
for (const { name, chunks, expected } of vectors.blockSplit) {
  eq(name, split(chunks), expected);
}

console.log('BlockSplitter 容错增强（仅前端）:');
for (const { name, chunks, expected } of vectors.blockSplitFaultTolerance) {
  eq(name, split(chunks), expected);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
