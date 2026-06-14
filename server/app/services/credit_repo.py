from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import CreditAccount, CreditTxn


class CreditRepo:
    """预付额度账本：发放（幂等）/ 扣减 / 查余额。余额以整数 micro-¥ 原子更新。
    注：deduct 不防透支（可短暂为负）——是否在余额≤0 拦截由调用方门控（接入翻译流的后续切片做）。"""

    def __init__(self, session: AsyncSession) -> None:
        self._s = session

    async def get_balance(self, user_id: int) -> int:
        row = await self._s.scalar(select(CreditAccount).where(CreditAccount.user_id == user_id))
        return int(row.balance_micro if row else 0)

    async def get_account(self, user_id: int) -> CreditAccount | None:
        """返回账户行（无则 None）——区分「免费用户（无账户）」与「付费用户余额耗尽（有账户、余额 0）」。"""
        return await self._s.scalar(select(CreditAccount).where(CreditAccount.user_id == user_id))

    async def grant(
        self, user_id: int, amount_micro: int, kind: str = "grant", idempotency_key: str | None = None
    ) -> int:
        """发放额度（充值/赠送/买断）。带 idempotency_key 时重复/并发只入账一次。返回新余额。"""
        try:
            return await self._apply(user_id, amount_micro, kind, idempotency_key)
        except IntegrityError:
            await self._s.rollback()  # idempotency_key 唯一冲突＝已入账过
            return await self.get_balance(user_id)

    async def deduct(self, user_id: int, amount_micro: int, kind: str = "deduct") -> int:
        """扣减额度（实耗）。返回新余额。"""
        return await self._apply(user_id, -amount_micro, kind, None)

    async def _apply(self, user_id: int, delta: int, kind: str, idempotency_key: str | None) -> int:
        stmt = (
            insert(CreditAccount)
            .values(user_id=user_id, balance_micro=delta)
            .on_conflict_do_update(
                index_elements=["user_id"],
                set_={"balance_micro": CreditAccount.balance_micro + delta},
            )
            .returning(CreditAccount.balance_micro)
        )
        new_balance = int(await self._s.scalar(stmt))
        self._s.add(
            CreditTxn(
                user_id=user_id,
                delta_micro=delta,
                kind=kind,
                balance_after=new_balance,
                idempotency_key=idempotency_key,
            )
        )
        await self._s.commit()
        return new_balance
