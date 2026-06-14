// 应用层加密（D-13）：ECDH(P-256)+HKDF-SHA256→AES-256-GCM。钉死服务端公钥，每会话临时密钥。
// 只在构建注入了 SERVER_PUBKEY 时启用（生产）；dev 无公钥＝明文路径。原生 Web Crypto，不引库。
// 跨语言规格见 docs/.../2026-06-14-d13-app-layer-encryption.md（与 server/app/core/crypto.py 逐字节一致）。
import { SERVER_PUBKEY } from './config';

const enc = new TextEncoder();
const HKDF_SALT = enc.encode('imt-d13');
const HKDF_INFO = enc.encode('session-key');
const subtle = globalThis.crypto.subtle;

export function encryptionEnabled(): boolean {
  return SERVER_PUBKEY.length > 0;
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

interface Session {
  ephPubB64: string;
  aesKey: CryptoKey;
}
let sessionPromise: Promise<Session> | null = null;

async function getSession(): Promise<Session> {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    const serverPub = await subtle.importKey(
      'raw',
      b64decode(SERVER_PUBKEY),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );
    const eph = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const bits = await subtle.deriveBits({ name: 'ECDH', public: serverPub }, eph.privateKey, 256);
    const hkdfKey = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    const aesKey = await subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: HKDF_INFO },
      hkdfKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    const ephRaw = await subtle.exportKey('raw', eph.publicKey);
    return { ephPubB64: b64encode(ephRaw), aesKey };
  })();
  return sessionPromise;
}

/** 客户端临时公钥（放 X-Eph-Pub 头，让服务端派生同一密钥）。 */
export async function ephemeralPublicKey(): Promise<string> {
  return (await getSession()).ephPubB64;
}

export async function encryptField(plaintext: string, aad: string): Promise<string> {
  const { aesKey } = await getSession();
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(aad) },
    aesKey,
    enc.encode(plaintext)
  );
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return b64encode(out.buffer);
}

export async function decryptField(payloadB64: string, aad: string): Promise<string> {
  const { aesKey } = await getSession();
  const raw = b64decode(payloadB64);
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: enc.encode(aad) },
    aesKey,
    raw.slice(12)
  );
  return new TextDecoder().decode(pt);
}
