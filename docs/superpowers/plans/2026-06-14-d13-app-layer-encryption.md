# D-13 应用层加密（原文/译文）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 TLS 之上对**原文 source / 译文 translated** 做应用层加密，目标＝防传输劫持 / TLS 终止代理 / CDN 日志泄漏。**非对我方 E2E**（服务端解密发模型、加密译文回传）。机制：**ECDH(P-256) + HKDF-SHA256 → AES-256-GCM**，服务端静态公钥**钉死在扩展构建**，客户端每会话发临时公钥，服务端**无状态重新派生**会话密钥。

**Architecture:** 加密边界只在 `front/lib/api.ts`（请求前加密 source、SSE 每块解密 translated）+ 服务端 `/v1/translate`。**只加密叶子字段**：`id`/`pageKey`(已是哈希)/`deviceId`/`localDate`/SSE `event:`/`done`/`quota` 信封全留明文 → **SSE 流式与 `<gN>` 标记校验两端都不动**（服务端在明文上校验/计数后再加密；客户端解密后再校验/重建）。缓存层（D-11b `translate-cached.ts`）与 `content.ts` 继续在**明文**域工作（缓存键＝明文 source，onBlock 收到明文）——加密对它们透明。**门控**：客户端注入了 `WXT_SERVER_PUBKEY` 才加密（生产），dev 无公钥＝明文路径；服务端见 `X-Eph-Pub` 头才走解密路径，否则明文路径（现有测试不带头 → 不受影响）。加密客户端永远发密文 `ct`、不发明文 source，攻击者剥头只会让请求**失败关闭**（无降级泄漏）。

**Tech Stack:** 客户端原生 **Web Crypto**（`crypto.subtle`，SW/Node 均有，**不引第三方库**）；服务端 **`cryptography`**（新依赖）+ FastAPI；pytest（真实 crypto 往返 + ECDH 一致 + 篡改失败 + 端点加密路径）；node `.test-crypto.mjs`（真实 subtle 往返 + ECDH 一致 + **Python 产出的金标向量** 验跨语言互通）。

**Decision source:** 产品蓝图 V2 §D-13（`产品蓝图V2-商业化.html:262`）+ 2026-06-14 用户拍板「ECDH + 公钥钉死」。

**跨语言加密规格（两端必须逐字节一致）：**
- 曲线 **P-256 (secp256r1)**。公钥线格式＝**未压缩点 65 字节**（`0x04‖X‖Y`）的 base64（Web Crypto `exportKey('raw')` / Python `X962 UncompressedPoint` 同形）。
- ECDH 共享密钥＝X 坐标 32 字节（两端一致）。**HKDF-SHA256**：`salt=b"imt-d13"`、`info=b"session-key"`、输出 32 字节。
- **AES-256-GCM**：每条消息随机 **12 字节 IV**；线格式＝`base64( iv(12) ‖ ciphertext‖tag )`（GCM 输出已含 16 字节 tag）。
- **AAD**（防字段/跨 id 调包）：请求原文＝`"src:"+id`；响应译文＝`"dst:"+id`。UTF-8 编码；明文 UTF-8。

---

## File Structure

- `server/app/core/crypto.py` — **新增**：`load_private_key` / `public_key_b64` / `derive_key` / `encrypt` / `decrypt` / `gen_private_key_b64`。
- `server/app/core/config.py` — 加 `session_private_key: str = ""`。
- `server/pyproject.toml` — 加依赖 `cryptography`。
- `server/scripts/gen_session_keypair.py` — **新增**：生成密钥对，打印 `.env` 私钥 + 扩展 `WXT_SERVER_PUBKEY` 公钥。
- `server/app/routers/translate.py` — `BlockIn` 加 `ct`；端点按 `X-Eph-Pub` 解密 source / 加密 translated。
- `server/tests/test_crypto.py` — **新增**。
- `server/tests/test_translate_endpoint.py` — 加加密路径用例。
- `front/lib/crypto.ts` — **新增**：会话级 ECDH + AES-GCM（`encryptionEnabled` / `ephemeralPublicKey` / `encryptField` / `decryptField`）。
- `front/lib/config.ts` — 加 `SERVER_PUBKEY`。
- `front/.env.example` — 加 `WXT_SERVER_PUBKEY`。
- `front/lib/api.ts` — 请求加密 source + 头 `X-Eph-Pub`；SSE 解密 translated（门控）。
- `front/.test-crypto.mjs` — **新增**。
- `server/CLAUDE.md` / `front/CLAUDE.md` — 同步。

