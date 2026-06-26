"""CORS 回归：管理台（独立 origin）跨端口调后端必须能过预检。

无 CORSMiddleware 时浏览器预检 OPTIONS 拿不到 Access-Control-Allow-Origin → 整个管理台
登录/取数全挂（"Failed to fetch"）。curl 不受 CORS 影响，故只有浏览器/此测能复现。

CORS 是中间件层关注点，**刻意只打不碰 DB 的路由**（预检 OPTIONS 在路由前被中间件短路、
/health 不查库）：避免创建 asyncpg 连接而又不走 db_session 的 engine.dispose，污染后续用例
（pytest-asyncio 每测一新事件循环，旧连接绑死循环 → InterfaceError，见 conftest 注释）。
"""
import httpx
import pytest
from httpx import ASGITransport

from app.core.config import settings
from app.main import app


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.asyncio
async def test_preflight_allows_admin_origin():
    origin = settings.cors_origin_list[0]  # dev 默认 http://localhost:3001
    async with _client() as c:
        r = await c.options(
            "/admin/login",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
    assert r.status_code in (200, 204)
    assert r.headers.get("access-control-allow-origin") == origin


@pytest.mark.asyncio
async def test_actual_request_has_cors_header():
    # 用 /health（不查库）验证实际请求也带 CORS 头——浏览器据此放行读取响应体。
    origin = settings.cors_origin_list[0]
    async with _client() as c:
        r = await c.get("/health", headers={"Origin": origin})
    assert r.status_code == 200
    assert r.headers.get("access-control-allow-origin") == origin


@pytest.mark.asyncio
async def test_unknown_origin_not_allowed():
    async with _client() as c:
        r = await c.options(
            "/admin/login",
            headers={
                "Origin": "https://evil.example",
                "Access-Control-Request-Method": "POST",
            },
        )
    # 非白名单 origin 不回 ACAO（或不等于该 origin）→ 浏览器拦截。
    assert r.headers.get("access-control-allow-origin") != "https://evil.example"
