from sqlalchemy import func, select

from app.db.base import async_session
from app.db.models import CreditAccount, CreditTxn
from app.services.credit_repo import CreditRepo


async def test_grant_accumulates(db_session):
    async with async_session() as s:
        repo = CreditRepo(s)
        assert await repo.get_balance("u:1") == 0
        assert await repo.grant("u:1", 5_000_000, "grant") == 5_000_000  # ¥5
        assert await repo.grant("u:1", 1_000_000, "grant") == 6_000_000  # +¥1
        assert await repo.get_balance("u:1") == 6_000_000


async def test_grant_idempotent(db_session):
    async with async_session() as s:
        repo = CreditRepo(s)
        assert await repo.grant("u:2", 5_000_000, "grant", idempotency_key="wh-1") == 5_000_000
        # 同 key 重投：不重复入账
        assert await repo.grant("u:2", 5_000_000, "grant", idempotency_key="wh-1") == 5_000_000
        assert await repo.get_balance("u:2") == 5_000_000
    async with async_session() as s:
        cnt = await s.scalar(select(func.count()).select_from(CreditTxn).where(CreditTxn.owner == "u:2"))
        assert cnt == 1


async def test_deduct_reduces(db_session):
    async with async_session() as s:
        repo = CreditRepo(s)
        await repo.grant("u:3", 2_000_000, "gift")
        assert await repo.deduct("u:3", 500_000) == 1_500_000
        assert await repo.get_balance("u:3") == 1_500_000


async def test_get_account_none_then_present(db_session):
    async with async_session() as s:
        repo = CreditRepo(s)
        assert await repo.get_account("u:9") is None  # 从未领过/充过：无账户
        await repo.grant("u:9", 1_000_000, "grant")
    async with async_session() as s:
        acct = await CreditRepo(s).get_account("u:9")
        assert acct is not None and acct.balance_micro == 1_000_000


async def test_txn_log_has_balance_after(db_session):
    async with async_session() as s:
        repo = CreditRepo(s)
        await repo.grant("u:4", 1_000_000, "grant")
        await repo.deduct("u:4", 300_000)
    async with async_session() as s:
        rows = (
            await s.scalars(select(CreditTxn).where(CreditTxn.owner == "u:4").order_by(CreditTxn.id))
        ).all()
        assert [r.balance_after for r in rows] == [1_000_000, 700_000]
        assert [r.kind for r in rows] == ["grant", "deduct"]


async def test_device_owner_gift_idempotent(db_session):
    # 设备 owner（领赠送）与用户 owner 共用同一套接口；同 idempotency_key 重领不叠加。
    async with async_session() as s:
        repo = CreditRepo(s)
        assert await repo.grant("d:dev1", 2_000_000, "gift", idempotency_key="gift:d:dev1") == 2_000_000
        assert await repo.grant("d:dev1", 2_000_000, "gift", idempotency_key="gift:d:dev1") == 2_000_000
        assert await repo.get_balance("d:dev1") == 2_000_000
