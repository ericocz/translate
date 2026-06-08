import hashlib
import secrets
import time

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from app.core.config import settings

_ph = PasswordHasher()
_ALG = "HS256"


def hash_password(password: str) -> str:
    return _ph.hash(password)


def verify_password(password: str, hashed: str) -> bool:
    try:
        return _ph.verify(hashed, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def create_access_token(user_id: int, ttl_seconds: int | None = None) -> str:
    ttl = ttl_seconds if ttl_seconds is not None else settings.access_ttl_min * 60
    now = int(time.time())
    payload = {"sub": str(user_id), "iat": now, "exp": now + ttl}
    return jwt.encode(payload, settings.jwt_secret, algorithm=_ALG)


def decode_access_token(token: str) -> int | None:
    """合法且未过期 → user_id；否则 None（绝不抛给调用方）。"""
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[_ALG])
        return int(payload["sub"])
    except (jwt.InvalidTokenError, KeyError, ValueError):
        return None


def new_refresh_token() -> str:
    return secrets.token_urlsafe(32)


def hash_refresh_token(raw: str) -> str:
    # 只存哈希：库泄露也无法还原 refresh token。
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()
