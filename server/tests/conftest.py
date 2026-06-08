import httpx
import pytest_asyncio
from httpx import ASGITransport
from sqlalchemy import text

from app.db.base import Base, async_session, engine
from app.main import app


@pytest_asyncio.fixture
async def client():
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest_asyncio.fixture
async def db_session():
    # 建表（幂等，迁移已建则 no-op），用后清空，保证用例间隔离。
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with async_session() as s:
        yield s
    async with engine.begin() as conn:
        await conn.execute(
            text("TRUNCATE translation_cache, anon_usage, users, sessions, daily_usage CASCADE")
        )
    # pytest-asyncio 每个测试用新事件循环；asyncpg 连接绑定在创建它的 loop 上。
    # 必须 dispose 引擎，否则下个测试在新 loop 复用旧连接 → InterfaceError。
    await engine.dispose()
