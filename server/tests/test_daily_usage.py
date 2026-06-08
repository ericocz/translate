from app.services.usage_repo import DailyUsageRepo


async def test_add_accumulates(db_session):
    repo = DailyUsageRepo(db_session)
    await repo.add(1, "2026-06-08", 100, 50, pages=1)
    await repo.add(1, "2026-06-08", 30, 20, pages=1)
    assert await repo.tokens_today(1, "2026-06-08") == 200  # 130 in + 70 out


async def test_isolated_per_user_day(db_session):
    repo = DailyUsageRepo(db_session)
    await repo.add(1, "2026-06-08", 10, 10, pages=1)
    assert await repo.tokens_today(2, "2026-06-08") == 0
    assert await repo.tokens_today(1, "2026-06-09") == 0
