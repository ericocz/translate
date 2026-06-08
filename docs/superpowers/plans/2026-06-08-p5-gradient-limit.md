# P5 梯度限流 Implementation Plan

> REQUIRED SUB-SKILL: superpowers:executing-plans（Inline）。

**Goal:** 登录用户按「固定日 Token 上限」分档限流：达上限即拦截并提醒；连续顶格逐级降档（降日上限），连续达标逐级升档（回升），升降档与拦截都提醒。

**Architecture:** `quota_tier(user_id, tier, strikes, clean_days, last_day, notice)`。纯函数 `evaluate_tier(state, today, tokens_today, prev_day_tokens)` 做跨日结算 + 档位迁移 + 当日是否超限判定（CAPS=[200k,50k,10k]）。`TierRepo.evaluate(user_id, local_date)` 读 daily_usage（今日 + 上一活跃日）→ 跑纯函数 → 持久化（升降档/降档提醒文案写 notice 列供 /v1/usage 取走）。`/v1/translate` 登录路径在翻译前 evaluate：超限→发 `quota` 事件（带提醒文案）+ 不翻；未超限照常翻。`/v1/usage` 登录返回 `cap`/`tokensToday`/`notice`（读后清空）。客户端 popup 显示 `今日 N/cap token` + notice 提醒。

**约定：** commit 中文 + Co-Authored-By；后端 `uv run`，pytest 与 commit 分开。

---

## Task 1: quota_tier 模型 + 迁移

**Files:** `server/app/db/models.py`、迁移、`server/tests/conftest.py`(TRUNCATE)

- [ ] **Step 1: 模型**（末尾）
```python
class QuotaTier(Base):
    """登录用户梯度限流状态机：tier 决定日 Token 上限；strikes/clean_days 累计跨日表现。"""
    __tablename__ = "quota_tier"
    user_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    tier: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    strikes: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    clean_days: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    last_day: Mapped[str | None] = mapped_column(String(10), nullable=True)
    notice: Mapped[str | None] = mapped_column(String(255), nullable=True)
```
- [ ] **Step 2: 迁移** `uv run alembic revision --autogenerate -m "quota_tier" && uv run alembic upgrade head`
- [ ] **Step 3: conftest TRUNCATE 加 quota_tier**
- [ ] **Step 4: Commit** — `P5: quota_tier 模型 + 迁移`

---

## Task 2: 纯函数 evaluate_tier（状态机）

**Files:** `server/app/services/tier.py`(新)、`server/tests/test_tier.py`(新)

- [ ] **Step 1: 写失败测试** `server/tests/test_tier.py`
```python
from app.services.tier import TierState, evaluate_tier, CAPS, STRIKE_THRESHOLD, RECOVER_THRESHOLD


def test_first_request_allowed_tier0():
    ev = evaluate_tier(TierState(0, 0, 0, None), "2026-06-08", tokens_today=0, prev_day_tokens=0)
    ev2 = ev.state
    assert ev.allowed and ev.cap == CAPS[0] and ev2.last_day == "2026-06-08"


def test_over_cap_blocks_with_notice():
    ev = evaluate_tier(TierState(0, 0, 0, "2026-06-08"), "2026-06-08", tokens_today=CAPS[0], prev_day_tokens=0)
    assert not ev.allowed and ev.notice


def test_consecutive_capped_days_downgrade():
    # 第 1 个顶格日结算
    s = TierState(0, 0, 0, "2026-06-08")
    e1 = evaluate_tier(s, "2026-06-09", tokens_today=0, prev_day_tokens=CAPS[0])  # 昨天顶格
    assert e1.state.tier == 0 and e1.state.strikes == 1
    # 第 2 个顶格日结算 → 降档
    e2 = evaluate_tier(e1.state, "2026-06-10", tokens_today=0, prev_day_tokens=CAPS[0])
    assert e2.state.tier == 1 and e2.cap == CAPS[1] and e2.notice


def test_consecutive_clean_days_upgrade():
    s = TierState(1, 0, 0, "2026-06-08")
    cur = s
    day = 9
    for _ in range(RECOVER_THRESHOLD):
        cur = evaluate_tier(cur, f"2026-06-{day:02d}", tokens_today=0, prev_day_tokens=0).state
        day += 1
    # 达标累计够 → 已升回 tier 0
    assert cur.tier == 0


def test_same_day_repeated_no_extra_strike():
    s = TierState(0, 0, 0, "2026-06-08")
    e = evaluate_tier(s, "2026-06-08", tokens_today=CAPS[0] + 100, prev_day_tokens=0)
    assert not e.allowed and e.state.strikes == 0  # 同日不累计 strike（跨日才结算）
```
- [ ] **Step 2: 跑（红）**
- [ ] **Step 3: 写实现** `server/app/services/tier.py`
```python
from dataclasses import dataclass

CAPS = [200_000, 50_000, 10_000]   # tier 0/1/2 的日 Token 上限（可后续按真实分布调参）
STRIKE_THRESHOLD = 2                # 连续顶格天数 → 降档
RECOVER_THRESHOLD = 3              # 连续达标天数 → 升档
RECOVER_FRACTION = 0.5            # 当日用量 < 50% cap 视为达标


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
    """跨日结算（依上一活跃日表现累计 strike/clean_days 并迁移档位）+ 今日是否超限。"""
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
```
- [ ] **Step 4: 跑（绿）** — 5 passed
- [ ] **Step 5: Commit** — `P5: evaluate_tier 状态机（纯函数）`

