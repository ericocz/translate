// 真实 Web Crypto（Node ≥18 globalThis.crypto.subtle）。验：① ECDH+HKDF 两方派生一致 ②AES-GCM 往返
// ③ Python(crypto.py) 产出的金标向量 JS 能解密（跨语言互通）。改规格请同步 crypto.ts / crypto.py。

// 金标向量：server/app/core/crypto.py 用 key=bytes(range(32)) 加密产出（plan Task3 Step4）。
const GOLDEN = {
  keyB64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
  box: 'q04yQGRGyloPyxmKzBg+QGz6HtcfVXxwww4rjjwB9lJIG4ESXR1MN8Re3x8nny6PaNfBiKY=',
  aad: 'dst:b1',
  plaintext: 'Hello <g0>世界</g0> ✓',
};

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const SALT = enc.encode('imt-d13'), INFO = enc.encode('session-key');
const b64e = (buf) => Buffer.from(new Uint8Array(buf)).toString('base64');
const b64d = (s) => new Uint8Array(Buffer.from(s, 'base64'));

async function deriveKey(privKey, pubKey) {
  const bits = await subtle.deriveBits({ name: 'ECDH', public: pubKey }, privKey, 256);
  const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: SALT, info: INFO },
    hk, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
  );
}
async function encryptField(key, pt, aad) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, enc.encode(pt));
  const out = new Uint8Array(12 + ct.byteLength); out.set(iv, 0); out.set(new Uint8Array(ct), 12);
  return b64e(out.buffer);
}
async function decryptField(key, box, aad) {
  const raw = b64d(box);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: enc.encode(aad) }, key, raw.slice(12));
  return new TextDecoder().decode(pt);
}

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log('  ok  ' + n); } else { fail++; console.log('  FAIL ' + n); } };

const run = async () => {
  // ① ECDH 两方派生一致：a/b 两对密钥互用对方公钥 → 同 AES 密钥（导出 raw 比较）
  const a = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const b = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const ka = await deriveKey(a.privateKey, b.publicKey);
  const kb = await deriveKey(b.privateKey, a.publicKey);
  t('ECDH+HKDF 两方派生一致', b64e(await subtle.exportKey('raw', ka)) === b64e(await subtle.exportKey('raw', kb)));

  // ② AES-GCM 往返 + AAD 绑定
  const box = await encryptField(ka, 'Hello <g0>世界</g0>', 'dst:b1');
  t('AES-GCM 往返', (await decryptField(ka, box, 'dst:b1')) === 'Hello <g0>世界</g0>');
  let threw = false; try { await decryptField(ka, box, 'src:b1'); } catch { threw = true; }
  t('AAD 不符解密失败', threw);

  // ③ 金标向量（Python 产出）：JS 解密得原文 → 跨语言互通
  const gk = await subtle.importKey('raw', b64d(GOLDEN.keyB64), { name: 'AES-GCM' }, false, ['decrypt']);
  t('金标向量跨语言解密', (await decryptField(gk, GOLDEN.box, GOLDEN.aad)) === GOLDEN.plaintext);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
};
run();
