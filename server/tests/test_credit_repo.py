from decimal import Decimal

from sqlalchemy import func, select

from app.db.base import async_session
from app.db.models import CreditTxn
from app.services.credit_repo import CreditRepo


async def test_grant_accumulates(db_session):
    async with async_session() as s:
        repo = CreditRepo(s)
        assert await repo.get_balance("u:1") == Decimal("0")
        assert await repo.grant("u:1", Decimal("5"), "grant") == Decimal("5")  # ¥5
        assert await repo.grant("u:1", Decimal("1"), "grant") == Decimal("6")  # +¥1
        assert await repo.get_balance("u:1") == Decimal("6")


async def test_grant_idempotent(db_session):
    async with async_session() as s:
        repo = CreditRepo(s)
        assert await repo.grant("u:2", Decimal("5"), "grant", idempotency_key="wh-1") == Decimal("5")
        # 同 key 重投：不重复入账
        assert await repo.grant("u:2", Decimal("5"), "grant", idempotency_key="wh-1") == Decimal("5")
        assert await repo.get_balance("u:2") == Decimal("5")
    async with async_session() as s:
        cnt = await s.scalar(select(func.count()).select_from(CreditTxn).where(CreditTxn.owner == "u:2"))
        assert cnt == 1


async def test_deduct_reduces(db_session):
    async with async_session() as s:
        repo = CreditRepo(s)
        await repo.grant("u:3", Decimal("2"), "gift")
        assert await repo.deduct("u:3", Decimal("0.5")) == Decimal("1.5")
        assert await repo.get_balance("u:3") == Decimal("1.5")


async def test_deduct_high_precision_no_rounding(db_session):
    # 方案 B：账本高精度（NUMERIC(18,10)），扣亚分级成本精确、不归零
    async with async_session() as s:
        repo = CreditRepo(s)
        await repo.grant("u:7", Decimal("2"), "gift")
        assert await repo.deduct("u:7", Decimal("0.0000039")) == Decimal("1.9999961")


async def test_has_account_false_then_true(db_session):
    async with async_session() as s:
        repo = CreditRepo(s)
        assert await repo.has_account("u:9") is False  # 从未领过/充过
        await repo.grant("u:9", Decimal("1"), "grant")
    async with async_session() as s:
        repo = CreditRepo(s)
        assert await repo.has_account("u:9") is True
        assert await repo.get_balance("u:9") == Decimal("1")


async def test_has_account_true_even_when_used_up(db_session):
    # 余额耗尽（=0）但有过流水 → 仍算有账户（区分「从未有」与「用光了」）
    async with async_session() as s:
        repo = CreditRepo(s)
        await repo.grant("u:11", Decimal("1"), "gift")
        await repo.deduct("u:11", Decimal("1"))
    async with async_session() as s:
        repo = CreditRepo(s)
        assert await repo.get_balance("u:11") == Decimal("0")
        assert await repo.has_account("u:11") is True


async def test_txn_ledger_records_deltas(db_session):
    async with async_session() as s:
        repo = CreditRepo(s)
        await repo.grant("u:4", Decimal("1"), "grant")
        await repo.deduct("u:4", Decimal("0.3"))
    async with async_session() as s:
        rows = (
            await s.scalars(select(CreditTxn).where(CreditTxn.owner == "u:4").order_by(CreditTxn.id))
        ).all()
        assert [r.delta for r in rows] == [Decimal("1"), Decimal("-0.3")]
        assert [r.kind for r in rows] == ["grant", "deduct"]
        assert await CreditRepo(s).get_balance("u:4") == Decimal("0.7")


async def test_device_owner_gift_idempotent(db_session):
    # 设备 owner（领赠送）与用户 owner 共用同一套接口；同 idempotency_key 重领不叠加。
    async with async_session() as s:
        repo = CreditRepo(s)
        assert await repo.grant("d:dev1", Decimal("2"), "gift", idempotency_key="gift:d:dev1") == Decimal("2")
        assert await repo.grant("d:dev1", Decimal("2"), "gift", idempotency_key="gift:d:dev1") == Decimal("2")
        assert await repo.get_balance("d:dev1") == Decimal("2")
