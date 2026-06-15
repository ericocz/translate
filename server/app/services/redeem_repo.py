import secrets

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import BUYOUT_MAX_DEVICES, BUYOUT_PRODUCT, RedeemCode

_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # 去掉易混 0/O/1/I/L


def gen_code() -> str:
    def group() -> str:
        return "".join(secrets.choice(_ALPHABET) for _ in range(4))

    return f"IMT-{group()}-{group()}-{group()}"


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
        product: str = BUYOUT_PRODUCT,
        max_devices: int = BUYOUT_MAX_DEVICES,
    ) -> RedeemCode:
        """幂等签发：source_ref 已存在则返回原码；否则新建。
        ON CONFLICT DO NOTHING（source_ref 唯一）兜底 webhook 重投/并发——同一订单只一张。"""
        stmt = (
            insert(RedeemCode)
            .values(
                code=gen_code(),
                email=email,
                product=product,
                source=source,
                source_ref=source_ref,
                max_devices=max_devices,
            )
            .on_conflict_do_nothing(index_elements=["source_ref"])
        )
        await self._s.execute(stmt)
        await self._s.commit()
        rc = await self.get_by_source_ref(source, source_ref)
        assert rc is not None  # 刚插入或重投命中已存在，必有一行
        return rc