---

### Task 1: 服务端加密核心 `crypto.py` + 依赖 + 配置 + keygen

**Files:** Create `server/app/core/crypto.py`, `server/scripts/gen_session_keypair.py`, `server/tests/test_crypto.py`; Modify `server/pyproject.toml`, `server/app/core/config.py`.

- [ ] **Step 1: 加依赖**

Run: `cd server && env -u ALL_PROXY -u all_proxy -u HTTP_PROXY -u http_proxy -u HTTPS_PROXY -u https_proxy uv add cryptography`
Expected: `cryptography` 进 `pyproject.toml` + 锁定。

- [ ] **Step 2: 写 `app/core/crypto.py`**

```python
"""应用层加密（D-13）：ECDH(P-256) + HKDF-SHA256 → AES-256-GCM。
服务端静态私钥在 env；客户端钉死服务端公钥、每会话发临时公钥，服务端无状态重新派生会话密钥。
非 E2E：服务端解密原文发模型、加密译文回客户端。只加密叶子字段，SSE 信封/标记校验不动。
跨语言规格见 docs/.../2026-06-14-d13-app-layer-encryption.md（两端逐字节一致）。
"""
from __future__ import annotations

import base64
import os

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

_CURVE = ec.SECP256R1()
_HKDF_SALT = b"imt-d13"
_HKDF_INFO = b"session-key"


def load_private_key(b64_raw: str) -> ec.EllipticCurvePrivateKey:
    """从 base64(原始标量 d，32 字节) 还原 P-256 私钥。"""
    d = int.from_bytes(base64.b64decode(b64_raw), "big")
    return ec.derive_private_key(d, _CURVE)


def public_key_b64(priv: ec.EllipticCurvePrivateKey) -> str:
    """导出公钥为 base64(未压缩点 65 字节)——与 Web Crypto exportKey('raw') 同形。"""
    raw = priv.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    return base64.b64encode(raw).decode()


def derive_key(priv: ec.EllipticCurvePrivateKey, client_eph_pub_b64: str) -> bytes:
    """ECDH(server_priv, client_eph_pub) → HKDF-SHA256 → 32 字节 AES 密钥。
    from_encoded_point 会校验点在曲线上（拒绝无效曲线攻击）。"""
    raw = base64.b64decode(client_eph_pub_b64)
    peer = ec.EllipticCurvePublicKey.from_encoded_point(_CURVE, raw)
    shared = priv.exchange(ec.ECDH(), peer)  # X 坐标 32 字节
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=_HKDF_SALT, info=_HKDF_INFO).derive(shared)


def encrypt(key: bytes, plaintext: str, aad: str) -> str:
    """AES-256-GCM → base64(iv(12) ‖ ct‖tag)。"""
    iv = os.urandom(12)
    ct = AESGCM(key).encrypt(iv, plaintext.encode(), aad.encode())
    return base64.b64encode(iv + ct).decode()


def decrypt(key: bytes, payload_b64: str, aad: str) -> str:
    raw = base64.b64decode(payload_b64)
    iv, ct = raw[:12], raw[12:]
    return AESGCM(key).decrypt(iv, ct, aad.encode()).decode()


def gen_private_key_b64() -> str:
    """生成新私钥，返回 base64(原始标量 32 字节)。"""
    priv = ec.generate_private_key(_CURVE)
    return base64.b64encode(priv.private_numbers().private_value.to_bytes(32, "big")).decode()
```

- [ ] **Step 3: 配置 + keygen 脚本**

