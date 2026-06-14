import base64
import json

import httpx
from httpx import ASGITransport
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from app.core import crypto
from app.main import app


def _client():
    return httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _enc_client():
    """模拟加密客户端：返回 (服务端私钥, 客户端临时公钥 b64, 共享 AES 密钥)。"""
    server_priv = crypto.load_private_key(crypto.gen_private_key_b64())
    eph = ec.generate_private_key(ec.SECP256R1())
    eph_pub_b64 = base64.b64encode(
        eph.public_key().public_bytes(
            serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
        )
    ).decode()
    server_pub = ec.EllipticCurvePublicKey.from_encoded_point(
        ec.SECP256R1(), base64.b64decode(crypto.public_key_b64(server_priv))
    )
    key = HKDF(
        algorithm=hashes.SHA256(), length=32, salt=b"imt-d13", info=b"session-key"
    ).derive(eph.exchange(ec.ECDH(), server_pub))
    return server_priv, eph_pub_b64, key


async def test_register_login_refresh_flow(db_session):
    async with _client() as c:
        r = await c.post("/v1/auth/register", json={"email": "u@x.com", "password": "pw12345"})
        assert r.status_code == 200
        tok = r.json()
        assert tok["email"] == "u@x.com" and tok["access"] and tok["refresh"]

        r2 = await c.post("/v1/auth/login", json={"email": "u@x.com", "password": "pw12345"})
        assert r2.status_code == 200

        r3 = await c.post("/v1/auth/refresh", json={"refresh": tok["refresh"]})
        assert r3.status_code == 200 and r3.json()["access"]


async def test_register_duplicate_409(db_session):
    async with _client() as c:
        await c.post("/v1/auth/register", json={"email": "u@x.com", "password": "pw12345"})
        r = await c.post("/v1/auth/register", json={"email": "u@x.com", "password": "pw12345"})
        assert r.status_code == 409


async def test_login_bad_credentials_401(db_session):
    async with _client() as c:
        await c.post("/v1/auth/register", json={"email": "u@x.com", "password": "pw12345"})
        r = await c.post("/v1/auth/login", json={"email": "u@x.com", "password": "bad"})
        assert r.status_code == 401


async def test_encrypted_register_then_login(db_session, monkeypatch):
    # 带 X-Eph-Pub：邮箱/密码以 ct（{"email","password"} JSON，AAD="auth"）发，服务端解密后照常注册/登录。
    server_priv, eph_pub_b64, key = _enc_client()
    monkeypatch.setattr("app.routers.auth._server_priv", server_priv)
    creds = crypto.encrypt(key, json.dumps({"email": "e@x.com", "password": "pw12345"}), "auth")
    async with _client() as c:
        r = await c.post("/v1/auth/register", json={"ct": creds}, headers={"X-Eph-Pub": eph_pub_b64})
        assert r.status_code == 200 and r.json()["email"] == "e@x.com"

        r2 = await c.post("/v1/auth/login", json={"ct": creds}, headers={"X-Eph-Pub": eph_pub_b64})
        assert r2.status_code == 200 and r2.json()["access"]
