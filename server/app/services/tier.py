from dataclasses import dataclass

CAPS = [200_000, 50_000, 10_000]   # tier 0/1/2 的日 Token 上限（占位，后续按真实分布调参）
STRIKE_THRESHOLD = 2               # 连续顶格天数 → 降档
RECOVER_THRESHOLD = 3              # 连续达标天数 → 升档
RECOVER_FRACTION = 0.5             # 当日用量 < 50% cap 视为达标


def _cap(tier: int) -> int:
    return CAPS[min(max(tier, 0), len(CAPS) - 1)]


@dataclass
class TierState:
    tier: int
    strikes: int
    clean_days: int
    last_day: str | None


@dataclass
class TierEval:
    state: TierState
    allowed: bool
    cap: int
    notice: str | None


def evaluate_tier(state: TierState, today: str, tokens_today: int, prev_day_tokens: int) -> TierEval:
    """跨日结算（依上一活跃日表现累计 strike/clean_days 并迁移档位）+ 今日是否超限。

    懒触发：跨日结算只在「新的一天首次来访」时发生，无需定时任务；长期不来访不影响，
    下次来访时按上一活跃日结算。同一天内反复超限不重复累计 strike（仅拦截）。
    """
    tier, strikes, clean_days = state.tier, state.strikes, state.clean_days
    notice: str | None = None

    if state.last_day is not None and state.last_day != today:
        prev_cap = _cap(tier)
        if prev_day_tokens >= prev_cap:
            strikes += 1
            clean_days = 0
        elif prev_day_tokens < RECOVER_FRACTION * prev_cap:
            clean_days += 1
            strikes = 0
        if strikes >= STRIKE_THRESHOLD and tier < len(CAPS) - 1:
            tier += 1
            strikes = 0
            clean_days = 0
            notice = "检测到异常用量，额度已临时下调"
        elif clean_days >= RECOVER_THRESHOLD and tier > 0:
            tier -= 1
            clean_days = 0
            strikes = 0
            notice = "用量已恢复正常，额度已回升"

    cap = _cap(tier)
    allowed = tokens_today < cap
    if not allowed and notice is None:
        notice = "今日额度已达上限（疑似异常用量），明日恢复"
    return TierEval(TierState(tier, strikes, clean_days, today), allowed, cap, notice)