`server/app/core/config.py` 的 Settings 加一行（与其它 env 字段并列）：
```python
    session_private_key: str = ""  # D-13 应用层加密静态私钥 base64(原始标量)；空＝明文路径（dev）
```

`server/scripts/gen_session_keypair.py`：
```python
"""生成 D-13 会话加密静态密钥对。私钥进 server/.env，公钥进扩展构建 env（公钥可公开）。"""
from app.core.crypto import gen_private_key_b64, load_private_key, public_key_b64

priv_b64 = gen_private_key_b64()
priv = load_private_key(priv_b64)
print("# server/.env")
print(f"SESSION_PRIVATE_KEY={priv_b64}")
print()
print("# front/.env  (WXT 构建期注入；公钥可公开)")
print(f"WXT_SERVER_PUBKEY={public_key_b64(priv)}")
```

- [ ] **Step 4: 写 `tests/test_crypto.py`（真实 crypto）**

```python
from app.core import crypto
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization
import base64
import pytest


def _client_eph():
    """模拟客户端临时密钥对，返回 (派生用对端公钥 b64, 用服务端公钥派生同一密钥的函数)。"""
    eph = ec.generate_private_key(ec.SECP256R1())
    pub_b64 = base64.b64encode(
        eph.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    ).decode()
    return eph, pub_b64


def test_ecdh_both_sides_agree():
    server_priv = crypto.load_private_key(crypto.gen_private_key_b64())
    eph, eph_pub_b64 = _client_eph()
    # 服务端：用自己私钥 + 客户端临时公钥
    k_server = crypto.derive_key(server_priv, eph_pub_b64)
    # 客户端侧：用临时私钥 + 服务端公钥（同一共享密钥 → 同一 HKDF 输出）
    server_pub_raw = base64.b64decode(crypto.public_key_b64(server_priv))
    server_pub = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), server_pub_raw)
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    from cryptography.hazmat.primitives import hashes
    shared = eph.exchange(ec.ECDH(), server_pub)
    k_client = HKDF(algorithm=hashes.SHA256(), length=32, salt=b"imt-d13", info=b"session-key").derive(shared)
    assert k_server == k_client


def test_roundtrip_with_aad():
    key = bytes(range(32))
    box = crypto.encrypt(key, "Hello <g0>世界</g0>", "dst:b1")
    assert crypto.decrypt(key, box, "dst:b1") == "Hello <g0>世界</g0>"


def test_wrong_aad_fails():
    key = bytes(range(32))
    box = crypto.encrypt(key, "x", "src:b1")
    with pytest.raises(Exception):
        crypto.decrypt(key, box, "dst:b1")


def test_tampered_ciphertext_fails():
    key = bytes(range(32))
    box = crypto.encrypt(key, "x", "src:b1")
    raw = bytearray(base64.b64decode(box))
    raw[-1] ^= 0x01
    with pytest.raises(Exception):
        crypto.decrypt(key, base64.b64encode(bytes(raw)).decode(), "src:b1")
```

- [ ] **Step 5: 跑测试**

Run: `cd server && uv run pytest tests/test_crypto.py -v`
Expected: 4 PASS。

- [ ] **Step 6: Commit**
```bash
cd server && git add pyproject.toml uv.lock app/core/crypto.py app/core/config.py scripts/gen_session_keypair.py tests/test_crypto.py
git commit -m "feat(crypto): ECDH+HKDF+AES-GCM 加密核心 + 配置 + keygen（D-13）"
```

---

### Task 2: 端点解密 source / 加密 translated（按头自动门控）

**Files:** Modify `server/app/routers/translate.py`, `server/tests/test_translate_endpoint.py`.

- [ ] **Step 1: 改端点**

`server/app/routers/translate.py`：

(a) import 区加：
```python
from app.core import crypto
```
并在 `router = APIRouter()` 上方加模块级私钥（启动时载一次）：
```python
_server_priv = crypto.load_private_key(settings.session_private_key) if settings.session_private_key else None
```

