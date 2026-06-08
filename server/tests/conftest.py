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
        await conn.execute(text("TRUNCATE translation_cache"))
