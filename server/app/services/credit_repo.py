from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import CreditTxn


def user_owner(user_id: int) -> str:
    """注册用户的额度账户 owner 键。"""
    return f"u:{user_id}"


def device_owner(device_id: str) -> str:
    """未注册设备的额度账户 owner 键（领赠送用）。"""
    return f"d:{device_id}"


class CreditRepo:
    """预付额度账本（方案 B）：账本流水 `credit_txns` 是唯一真相，
    **余额＝某 owner 全部 delta 之和**（不存运行余额、无并发丢更新问题），展示层 round 2 位。
    owner = u:{user_id} 或 d:{device_id}。单位元 Decimal、高精度，不用浮点。
    deduct 不防透支（可短暂为负）——余额≤0 拦截由调用方门控。"""

    def __init__(self, session: AsyncSession) -> None:
        self._s = session

    async def get_balance(self, owner: str) -> Decimal:
        total = await self._s.scalar(
            select(func.coalesce(func.sum(CreditTxn.delta), 0)).where(CreditTxn.owner == owner)
        )
        return Decimal(total)

    async def has_account(self, owner: str) -> bool:
        """是否领过赠送/充过（账本里有过任何流水）——区分「从未有账户」与「有账户、余额耗尽」。"""
        row = await self._s.scalar(select(CreditTxn.id).where(CreditTxn.owner == owner).limit(1))
        return row is not None

    async def grant(
        self, owner: str, amount: Decimal, kind: str = "grant", idempotency_key: str | None = None
    ) -> Decimal:
        """发放额度（充值/赠送，单位元）。带 idempotency_key 时重复/并发只入账一次。返回新余额。"""
        try:
            await self._apply(owner, amount, kind, idempotency_key)
        except IntegrityError:
            await self._s.rollback()  # idempotency_key 唯一冲突＝已入账过
        return await self.get_balance(owner)

    async def deduct(self, owner: str, amount: Decimal, kind: str = "deduct") -> Decimal:
        """扣减额度（实耗，单位元、高精度）。返回新余额。"""
        await self._apply(owner, -amount, kind, None)
        return await self.get_balance(owner)

    async def _apply(self, owner: str, delta: Decimal, kind: str, idempotency_key: str | None) -> None:
        self._s.add(CreditTxn(owner=owner, delta=delta, kind=kind, idempotency_key=idempotency_key))
        await self._s.commit()
