from app.services.tier import CAPS
from app.services.tier_repo import TierRepo
from app.services.usage_repo import DailyUsageRepo


async def test_under_cap_allowed(db_session):
    repo = TierRepo(db_session)
    ev = await repo.evaluate(1, "2026-06-08")
    assert ev.allowed and ev.cap == CAPS[0]


async def test_over_cap_blocks(db_session):
    await DailyUsageRepo(db_session).add(1, "2026-06-08", CAPS[0], 0, pages=1)
    repo = TierRepo(db_session)
    ev = await repo.evaluate(1, "2026-06-08")
    assert not ev.allowed and ev.notice


async def test_notice_persisted_and_cleared(db_session):
    repo = TierRepo(db_session)
    du = DailyUsageRepo(db_session)
    await du.add(1, "2026-06-08", CAPS[0], 0, pages=1)
    await repo.evaluate(1, "2026-06-08")  # last_day=08
    await du.add(1, "2026-06-09", CAPS[0], 0, pages=1)
    await repo.evaluate(1, "2026-06-09")  # 结算 08 顶格 → strike1
    await du.add(1, "2026-06-10", CAPS[0], 0, pages=1)
    await repo.evaluate(1, "2026-06-10")  # 结算 09 顶格 → 降档 + notice（但当天也顶格→拦截，notice 不入列）

    # 上一例降档当天也顶格被拦截，notice 经 quota 即时下发、不入列。换一个「降档但当天未超」的场景：
    du2 = DailyUsageRepo(db_session)
    await du2.add(2, "2026-06-08", CAPS[0], 0, pages=1)
    await repo.evaluate(2, "2026-06-08")
    await du2.add(2, "2026-06-09", CAPS[0], 0, pages=1)
    await repo.evaluate(2, "2026-06-09")  # strike1
    # 第 10 天用量为 0（未超）→ 降档 + 放行 → notice 入列
    await repo.evaluate(2, "2026-06-10")
    n = await repo.pop_notice(2)
    assert n is not None
    assert await repo.pop_notice(2) is None  # 读后清空