(b) `BlockIn` 改为可明文可密文：
```python
class BlockIn(BaseModel):
    id: str
    source: str | None = None  # 明文路径
    ct: str | None = None      # 加密路径（base64，AAD="src:"+id）
```

(c) 端点函数体：读头、按头派生密钥、解密 source。把 `blocks = [...]` 那行替换为：
```python
    eph_pub = request.headers.get("x-eph-pub", "")
    enc_key = crypto.derive_key(_server_priv, eph_pub) if (eph_pub and _server_priv) else None
    if enc_key is not None:
        blocks = [SourceBlock(b.id, crypto.decrypt(enc_key, b.ct or "", f"src:{b.id}")) for b in req.blocks]
    else:
        blocks = [SourceBlock(b.id, b.source or "") for b in req.blocks]
```

(d) `gen()` 里 BlockEvent 分支按是否有 `enc_key` 决定明/密文：
```python
            if isinstance(ev, BlockEvent):
                if enc_key is not None:
                    yield _sse("block", {"id": ev.id, "ct": crypto.encrypt(enc_key, ev.translated, f"dst:{ev.id}")})
                else:
                    yield _sse("block", {"id": ev.id, "translated": ev.translated})
```

- [ ] **Step 2: 端点加密路径测试**

`server/tests/test_translate_endpoint.py` 加（沿用文件里既有的 fake deepseek / app fixture 风格；用真实 crypto 造客户端侧）：
```python
def _enc_client():
    """返回 (X-Eph-Pub 值, encrypt(plaintext,aad), decrypt(box,aad))——模拟加密客户端。"""
    from app.core import crypto
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives import serialization, hashes
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    import base64
    server_priv = crypto.load_private_key(crypto.gen_private_key_b64())
    eph = ec.generate_private_key(ec.SECP256R1())
    eph_pub_b64 = base64.b64encode(
        eph.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    ).decode()
    server_pub = ec.EllipticCurvePublicKey.from_encoded_point(
        ec.SECP256R1(), base64.b64decode(crypto.public_key_b64(server_priv)))
    key = HKDF(algorithm=hashes.SHA256(), length=32, salt=b"imt-d13", info=b"session-key").derive(
        eph.exchange(ec.ECDH(), server_pub))
    return server_priv, eph_pub_b64, key
```
然后一个用例：用 `monkeypatch`/依赖覆盖把端点的 `_server_priv` 指到上面 `server_priv`（`monkeypatch.setattr("app.routers.translate._server_priv", server_priv)`），POST 带 `X-Eph-Pub` 头 + `blocks=[{id, ct: encrypt(source,"src:id")}]`，断言收到的 `block` 事件有 `ct` 且 `crypto.decrypt(key, ct, "dst:id")` == 期望译文（fake deepseek 按 id 回固定译文）。明文路径既有用例保持不变（不带头）。

- [ ] **Step 3: 跑测试**

Run: `cd server && uv run pytest tests/test_translate_endpoint.py tests/test_crypto.py -v`
Expected: 全 PASS（明文老用例 + 新加密用例）。

- [ ] **Step 4: Commit**
```bash
cd server && git add app/routers/translate.py tests/test_translate_endpoint.py
git commit -m "feat(translate): 按 X-Eph-Pub 解密原文/加密译文（D-13）"
```

---

### Task 3: 客户端加密核心 `crypto.ts` + 配置 + 单测

**Files:** Create `front/lib/crypto.ts`, `front/.test-crypto.mjs`; Modify `front/lib/config.ts`, `front/.env.example`.

- [ ] **Step 1: 写 `lib/crypto.ts`**（见仓库 plan 附录的完整代码；要点：会话级缓存临时密钥对 + 派生 AES 密钥，`encryptField`/`decryptField` 用 `iv(12)‖ct` base64，AAD 同规格）

