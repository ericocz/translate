import secrets

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import RedeemCode

_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # 去掉易混 0/O/1/I/L


def gen_code() -> str:
    g = lambda: "".join(secrets.choice(_ALPHABET) for _ in range(4))  # noqa: E731
    return f"IMT-{g()}-{g()}-{g()}"


class RedeemCodeRepo:
    """买断注册码签发：按支付订单（source_ref）幂等，webhook 重投/并发只一张。"""

    def __init__(self, session: AsyncSession) -> None:
        self._s = session

    async def get_by_source_ref(self, source: str, source_ref: str) -> RedeemCode | None:
        return await self._s.scalar(
            select(RedeemCode).where(
                RedeemCode.source == source, RedeemCode.source_ref == source_ref
            )
        )

    async def issue(
        self,
        *,
        email: str,
        source: str,
        source_ref: str,
        product: str = "buyout",
        max_devices: int = 5,
    ) -> RedeemCode:
        """幂等签发：source_ref 已存在则返回原码；否则新建。"""
        existing = await self.get_by_source_ref(source, source_ref)
        if existing:
            return existing
        rc = RedeemCode(
            code=gen_code(),
            email=email,
            product=product,
            source=source,
            source_ref=source_ref,
            max_devices=max_devices,
        )
        self._s.add(rc)
        try:
            await self._s.commit()
        except IntegrityError:  # 并发：source_ref 唯一冲突 → 取已存在
            await self._s.rollback()
            existing = await self.get_by_source_ref(source, source_ref)
            assert existing is not None
            return existing
        await self._s.refresh(rc)
        return rc
