from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import DailyUsage, QuotaTier
from app.services.tier import TierEval, TierState, evaluate_tier


class TierRepo:
    """梯度限流仓库：读 daily_usage 做跨日结算，持久化档位状态；notice 列暂存升降档提醒。"""

    def __init__(self, session: AsyncSession) -> None:
        self._s = session

    async def _tokens(self, user_id: int, day: str | None) -> int:
        if not day:
            return 0
        row = await self._s.scalar(
            select(DailyUsage).where(DailyUsage.user_id == user_id, DailyUsage.local_date == day)
        )
        return int((row.input_tokens + row.output_tokens) if row else 0)

    async def evaluate(self, user_id: int, local_date: str) -> TierEval:
        row = await self._s.get(QuotaTier, user_id)
        state = TierState(
            tier=row.tier if row else 0,
            strikes=row.strikes if row else 0,
            clean_days=row.clean_days if row else 0,
            last_day=row.last_day if row else None,
        )
        tokens_today = await self._tokens(user_id, local_date)
        prev_day_tokens = await self._tokens(user_id, state.last_day)
        ev = evaluate_tier(state, local_date, tokens_today, prev_day_tokens)

        ns = ev.state
        # 升降档提醒（仍放行时）写入 notice 列，供 /v1/usage 取走；
        # 拦截时的提醒由端点经 quota 事件即时下发，不入列。
        if row is None:
            row = QuotaTier(user_id=user_id)
            self._s.add(row)
        row.tier = ns.tier
        row.strikes = ns.strikes
        row.clean_days = ns.clean_days
        row.last_day = ns.last_day
        if ev.allowed and ev.notice is not None:
            row.notice = ev.notice
        await self._s.commit()
        return ev

    async def pop_notice(self, user_id: int) -> str | None:
        row = await self._s.get(QuotaTier, user_id)
        if row is None or not row.notice:
            return None
        n = row.notice
        row.notice = None
        await self._s.commit()
        return n