```ts
// 应用层加密（D-13）：ECDH(P-256)+HKDF-SHA256→AES-256-GCM。钉死服务端公钥，每会话临时密钥。
// 只在构建注入了 SERVER_PUBKEY 时启用（生产）；dev 无公钥＝明文路径。原生 Web Crypto，不引库。
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
function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

interface Session { ephPubB64: string; aesKey: CryptoKey; }
let sessionPromise: Promise<Session> | null = null;

async function getSession(): Promise<Session> {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    const serverPub = await subtle.importKey(
      'raw', b64decode(SERVER_PUBKEY), { name: 'ECDH', namedCurve: 'P-256' }, false, []
    );
    const eph = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const bits = await subtle.deriveBits({ name: 'ECDH', public: serverPub }, eph.privateKey, 256);
    const hkdfKey = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    const aesKey = await subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: HKDF_INFO },
      hkdfKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
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
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, aesKey, enc.encode(plaintext));
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return b64encode(out.buffer);
}

export async function decryptField(payloadB64: string, aad: string): Promise<string> {
  const { aesKey } = await getSession();
  const raw = b64decode(payloadB64);
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: enc.encode(aad) }, aesKey, raw.slice(12)
  );
  return new TextDecoder().decode(pt);
}
```

- [ ] **Step 2: 配置**

`front/lib/config.ts` 末尾加：
```ts
// D-13 应用层加密：服务端静态公钥（base64 未压缩点）。构建期注入；空＝明文（dev）。公钥可公开。
export const SERVER_PUBKEY = (import.meta.env.WXT_SERVER_PUBKEY ?? '').trim();
```
`front/.env.example` 加一行：`WXT_SERVER_PUBKEY=`（注释：留空＝明文 dev；生产填 `gen_session_keypair.py` 产出的公钥）。

- [ ] **Step 3: 写 `.test-crypto.mjs`（真实 subtle 往返 + ECDH 一致 + 金标向量）**

镜像 crypto.ts 的纯加解密逻辑、跑真实 `globalThis.crypto.subtle`；金标向量 `GOLDEN`（在 Step 4 由 Python 产出后填入）验跨语言互通：
```js
// 真实 Web Crypto（Node ≥18 globalThis.crypto.subtle）。验：① ECDH+HKDF 两方派生一致 ②AES-GCM 往返
// ③ Python 产出的金标向量 JS 能解密（跨语言互通）。改规格请同步 crypto.ts / crypto.py。
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const SALT = enc.encode('imt-d13'), INFO = enc.encode('session-key');
const b64e = (buf) => Buffer.from(new Uint8Array(buf)).toString('base64');
const b64d = (s) => new Uint8Array(Buffer.from(s, 'base64'));
async function deriveKey(privKey, pubKey) {
  const bits = await subtle.deriveBits({ name: 'ECDH', public: pubKey }, privKey, 256);
  const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: SALT, info: INFO }, hk, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
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
  // ① ECDH 两方派生一致：a/b 两对密钥，互相用对方公钥 → 同 AES（用 rawKey 比较）
  const a = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const b = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const ka = await deriveKey(a.privateKey, b.publicKey);
  const kb = await deriveKey(b.privateKey, a.publicKey);
  const ra = b64e(await subtle.exportKey('raw', ka)), rb = b64e(await subtle.exportKey('raw', kb));
  t('ECDH+HKDF 两方派生一致', ra === rb);

  // ② AES-GCM 往返 + AAD 绑定
  const box = await encryptField(ka, 'Hello <g0>世界</g0>', 'dst:b1');
  t('AES-GCM 往返', (await decryptField(ka, box, 'dst:b1')) === 'Hello <g0>世界</g0>');
  let threw = false; try { await decryptField(ka, box, 'src:b1'); } catch { threw = true; }
  t('AAD 不符解密失败', threw);

  // ③ 金标向量（Python crypto.py 产出；Step 4 填入）：JS 解密得到原文 → 跨语言互通
  // GOLDEN = { keyB64, box, aad, plaintext }
  if (typeof GOLDEN !== 'undefined') {
    const key = await subtle.importKey('raw', b64d(GOLDEN.keyB64), { name: 'AES-GCM' }, false, ['decrypt']);
    t('金标向量跨语言解密', (await decryptField(key, GOLDEN.box, GOLDEN.aad)) === GOLDEN.plaintext);
  } else {
    t('金标向量已填入', false);
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
};
run();
```
（顶部先放一行占位 `const GOLDEN = undefined;`，Step 4 用 Python 产出的真实向量替换。）

