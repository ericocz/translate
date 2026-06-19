from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import CreditTxn

# 多币种分桶。扣费按此固定优先级只动单一桶（赠送 → 充值人民币 → 充值美元）、用该桶币种三档价计，
# 不做汇率换算：人民币桶单位元、美元桶单位美元。
BUCKET_GIFT_CNY = "gift_cny"
BUCKET_RECHARGE_CNY = "recharge_cny"
BUCKET_RECHARGE_USD = "recharge_usd"
BUCKET_PRIORITY = (BUCKET_GIFT_CNY, BUCKET_RECHARGE_CNY, BUCKET_RECHARGE_USD)
CURRENCY_OF = {
    BUCKET_GIFT_CNY: "CNY",
    BUCKET_RECHARGE_CNY: "CNY",
    BUCKET_RECHARGE_USD: "USD",
}


def user_owner(user_id: int) -> str:
    """注册用户的额度账户 owner 键。"""
    return f"u:{user_id}"


def device_owner(device_id: str) -> str:
    """未注册设备的额度账户 owner 键（领赠送用）。"""
    return f"d:{device_id}"


class CreditRepo:
    """预付额度账本（方案 B）：账本流水 `credit_txns` 是唯一真相。
    **某桶余额＝该 owner + bucket 全部 delta 之和**（不存运行余额、无并发丢更新）。
    owner = u:{user_id} 或 d:{device_id}；bucket ∈ BUCKET_PRIORITY。
    扣费按优先级只动单一桶、用该桶币种三档价（见 active_bucket + pricing.cost_for）。
    deduct 不防透支（最后一笔可短暂为负）——余额≤0 拦截由调用方门控。"""

    def __init__(self, session: AsyncSession) -> None:
        self._s = session

    async def get_balance(self, owner: str, bucket: str | None = None) -> Decimal:
        """余额（桶币种原生单位）。bucket=None → 跨桶求和（仅作存在性/总量粗看，混币种勿直接展示）。"""
        q = select(func.coalesce(func.sum(CreditTxn.delta), 0)).where(CreditTxn.owner == owner)
        if bucket is not None:
            q = q.where(CreditTxn.bucket == bucket)
        return Decimal(await self._s.scalar(q))

    async def get_balances(self, owner: str) -> dict[str, Decimal]:
        """三桶余额 dict（缺省 0）：{gift_cny, recharge_cny, recharge_usd}。"""
        rows = await self._s.execute(
            select(CreditTxn.bucket, func.coalesce(func.sum(CreditTxn.delta), 0))
            .where(CreditTxn.owner == owner)
            .group_by(CreditTxn.bucket)
        )
        sums = {b: Decimal(v) for b, v in rows.all()}
        return {b: sums.get(b, Decimal("0")) for b in BUCKET_PRIORITY}

    async def active_bucket(self, owner: str) -> tuple[str, str] | None:
        """当前应扣费的桶 + 其币种：优先级最高且余额 > 0 的桶；全空返 None。"""
        balances = await self.get_balances(owner)
        for b in BUCKET_PRIORITY:
            if balances[b] > 0:
                return b, CURRENCY_OF[b]
        return None

    async def has_account(self, owner: str) -> bool:
        """是否领过赠送/充过（账本里有过任何流水）——区分「从未有账户」与「有账户、余额耗尽」。"""
        row = await self._s.scalar(select(CreditTxn.id).where(CreditTxn.owner == owner).limit(1))
        return row is not None

    async def grant(
        self,
        owner: str,
        amount: Decimal,
        kind: str = "grant",
        bucket: str = BUCKET_RECHARGE_CNY,
        idempotency_key: str | None = None,
    ) -> Decimal:
        """发放额度（充值/赠送）到指定桶。带 idempotency_key 时重复/并发只入账一次。返回该桶新余额。"""
        try:
            await self._apply(owner, bucket, amount, kind, idempotency_key)
        except IntegrityError:
            await self._s.rollback()  # idempotency_key 唯一冲突＝已入账过
        return await self.get_balance(owner, bucket)

    async def deduct(
        self, owner: str, amount: Decimal, bucket: str = BUCKET_RECHARGE_CNY, kind: str = "deduct"
    ) -> Decimal:
        """从指定桶扣减额度（实耗，桶币种原生单位、高精度）。返回该桶新余额。"""
        await self._apply(owner, bucket, -amount, kind, None)
        return await self.get_balance(owner, bucket)

    async def _apply(
        self, owner: str, bucket: str, delta: Decimal, kind: str, idempotency_key: str | None
    ) -> None:
        self._s.add(
            CreditTxn(owner=owner, bucket=bucket, delta=delta, kind=kind, idempotency_key=idempotency_key)
        )
        await self._s.commit()
