from app.services.quota import AnonQuotaRepo, ANON_DAILY_PAGE_LIMIT


async def test_new_pages_count_until_limit(db_session):
    repo = AnonQuotaRepo(db_session)
    d1 = await repo.check_and_count("dev1", "2026-06-08", "pageA")
    assert d1.allowed and d1.used == 1
    d2 = await repo.check_and_count("dev1", "2026-06-08", "pageB")
    assert d2.allowed and d2.used == 2
    d3 = await repo.check_and_count("dev1", "2026-06-08", "pageC")
    assert d3.allowed and d3.used == 3
    d4 = await repo.check_and_count("dev1", "2026-06-08", "pageD")
    assert not d4.allowed and d4.used == 3  # 第 4 个新页被拒
    assert d4.limit == ANON_DAILY_PAGE_LIMIT


async def test_same_page_is_free(db_session):
    repo = AnonQuotaRepo(db_session)
    for _ in range(5):
        d = await repo.check_and_count("dev1", "2026-06-08", "pageA")
        assert d.allowed
    # 用满 3 个新页后，重复已计页仍放行，新页才拒
    await repo.check_and_count("dev1", "2026-06-08", "pageB")
    await repo.check_and_count("dev1", "2026-06-08", "pageC")
    assert (await repo.check_and_count("dev1", "2026-06-08", "pageA")).allowed
    assert not (await repo.check_and_count("dev1", "2026-06-08", "pageD")).allowed


async def test_per_device_and_per_day_isolated(db_session):
    repo = AnonQuotaRepo(db_session)
    for k in ("a", "b", "c"):
        await repo.check_and_count("dev1", "2026-06-08", k)
    # 另一设备、另一天都各自从 0 开始
    assert (await repo.check_and_count("dev2", "2026-06-08", "a")).allowed
    assert (await repo.check_and_count("dev1", "2026-06-09", "a")).allowed


async def test_usage_count(db_session):
    repo = AnonQuotaRepo(db_session)
    await repo.check_and_count("dev1", "2026-06-08", "a")
    await repo.check_and_count("dev1", "2026-06-08", "b")
    used, limit = await repo.usage("dev1", "2026-06-08")
    assert used == 2 and limit == ANON_DAILY_PAGE_LIMIT
