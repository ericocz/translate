// BYOK 自带 key 的本地保险箱（§12-E）。
//
// 威胁模型：key 只在用户本机、永不上传（默认已是主要防线）。可选 PIN 加密再加一层「静态加密」，
// 防别人物理接触到设备时直接读 storage.local 拿到明文 key。非 E2E、非高强度——是「别人翻你硬盘
// 也看不到明文」级别的保护。
//
// 设计：
//  · 关 PIN：key 明文存在 ProviderConfig.apiKey 里（storage.local）。
//  · 开 PIN：apiKey 置空，密文（PBKDF2(pin)→AES-GCM）存 storage.local 的 byok_key_enc；
//    解锁时用 PIN 解密、把明文放进 chrome.storage.session（内存态、关浏览器即失，SW 可读）。
//    翻译在 SW 取明文：session 有 → 用；session 空（重启过）→ 报「需解锁」，popup 引导输入 PIN。

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = globalThis.crypto.subtle;

const ENC_KEY = 'byok_key_enc'; // storage.local：{ salt, iv, ct }（base64）
const SESSION_PLAIN = 'byok_key_plain'; // storage.session：解锁后的明文 key

const PBKDF2_ITERS = 200_000;

export interface EncryptedKey {
  salt: string;
  iv: string;
  ct: string;
}

function b64encode(buf: ArrayBuffer): string {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s);
}
function b64decode(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
// TextEncoder.encode 在当前 TS lib 下返回 Uint8Array<ArrayBufferLike>，Web Crypto 形参要 ArrayBuffer-backed；
// 拷进新 Uint8Array 即固定为 <ArrayBuffer>（与 lib/crypto.ts 同类规避）。
function utf8(s: string): Uint8Array<ArrayBuffer> {
  const u = enc.encode(s);
  const out = new Uint8Array(u.byteLength);
  out.set(u);
  return out;
}

async function deriveAesKey(pin: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const base = await subtle.importKey('raw', utf8(pin), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERS },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** 用 PIN 加密 key，返回密文三元组（存 storage.local）。 */
export async function encryptKey(plain: string, pin: string): Promise<EncryptedKey> {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const aes = await deriveAesKey(pin, salt);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, aes, utf8(plain));
  return { salt: b64encode(salt.buffer), iv: b64encode(iv.buffer), ct: b64encode(ct) };
}

/** 用 PIN 解密 key；PIN 错或密文损坏会抛错（GCM 校验失败）。 */
export async function decryptKey(blob: EncryptedKey, pin: string): Promise<string> {
  const salt = b64decode(blob.salt);
  const iv = b64decode(blob.iv);
  const aes = await deriveAesKey(pin, salt);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv }, aes, b64decode(blob.ct));
  return dec.decode(pt);
}

// —— 持久化 ——

export async function getEncryptedKey(): Promise<EncryptedKey | null> {
  const g = await chrome.storage.local.get(ENC_KEY);
  const v = g[ENC_KEY];
  return v && typeof v === 'object' ? (v as EncryptedKey) : null;
}

async function setEncryptedKey(blob: EncryptedKey | null): Promise<void> {
  if (blob) await chrome.storage.local.set({ [ENC_KEY]: blob });
  else await chrome.storage.local.remove(ENC_KEY);
}

/** 是否已开启 PIN 加密（存在密文即为开）。 */
export async function isPinProtected(): Promise<boolean> {
  return (await getEncryptedKey()) !== null;
}

/** 开启 PIN 保护：加密明文 key、存密文、清 session 旧明文（须重新解锁）。 */
export async function enablePin(plainKey: string, pin: string): Promise<void> {
  const blob = await encryptKey(plainKey, pin);
  await setEncryptedKey(blob);
  await chrome.storage.session.remove(SESSION_PLAIN);
}

/** 关闭 PIN 保护：删密文与 session 明文（调用方应把明文写回 config.apiKey）。 */
export async function disablePin(): Promise<void> {
  await setEncryptedKey(null);
  await chrome.storage.session.remove(SESSION_PLAIN);
}

/** 解锁：用 PIN 解密并把明文放进 session（内存态）。返回是否成功。 */
export async function unlock(pin: string): Promise<boolean> {
  const blob = await getEncryptedKey();
  if (!blob) return true; // 未加密：视为已解锁
  try {
    const plain = await decryptKey(blob, pin);
    await chrome.storage.session.set({ [SESSION_PLAIN]: plain });
    return true;
  } catch {
    return false; // PIN 错
  }
}

/** 清掉 session 里的明文（手动上锁 / 登出场景）。 */
export async function lock(): Promise<void> {
  await chrome.storage.session.remove(SESSION_PLAIN);
}

/** 取已解锁的明文 key（session）；未解锁返回 null。 */
export async function getUnlockedKey(): Promise<string | null> {
  const g = await chrome.storage.session.get(SESSION_PLAIN);
  const v = g[SESSION_PLAIN];
  return typeof v === 'string' ? v : null;
}
