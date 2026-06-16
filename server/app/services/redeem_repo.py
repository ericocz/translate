import secrets
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import BUYOUT_MAX_DEVICES, BUYOUT_PRODUCT, RedeemActivation, RedeemCode

_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # 去掉易混 0/O/1/I/L


def gen_code() -> str:
    def group() -> str:
        return "".join(secrets.choice(_ALPHABET) for _ in range(4))

    return f"IMT-{group()}-{group()}-{group()}"


@dataclass
class VerifyResult:
    ok: bool
    product: str = ""
    reason: str = ""  # invalid_code | device_limit


class RedeemCodeRepo:
    """买断注册码：按支付订单（source_ref）幂等签发 + 激活绑定设备（verify）。"""

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

    async def verify(self, code: str, device_id: str) -> VerifyResult:
        """激活买断码并绑定设备（客户端填码触发）：
        - code 不存在 / 非 active → invalid_code
        - 该设备已激活过此 code → 幂等成功
        - 未激活且已绑定设备数 < max_devices → 绑定、成功
        - 已达 max_devices → device_limit
        """
        rc = await self._s.scalar(select(RedeemCode).where(RedeemCode.code == code))
        if rc is None or rc.status != "active":
            return VerifyResult(False, reason="invalid_code")
        already = await self._s.scalar(
            select(RedeemActivation.id).where(
                RedeemActivation.code_id == rc.id, RedeemActivation.device_id == device_id
            )
        )
        if already is not None:
            return VerifyResult(True, product=rc.product)  # 幂等
        bound = await self._s.scalar(
            select(func.count()).select_from(RedeemActivation).where(
                RedeemActivation.code_id == rc.id
            )
        )
        if (bound or 0) >= rc.max_devices:
            return VerifyResult(False, product=rc.product, reason="device_limit")
        self._s.add(RedeemActivation(code_id=rc.id, device_id=device_id))
        try:
            await self._s.commit()
        except IntegrityError:
            await self._s.rollback()  # 并发同设备激活：唯一约束兜底 → 幂等成功
            return VerifyResult(True, product=rc.product)
        return VerifyResult(True, product=rc.product)
