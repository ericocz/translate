// 单测 pageKeyFromUrl：规范化（去 #fragment，保留 query）+ cyrb53 哈希。
// 与 lib/device.ts 内联保持一致（node 直接跑）。
function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
function pageKeyFromUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return cyrb53(u.origin + u.pathname + u.search);
  } catch {
    return cyrb53(url);
  }
}

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.log('  FAIL ' + name); } };

// 1) 去掉 #fragment：同页不同锚点 → 同 key
t('fragment 不影响', pageKeyFromUrl('https://x.com/a?b=1#sec1') === pageKeyFromUrl('https://x.com/a?b=1#sec2'));
// 2) query 参与身份：不同 query → 不同 key
t('query 区分', pageKeyFromUrl('https://x.com/a?b=1') !== pageKeyFromUrl('https://x.com/a?b=2'));
// 3) 路径区分
t('path 区分', pageKeyFromUrl('https://x.com/a') !== pageKeyFromUrl('https://x.com/b'));
// 4) 稳定
t('稳定', pageKeyFromUrl('https://x.com/a') === pageKeyFromUrl('https://x.com/a'));
// 5) 空/坏 URL 不抛
t('空 URL', pageKeyFromUrl('') === '');
t('坏 URL 兜底', typeof pageKeyFromUrl('not a url') === 'string');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
