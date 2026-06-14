// 单测本地缓存纯逻辑：selectEvictions（LRU+TTL 逐出决策）+ partitionByCache（命中拆分）。
// 镜像 lib/local-cache.ts / lib/translate-cached.ts 的纯函数，改源码请同步这里。

function selectEvictions(entries, opts) {
  let bytes = entries.reduce((s, e) => s + e.size, 0);
  let count = entries.length;
  const out = [];
  for (const e of entries) {
    const stale = e.used < opts.now - opts.ttlMs;
    if (stale || bytes > opts.maxBytes || count > opts.maxEntries) {
      out.push(e.key);
      bytes -= e.size;
      count -= 1;
    } else break;
  }
  return out;
}

function partitionByCache(blocks, hits) {
  const hitBlocks = [];
  const misses = [];
  for (const b of blocks) {
    const t = hits.get(b.source);
    if (t !== undefined) hitBlocks.push({ id: b.id, translated: t });
    else misses.push(b);
  }
  return { hitBlocks, misses };
}

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.log('  FAIL ' + name); } };
const NOW = 1_000_000_000_000;
const TTL = 90 * 24 * 60 * 60 * 1000;
// used 升序的条目工厂
const e = (key, used, size = 10) => ({ key, translated: 't', size, created: used, used });

// selectEvictions
t('达标不逐出', selectEvictions([e('a', NOW), e('b', NOW)], { maxBytes: 1000, maxEntries: 100, ttlMs: TTL, now: NOW }).length === 0);
t('超条数逐最旧', JSON.stringify(
  selectEvictions([e('a', NOW - 3), e('b', NOW - 2), e('c', NOW - 1)], { maxBytes: 1e9, maxEntries: 2, ttlMs: TTL, now: NOW })
) === JSON.stringify(['a']));
t('超字节逐最旧', JSON.stringify(
  selectEvictions([e('a', NOW - 2, 100), e('b', NOW - 1, 100)], { maxBytes: 150, maxEntries: 1e9, ttlMs: TTL, now: NOW })
) === JSON.stringify(['a']));
t('过期即删（即便达标）', JSON.stringify(
  selectEvictions([e('old', NOW - TTL - 1), e('new', NOW)], { maxBytes: 1e9, maxEntries: 1e9, ttlMs: TTL, now: NOW })
) === JSON.stringify(['old']));
t('升序遇达标且不过期即停', selectEvictions(
  [e('a', NOW - 5, 100), e('b', NOW, 100)], { maxBytes: 150, maxEntries: 1e9, ttlMs: TTL, now: NOW }
).length === 1);

// partitionByCache
const hits = new Map([['Hello', '你好']]);
const blocks = [
  { id: 'b1', source: 'Hello' },
  { id: 'b2', source: 'World' },
  { id: 'b3', source: 'Hello' }, // 同 source 重复块也命中
];
const p = partitionByCache(blocks, hits);
t('命中块拆出', p.hitBlocks.length === 2 && p.hitBlocks.every((h) => h.translated === '你好'));
t('未命中块保留', p.misses.length === 1 && p.misses[0].id === 'b2');
t('全命中无 miss', partitionByCache([{ id: 'x', source: 'Hello' }], hits).misses.length === 0);
t('全未命中无 hit', partitionByCache([{ id: 'x', source: 'Nope' }], hits).hitBlocks.length === 0);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