---

## Task 3: TierRepo（DB 读 daily_usage + 持久化 + notice）

**Files:** `server/app/services/tier_repo.py`(新)、`server/tests/test_tier_repo.py`(新)

- [ ] **Step 1: 写失败测试** `server/tests/test_tier_repo.py`
```python
from app.services.tier_repo import TierRepo
from app.services.usage_repo import DailyUsageRepo
from app.services.tier import CAPS


async def test_under_cap_allowed(db_session):
    repo = TierRepo(db_session)
    ev = await repo.evaluate(1, "2026-06-08")
    assert ev.allowed and ev.cap == CAPS[0]


async def test_over_cap_blocks(db_session):
    await DailyUsageRepo(db_session).add(1, "2026-06-08", CAPS[0], 0, pages=1)
    repo = TierRepo(db_session)
    ev = await repo.evaluate(1, "2026-06-08")
    assert not ev.allowed and ev.notice


async def test_notice_persisted_and_cleared(db_session):
    repo = TierRepo(db_session)
    # 人为构造：昨天顶格两天 → 降档时写 notice。先塞两天顶格用量并推进 last_day。
    du = DailyUsageRepo(db_session)
    await du.add(1, "2026-06-08", CAPS[0], 0, pages=1)
    await repo.evaluate(1, "2026-06-08")            # last_day=08
    await du.add(1, "2026-06-09", CAPS[0], 0, pages=1)
    await repo.evaluate(1, "2026-06-09")            # 结算 08 顶格 → strike1
    await du.add(1, "2026-06-10", CAPS[0], 0, pages=1)
    await repo.evaluate(1, "2026-06-10")            # 结算 09 顶格 → 降档 + notice
    n1 = await repo.pop_notice(1)
    assert n1 is not None
    assert await repo.pop_notice(1) is None         # 读后清空
```
- [ ] **Step 2: 跑（红）**
- [ ] **Step 3: 写实现** `server/app/services/tier_repo.py`
```python
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import DailyUsage, QuotaTier
from app.services.tier import TierEval, TierState, evaluate_tier


class TierRepo:
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
        # 升降档提醒（仍放行时）写入 notice 列，供 /v1/usage 取走；拦截时的提醒由端点经 quota 事件即时下发。
        notice_to_store = ev.notice if ev.allowed else None
        if row is None:
            row = QuotaTier(user_id=user_id)
            self._s.add(row)
        row.tier, row.strikes, row.clean_days, row.last_day = ns.tier, ns.strikes, ns.clean_days, ns.last_day
        if notice_to_store is not None:
            row.notice = notice_to_store
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
```
- [ ] **Step 4: 跑（绿）**
- [ ] **Step 5: Commit** — `P5: TierRepo（读 daily_usage + 迁移持久化 + notice 取放）`

---

## Task 4: 端点接入限流 + /v1/usage 返回 cap/notice

**Files:** `server/app/routers/translate.py`、`server/app/routers/usage.py`、对应测试

- [ ] **Step 1: translate 登录路径限流**
  - import `from app.services.tier_repo import TierRepo`；加 `get_tier` 依赖（async_session → TierRepo）。端点签名加 `tier=Depends(get_tier)`。
  - 在 `decision`（匿名配额）之后、`gen` 之前加：
```python
    tier_block_msg = None
    if user_id is not None:
        tev = await tier.evaluate(user_id, local_date)
        if not tev.allowed:
            tier_block_msg = tev.notice
```
  - `gen()` 顶部（匿名 decision 判定之后）加：
