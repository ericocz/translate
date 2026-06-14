import base64

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from app.core import crypto


def _client_eph():
    """模拟客户端临时密钥对，返回 (临时私钥, 临时公钥 base64 未压缩点)。"""
    eph = ec.generate_private_key(ec.SECP256R1())
    pub_b64 = base64.b64encode(
        eph.public_key().public_bytes(
            serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
        )
    ).decode()
    return eph, pub_b64


def test_ecdh_both_sides_agree():
    server_priv = crypto.load_private_key(crypto.gen_private_key_b64())
    eph, eph_pub_b64 = _client_eph()
    # 服务端：自己私钥 + 客户端临时公钥
    k_server = crypto.derive_key(server_priv, eph_pub_b64)
    # 客户端侧：临时私钥 + 服务端公钥（同一共享密钥 → 同一 HKDF 输出）
    server_pub = ec.EllipticCurvePublicKey.from_encoded_point(
        ec.SECP256R1(), base64.b64decode(crypto.public_key_b64(server_priv))
    )
    shared = eph.exchange(ec.ECDH(), server_pub)
    k_client = HKDF(
        algorithm=hashes.SHA256(), length=32, salt=b"imt-d13", info=b"session-key"
    ).derive(shared)
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
