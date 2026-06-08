import httpx
from httpx import ASGITransport

from app.main import app


def _client():
    return httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


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
