from sqlalchemy import select

from app.db.models import TranslationCache


async def test_can_insert_and_read_row(db_session):
    db_session.add(TranslationCache(key="v:abc", translated="你好"))
    await db_session.commit()
    row = (
        await db_session.execute(
            select(TranslationCache).where(TranslationCache.key == "v:abc")
        )
    ).scalar_one()
    assert row.translated == "你好"