- [ ] **Step 4: 产出金标向量并填入**

Run（用固定密钥造一条 Python 密文）:
```bash
cd server && uv run python -c "
from app.core import crypto, base64 as _b
key=bytes(range(32)); aad='dst:b1'; pt='Hello <g0>世界</g0> ✓'
import base64
print('keyB64', base64.b64encode(key).decode())
print('box', crypto.encrypt(key, pt, aad))
print('aad', aad); print('plaintext', pt)
"
```
把输出填进 `front/.test-crypto.mjs` 顶部 `const GOLDEN = { keyB64:'...', box:'...', aad:'dst:b1', plaintext:'Hello <g0>世界</g0> ✓' };`。

- [ ] **Step 5: 跑单测 + 编译**

Run: `cd front && node .test-crypto.mjs && pnpm compile`
Expected: 4 PASS（含金标向量）；compile 无错。

- [ ] **Step 6: Commit**
```bash
cd front && git add lib/crypto.ts lib/config.ts .env.example .test-crypto.mjs
git commit -m "feat(crypto): 客户端 Web Crypto 加密核心 + 金标向量互通单测（D-13）"
```

---

### Task 4: api.ts 接线（请求加密 source / SSE 解密 translated，门控）

**Files:** Modify `front/lib/api.ts`.

- [ ] **Step 1: 改 api.ts**

(a) import 加：`import { encryptionEnabled, ephemeralPublicKey, encryptField, decryptField } from './crypto';`

(b) `ApiBlock` 序列化前：若 `encryptionEnabled()`，把 body 的 blocks 换成 `{id, ct}` 并加头。即在 `fetch` 前构造：
```ts
    const useEnc = encryptionEnabled();
    let bodyBlocks: unknown[] = blocks;
    const extraHeaders: Record<string, string> = {};
    if (useEnc) {
      extraHeaders['X-Eph-Pub'] = await ephemeralPublicKey();
      bodyBlocks = await Promise.all(
        blocks.map(async (b) => ({ id: b.id, ct: await encryptField(b.source, `src:${b.id}`) }))
      );
    }
```
把 fetch 的 headers 并入 `...extraHeaders`，body 的 `blocks` 换成 `bodyBlocks`。

(c) SSE `block` 分支解密：把
```ts
      if (ev.event === 'block') {
        try {
          const { id, translated } = JSON.parse(ev.data) as { id: string; translated: string };
          handlers.onBlock(id, translated);
        } catch { /* ... */ }
      }
```
改为（密文则异步解密；块间无序无碍——各块按 id 独立回填）：
```ts
      if (ev.event === 'block') {
        try {
          const obj = JSON.parse(ev.data) as { id: string; translated?: string; ct?: string };
          if (obj.ct !== undefined) {
            void (async () => {
              try { handlers.onBlock(obj.id, await decryptField(obj.ct!, `dst:${obj.id}`)); }
              catch { /* 解密失败：丢弃该块，客户端保持英文 */ }
            })();
          } else if (obj.translated !== undefined) {
            handlers.onBlock(obj.id, obj.translated);
          }
        } catch { /* 单事件坏 JSON 跳过 */ }
      }
```

- [ ] **Step 2: 编译**

Run: `cd front && pnpm compile`
Expected: 无错。

- [ ] **Step 3: Commit**
```bash
cd front && git add lib/api.ts
git commit -m "feat(api): 请求加密原文 + SSE 解密译文（门控，D-13）"
```

---

### Task 5: 全量验证 + 文档同步

**Files:** Modify `server/CLAUDE.md`, `front/CLAUDE.md`.

- [ ] **Step 1: 两端全量**

