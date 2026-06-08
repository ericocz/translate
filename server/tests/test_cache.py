from sqlalchemy import select

from app.db.models import TranslationCache
from app.services.cache import TranslationCacheRepo


async def test_can_insert_and_read_row(db_session):
    db_session.add(TranslationCache(key="v:abc", translated="你好"))
    await db_session.commit()
    row = (
        await db_session.execute(
            select(TranslationCache).where(TranslationCache.key == "v:abc")
        )
    ).scalar_one()
    assert row.translated == "你好"


async def test_set_then_get_many_roundtrip(db_session):
    repo = TranslationCacheRepo(db_session)
    await repo.set_many([
        {"source": "Hello", "translated": "你好", "input_tokens": 3, "output_tokens": 2},
    ])
    hits = await repo.get_many(["Hello", "Missing"])
    assert "Missing" not in hits
    assert hits["Hello"].translated == "你好"
    assert hits["Hello"].input_tokens == 3


async def test_get_many_bumps_hits(db_session):
    repo = TranslationCacheRepo(db_session)
    await repo.set_many([{"source": "X", "translated": "艾克斯", "input_tokens": 1, "output_tokens": 1}])
    await repo.get_many(["X"])
    again = await repo.get_many(["X"])
    assert again["X"].hits >= 1  # 命中累加


async def test_set_many_upsert_overwrites(db_session):
    repo = TranslationCacheRepo(db_session)
    await repo.set_many([{"source": "Y", "translated": "旧", "input_tokens": 1, "output_tokens": 1}])
    await repo.set_many([{"source": "Y", "translated": "新", "input_tokens": 2, "output_tokens": 2}])
    hits = await repo.get_many(["Y"])
    assert hits["Y"].translated == "新"
