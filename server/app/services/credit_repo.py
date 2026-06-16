from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import CreditAccount, CreditTxn


def user_owner(user_id: int) -> str:
    """注册用户的额度账户 owner 键。"""
    return f"u:{user_id}"


def device_owner(device_id: str) -> str:
    """未注册设备的额度账户 owner 键（领赠送用）。"""
    return f"d:{device_id}"


class CreditRepo:
    """预付额度账本：发放（幂等）/ 扣减 / 查余额。owner = u:{user_id} 或 d:{device_id}。
    余额以整数 micro-¥ 原子更新。deduct 不防透支（可短暂为负）——余额≤0 拦截由调用方门控。"""

    def __init__(self, session: AsyncSession) -> None:
        self._s = session

    async def get_balance(self, owner: str) -> int:
        row = await self._s.scalar(select(CreditAccount).where(CreditAccount.owner == owner))
        return int(row.balance_micro if row else 0)

    async def get_account(self, owner: str) -> CreditAccount | None:
        """返回账户行（无则 None）——区分「从未领过/充过（无账户）」与「有账户、余额耗尽」。"""
        return await self._s.scalar(select(CreditAccount).where(CreditAccount.owner == owner))

    async def grant(
        self, owner: str, amount_micro: int, kind: str = "grant", idempotency_key: str | None = None
    ) -> int:
        """发放额度（充值/赠送）。带 idempotency_key 时重复/并发只入账一次。返回新余额。"""
        try:
            return await self._apply(owner, amount_micro, kind, idempotency_key)
        except IntegrityError:
            await self._s.rollback()  # idempotency_key 唯一冲突＝已入账过
            return await self.get_balance(owner)

    async def deduct(self, owner: str, amount_micro: int, kind: str = "deduct") -> int:
        """扣减额度（实耗）。返回新余额。"""
        return await self._apply(owner, -amount_micro, kind, None)

    async def _apply(self, owner: str, delta: int, kind: str, idempotency_key: str | None) -> int:
        stmt = (
            insert(CreditAccount)
            .values(owner=owner, balance_micro=delta)
            .on_conflict_do_update(
                index_elements=["owner"],
                set_={"balance_micro": CreditAccount.balance_micro + delta},
            )
            .returning(CreditAccount.balance_micro)
        )
        new_balance = int(await self._s.scalar(stmt))
        self._s.add(
            CreditTxn(
                owner=owner,
                delta_micro=delta,
                kind=kind,
                balance_after=new_balance,
                idempotency_key=idempotency_key,
            )
        )
        await self._s.commit()
        return new_balance