Run: `cd server && uv run pytest` ；`cd front && pnpm compile && node .test-crypto.mjs && node .test-localcache.mjs && node .test-pagekey.mjs && node .test-sse.mjs && node .test-restore-wrapper.mjs`
Expected: server 全绿；front compile + 5 单测 ALL PASS。

- [ ] **Step 2: 全量 build**

Run: `cd front && env -u ALL_PROXY -u HTTP_PROXY -u HTTPS_PROXY pnpm build`
Expected: 成功（验加密模块进 SW bundle）。

- [ ] **Step 3: 端到端冒烟（best-effort）**

`uv run python scripts/gen_session_keypair.py` → 私钥写 `server/.env`、公钥写 `front/.env` 的 `WXT_SERVER_PUBKEY`；重启 server + `pnpm build` 重载扩展。翻译一个白名单页：SW network 里 `/v1/translate` 请求体 blocks 全是 `ct`（无明文 source）、响应 `block` 事件全是 `ct`；页面译文正常淡入。（dev 环境未就绪可跳过，Step 1/2 为提交闸门。）

- [ ] **Step 4: 文档同步**

`server/CLAUDE.md`：铁律区加一条「**9. 应用层加密（D-13）**：见 `X-Eph-Pub` 头则 ECDH 派生会话密钥、解密 `ct` 原文 / 加密 `ct` 译文（`app/core/crypto.py`）；只加密叶子字段，SSE 信封与标记校验在明文上做；私钥在 env、非 E2E。」模块区 `core/` 行补 `crypto.py(ECDH+HKDF+AES-GCM)`。API 表面 `/v1/translate` 注明「带 X-Eph-Pub 则收发 `ct`」。

`front/CLAUDE.md`：模块区 `lib/` 加 `crypto.ts # 应用层加密（D-13）：ECDH+HKDF+AES-GCM，钉死服务端公钥、会话级密钥；api.ts 用它加密 source/解密 translated`；`config.ts` 行补 `SERVER_PUBKEY`；数据流第 3 步补「加密开启时 source 经 crypto.ts 加密、带 X-Eph-Pub 头；SSE 译文为 ct，解密后再校验」。

- [ ] **Step 5: Commit**
```bash
git add server/CLAUDE.md front/CLAUDE.md
git commit -m "docs: D-13 应用层加密铁律/模块/数据流同步"
```

---

## Self-Review

**1. Spec coverage（D-13）：** 原文/译文应用层加密 → Task 1 核心 + Task 2 端点 + Task 3/4 客户端 ✓；ECDH+公钥钉死、会话级密钥非硬编码 → `crypto.ts` 会话临时密钥 + 钉死 `SERVER_PUBKEY`（公钥）✓；非 E2E → 服务端解密发模型 ✓；不破坏 SSE/标记校验 → 只加密叶子字段、信封/ID 明文、两端在明文上校验 ✓；防降级 → 加密客户端只发 `ct`、剥头即失败关闭、不泄明文 ✓。

**2. 跨语言互通：** 规格逐字节钉死（P-256 未压缩点 / ECDH X 坐标 / HKDF salt+info / IV(12)‖ct‖tag / AAD）；两端真实 crypto 单测 + **Python→JS 金标向量** + best-effort e2e 三重验。

**3. 分层正确：** 加密只在 api.ts（+服务端端点）；缓存（D-11b）与 content 仍在明文域——缓存键＝明文 source、onBlock 收明文，加密透明叠加，不动 D-11b/标记/重建。

**4. 门控安全：** 客户端 `WXT_SERVER_PUBKEY` 空＝明文（dev）；服务端 `X-Eph-Pub` 在且私钥在＝解密路径，否则明文路径（现有端点测试不带头 → 不受影响）。

**遗留（D-13 收尾，另起小计划，复用本计划 crypto.ts/crypto.py）：** ① **邮箱凭证加密**（register/login 的 email/password，蓝图同属 D-13）；② 返回的 access/refresh token 仍走明文头（短时 bearer，残留风险）；③ 私钥轮换（服务端 current+prev 双密钥 fallback）。
