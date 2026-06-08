from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import AnonUsage

ANON_DAILY_PAGE_LIMIT = 3
QUOTA_MESSAGE = "今日免费 3 页已用完，登录后免费畅用"


@dataclass
class QuotaDecision:
    allowed: bool
    used: int          # 当日已用（不同 page_key 数）
    limit: int
    message: str = ""


class AnonQuotaRepo:
    """匿名配额：每设备每本地日按不同 page_key 计「页」，上限 ANON_DAILY_PAGE_LIMIT。
    已计过的页重复翻译不再计数（每页一次）。"""

    def __init__(self, session: AsyncSession) -> None:
        self._s = session

    async def _used(self, device_id: str, local_date: str) -> int:
        n = await self._s.scalar(
            select(func.count(func.distinct(AnonUsage.page_key))).where(
                AnonUsage.device_id == device_id, AnonUsage.local_date == local_date
            )
        )
        return int(n or 0)

    async def check_and_count(
        self, device_id: str, local_date: str, page_key: str, ip: str | None = None
    ) -> QuotaDecision:
        known = await self._s.scalar(
            select(AnonUsage.id).where(
                AnonUsage.device_id == device_id,
                AnonUsage.local_date == local_date,
                AnonUsage.page_key == page_key,
            )
        )
        used = await self._used(device_id, local_date)
        if known is not None:
            return QuotaDecision(True, used, ANON_DAILY_PAGE_LIMIT)  # 已计页：免费放行
        if used < ANON_DAILY_PAGE_LIMIT:
            self._s.add(
                AnonUsage(device_id=device_id, local_date=local_date, page_key=page_key, ip=ip)
            )
            await self._s.commit()
            return QuotaDecision(True, used + 1, ANON_DAILY_PAGE_LIMIT)
        return QuotaDecision(False, used, ANON_DAILY_PAGE_LIMIT, QUOTA_MESSAGE)

    async def usage(self, device_id: str, local_date: str) -> tuple[int, int]:
        return await self._used(device_id, local_date), ANON_DAILY_PAGE_LIMIT
