from app.core.security import (
    create_access_token,
    decode_access_token,
    hash_password,
    hash_refresh_token,
    new_refresh_token,
    verify_password,
)


def test_password_hash_roundtrip():
    h = hash_password("s3cret!")
    assert h != "s3cret!"
    assert verify_password("s3cret!", h)
    assert not verify_password("wrong", h)


def test_access_token_roundtrip():
    tok = create_access_token(user_id=42, ttl_seconds=60)
    assert decode_access_token(tok) == 42


def test_access_token_expired_returns_none():
    tok = create_access_token(user_id=42, ttl_seconds=-1)
    assert decode_access_token(tok) is None


def test_access_token_tampered_returns_none():
    assert decode_access_token("not.a.jwt") is None


def test_refresh_token_hash_stable_and_opaque():
    raw = new_refresh_token()
    assert len(raw) >= 32
    assert hash_refresh_token(raw) == hash_refresh_token(raw)
    assert hash_refresh_token(raw) != raw
