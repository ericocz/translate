// 单测 createSseParser：SSE 事件常被网络切成多个 chunk（event:/data: 行、空行分隔）。
// 与 lib/sse.ts 实现保持一致（这里内联一份，node 直接跑）。
function createSseParser(onEvent) {
  let buf = '';
  const emit = (raw) => {
    let event = 'message';
    const dataLines = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (dataLines.length) onEvent({ event, data: dataLines.join('\n') });
  };
  return {
    feed(chunk) {
      buf += chunk;
      let sep;
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        emit(buf.slice(0, sep));
        buf = buf.slice(sep + 2);
      }
    },
    flush() { if (buf.trim()) { emit(buf); buf = ''; } },
  };
}

let pass = 0, fail = 0;
const collect = (chunks) => {
  const out = [];
  const p = createSseParser((e) => out.push(e));
  for (const c of chunks) p.feed(c);
  p.flush();
  return out;
};
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got:  ${g}\n       want: ${w}`); }
};

// 1) 一个完整事件
eq('单事件', collect(['event: block\ndata: {"id":"b1","translated":"你好"}\n\n']),
  [{ event: 'block', data: '{"id":"b1","translated":"你好"}' }]);

// 2) 事件被切成多个 chunk（关键：跨 chunk 缓冲重扫）
eq('跨 chunk 拼接', collect(['event: bl', 'ock\nda', 'ta: {"id":"b1"}', '\n\n']),
  [{ event: 'block', data: '{"id":"b1"}' }]);

// 3) 多事件连续 + done
eq('多事件 + done', collect(['event: block\ndata: {"id":"b1"}\n\nevent: done\ndata: {}\n\n']),
  [{ event: 'block', data: '{"id":"b1"}' }, { event: 'done', data: '{}' }]);

// 4) 末尾无空行靠 flush 收尾
eq('flush 收尾', collect(['event: done\ndata: {}']),
  [{ event: 'done', data: '{}' }]);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
