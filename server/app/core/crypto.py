"""应用层加密（D-13）：ECDH(P-256) + HKDF-SHA256 → AES-256-GCM。
服务端静态私钥在 env；客户端钉死服务端公钥、每会话发临时公钥，服务端无状态重新派生会话密钥。
非 E2E：服务端解密原文发模型、加密译文回客户端。只加密叶子字段，SSE 信封/标记校验不动。
客户端对应实现 front/lib/crypto.ts（同套盐/info/AAD，两端逐字节一致）。
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
    return HKDF(
        algorithm=hashes.SHA256(), length=32, salt=_HKDF_SALT, info=_HKDF_INFO
    ).derive(shared)


def encrypt(key: bytes, plaintext: str, aad: str) -> str:
    """AES-256-GCM → base64(iv(12) || ct||tag)。"""
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
    return base64.b64encode(
        priv.private_numbers().private_value.to_bytes(32, "big")
    ).decode()