```python
        if tier_block_msg is not None:
            yield _sse("quota", {"message": tier_block_msg})
            return
```
  - 注意：登录用户被限流时也走 `quota` 事件（与匿名同一客户端通道）。
- [ ] **Step 2: /v1/usage 登录返回 cap + notice**
  - import `get_tier`；登录分支改为：
```python
    if user_id is not None:
        tokens = await daily.tokens_today(user_id, local_date)
        tev = await tier.evaluate(user_id, local_date)   # 也驱动跨日结算
        notice = await tier.pop_notice(user_id)
        return {"loggedIn": True, "tokensToday": tokens, "cap": tev.cap, "notice": notice}
```
  （usage 端点加 `tier=Depends(get_tier)`。）
- [ ] **Step 3: 测试**
  - `test_translate_endpoint.py`：FakeTier（evaluate 返回 allowed=False）覆盖 `get_tier`，登录态断言只发 quota、不译。再加 allowed=True 的 FakeTier 进 override 夹具（默认放行）。
  - `test_usage_endpoint.py`：FakeTier（evaluate 返回 cap、pop_notice 返回文案）覆盖，登录断言返回含 cap/notice。
- [ ] **Step 4: 全量后端（绿）**
- [ ] **Step 5: Commit** — `P5: 端点接入梯度限流 + /v1/usage 返回 cap/notice`

---

## Task 5: 客户端 popup 显示 cap/notice

**Files:** `entrypoints/popup/App.tsx`

- [ ] **Step 1:** usage 类型加 `cap?: number | null; notice?: string | null`。foot-hint 登录分支：`已登录 · 今日 ${tokensToday}/${cap ?? '∞'} token`。若 `s.usage?.notice` 存在，状态行额外用柔和样式显示该 notice（复用 `.status` + `.dot--off`）。
- [ ] **Step 2: 编译** — `pnpm compile`
- [ ] **Step 3: Commit** — `P5 客户端: popup 显示今日 token/cap 与限流提醒`

---

## Task 6: 端到端验证 + 合并

- [ ] **Step 1: 后端全量 + 客户端单测/编译**
- [ ] **Step 2: curl** —— 把某用户的 quota_tier 直接造成低档（或临时把 CAPS[0] 调极小验证拦截路径），验证超限发 quota；恢复 CAPS。更稳的做法：直接对 TierRepo 行为已被单测覆盖，这里只 curl 验证「登录正常翻译放行」+ usage 返回 cap 字段：
```bash
cd server && uv run uvicorn app.main:app --port 8000 --log-level warning &
sleep 2
ACC=$(curl -s -d '{"email":"p5@x.com","password":"pw12345"}' -H 'Content-Type: application/json' http://localhost:8000/v1/auth/register | python3 -c "import sys,json;print(json.load(sys.stdin)['access'])")
curl -s -N -H 'Content-Type: application/json' -H "Authorization: Bearer $ACC" -H 'X-Device-Id: p5-dev' -d '{"blocks":[{"id":"b1","source":"Submit"}],"pageKey":"pp","localDate":"2026-06-08"}' http://localhost:8000/v1/translate | grep -oE 'event: (block|done|quota)' | tr '\n' ' '; echo
echo "usage:"; curl -s -H "Authorization: Bearer $ACC" -H 'X-Device-Id: p5-dev' "http://localhost:8000/v1/usage?localDate=2026-06-08"; echo
psql -h localhost -p 5432 -d imt -tAc "delete from users where email='p5@x.com';" >/dev/null
kill %1
```
Expected: 正常翻译 `block done`；usage 返回 `loggedIn:true` 含 `cap`、`tokensToday`、`notice:null`。
- [ ] **Step 3: 合并 main，删分支。**

---

## Self-Review
- 覆盖设计 P5：固定日 Token 上限信号、分档（CAPS）、连续顶格降档、连续达标升档、拦截/升降档提醒。
- 状态机为纯函数、单测覆盖关键迁移；TierRepo 读 daily_usage 做跨日结算（懒触发，无需定时任务）。
- 提醒：拦截即时经 `quota` 事件下发；升降档（仍放行）经 quota_tier.notice → /v1/usage 取走 → popup 显示。
- 已知后续：CAPS/阈值为占位、上线按真实分布调参（开放项）；跨日结算依赖用户「来访」触发，长期不来访不影响（下次来时结算）。
