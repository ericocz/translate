from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import DailyUsage


class DailyUsageRepo:
    """登录用户每日 Token 累加（upsert）+ 当日已用 token 读取。"""

    def __init__(self, session: AsyncSession) -> None:
        self._s = session

    async def add(
        self, user_id: int, local_date: str, input_tokens: int, output_tokens: int, pages: int = 0
    ) -> None:
        stmt = insert(DailyUsage).values(
            user_id=user_id,
            local_date=local_date,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            pages=pages,
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=["user_id", "local_date"],
            set_={
                "input_tokens": DailyUsage.input_tokens + stmt.excluded.input_tokens,
                "output_tokens": DailyUsage.output_tokens + stmt.excluded.output_tokens,
                "pages": DailyUsage.pages + stmt.excluded.pages,
            },
        )
        await self._s.execute(stmt)
        await self._s.commit()

    async def tokens_today(self, user_id: int, local_date: str) -> int:
        row = await self._s.scalar(
            select(DailyUsage).where(
                DailyUsage.user_id == user_id, DailyUsage.local_date == local_date
            )
        )
        return int((row.input_tokens + row.output_tokens) if row else 0)
