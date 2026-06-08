# P4 Token 记账 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans（Inline）。Steps 用 `- [ ]`。

**Goal:** 给登录用户记每日 Token：未命中以 DeepSeek 接口返回的 `usage` 为准，命中用缓存里记下的 token（缓存命中也记账），写入 `daily_usage`；popup 对登录用户显示「今日已用 N token」。

**Architecture:** `daily_usage(user_id, local_date, input_tokens, output_tokens, pages)` + `DailyUsageRepo`。`deepseek` 流加 `stream_options.include_usage`，把最后一块的 `usage` 作为 `Usage` 项 yield（`StreamItem = str | Usage`，内容仍是 str，旧 fake 不变）。`translator.translate` 累加 total（命中读 `CacheHit` 的 token，未命中读批次 `Usage`，无 Usage 时回退到本地估算），结束前 yield `UsageEvent(total_in,total_out)`。`/v1/translate` 端点收到 `UsageEvent` 时若已登录则写 `daily_usage`。`/v1/usage` 登录分支返回 `tokensToday`。

**约定：** commit 中文 + Co-Authored-By；后端 `uv run`，pytest 与 commit 分开。

---

## Task 1: daily_usage 模型 + 迁移 + 仓库

**Files:** `server/app/db/models.py`、迁移、`server/app/services/usage_repo.py`(新)、`server/tests/conftest.py`(TRUNCATE)、`server/tests/test_daily_usage.py`(新)

- [ ] **Step 1: 模型**（models.py 末尾）
```python
class DailyUsage(Base):
    """登录用户每日 Token 记账（含缓存命中归因）。pages = 当日翻译请求计数。"""
    __tablename__ = "daily_usage"
    user_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    local_date: Mapped[str] = mapped_column(String(10), primary_key=True)
    input_tokens: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    output_tokens: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    pages: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
```
- [ ] **Step 2: 迁移** — `uv run alembic revision --autogenerate -m "daily_usage" && uv run alembic upgrade head`
- [ ] **Step 3: conftest TRUNCATE 加 daily_usage**
- [ ] **Step 4: 写失败测试** `server/tests/test_daily_usage.py`
```python
from app.services.usage_repo import DailyUsageRepo


async def test_add_accumulates(db_session):
    repo = DailyUsageRepo(db_session)
    await repo.add(1, "2026-06-08", 100, 50, pages=1)
    await repo.add(1, "2026-06-08", 30, 20, pages=1)
    assert await repo.tokens_today(1, "2026-06-08") == 200  # 130 in + 70 out


async def test_isolated_per_user_day(db_session):
    repo = DailyUsageRepo(db_session)
    await repo.add(1, "2026-06-08", 10, 10, pages=1)
    assert await repo.tokens_today(2, "2026-06-08") == 0
    assert await repo.tokens_today(1, "2026-06-09") == 0
```
- [ ] **Step 5: 跑（红）**
- [ ] **Step 6: 写实现** `server/app/services/usage_repo.py`
```python
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import DailyUsage


class DailyUsageRepo:
    def __init__(self, session: AsyncSession) -> None:
        self._s = session

    async def add(self, user_id: int, local_date: str, input_tokens: int, output_tokens: int, pages: int = 0) -> None:
        stmt = insert(DailyUsage).values(
            user_id=user_id, local_date=local_date,
            input_tokens=input_tokens, output_tokens=output_tokens, pages=pages,
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
            select(DailyUsage).where(DailyUsage.user_id == user_id, DailyUsage.local_date == local_date)
        )
        return int((row.input_tokens + row.output_tokens) if row else 0)
```
- [ ] **Step 7: 跑（绿）** — 2 passed
- [ ] **Step 8: Commit** — `P4: daily_usage 模型 + 迁移 + DailyUsageRepo`

---

## Task 2: DeepSeek 捕获真实 usage

**Files:** `server/app/services/deepseek.py`、`server/tests/test_deepseek.py`

- [ ] **Step 1: 改测试**（usage 块 → Usage 项；内容仍 str）

`server/tests/test_deepseek.py` 把 `_sse` 与流测试改为带 usage 尾块，并断言能取到 `Usage`：
```python
from app.services.deepseek import Usage

def _sse(*contents: str) -> bytes:
    parts = ['data: {"choices":[{"delta":{"content":"%s"}}]}\n\n' % c for c in contents]
    parts.append('data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":7}}\n\n')
    parts.append("data: [DONE]\n\n")
    return "".join(parts).encode()


async def test_streams_content_and_usage():
    def handler(request): return httpx.Response(200, content=_sse("[[b1]] ", "你好"))
    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        items = [x async for x in stream_content_deltas(client, "k", [("b1", "Hi")])]
    text = "".join(x for x in items if isinstance(x, str))
    usages = [x for x in items if isinstance(x, Usage)]
    assert text == "[[b1]] 你好"
    assert usages and usages[0].input_tokens == 12 and usages[0].output_tokens == 7
```
（`test_request_body_locks_in_invariants` 增断言 `body["stream_options"] == {"include_usage": True}`；`test_401_raises_auth` 不变。）

- [ ] **Step 2: 跑（红）**
- [ ] **Step 3: 改实现** `server/app/services/deepseek.py`
  - 顶部加：
```python
from dataclasses import dataclass

@dataclass
class Usage:
    input_tokens: int
    output_tokens: int

StreamItem = str | Usage
```
  - `build_request_body` 加 `"stream_options": {"include_usage": True},`。
  - `stream_content_deltas` 返回类型 `AsyncIterator[StreamItem]`；解析每个 chunk：先取 `usage`（非空则 `yield Usage(...)`），再取 content delta（`yield delta`）。即把现有循环体改为：
```python
                try:
                    obj = json.loads(data)
                except json.JSONDecodeError:
                    continue
                usage = obj.get("usage")
                if usage:
                    yield Usage(int(usage.get("prompt_tokens", 0)), int(usage.get("completion_tokens", 0)))
                try:
                    delta = obj["choices"][0]["delta"].get("content")
                except (KeyError, IndexError):
                    delta = None
                if isinstance(delta, str) and delta:
                    yield delta
```
  - `stream_with_default_client` 的 yield 类型同步为 `StreamItem`（`async for item in ...: yield item`）。
- [ ] **Step 4: 跑（绿）**
- [ ] **Step 5: Commit** — `P4: DeepSeek 流捕获真实 usage（stream_options.include_usage）`

---

## Task 3: translator 记账 + UsageEvent

**Files:** `server/app/services/translator.py`、`server/tests/test_translator.py`

- [ ] **Step 1: 改测试**
  - import `UsageEvent` 与 `from app.services.deepseek import Usage`。
  - 既有用例的 `drain` 结果现在含 `UsageEvent`，断言不受影响（它们查 `BlockEvent in evs` / `DoneEvent`）。
  - 新增两例：
```python
async def test_usage_event_from_cache_hits():
    cache = FakeCache({"Hello": CacheHit("你好", 5, 3, 1)})
    async def ds(api_key, blocks):
        if False: yield ""  # 不会被调用
    evs = await drain(translate([SourceBlock("b1","Hello")], cache=cache, deepseek_stream=ds, api_key="k"))
    u = next(e for e in evs if isinstance(e, UsageEvent))
    assert u.input_tokens == 5 and u.output_tokens == 3  # 命中也记账


async def test_usage_event_from_model_real_usage():
    cache = FakeCache()
    async def ds(api_key, blocks):
        for bid, _ in blocks:
            yield f"[[{bid}]] 你好"
        yield Usage(40, 12)
    evs = await drain(translate([SourceBlock("b1","Hi")], cache=cache, deepseek_stream=ds, api_key="k"))
    u = next(e for e in evs if isinstance(e, UsageEvent))
    assert u.input_tokens == 40 and u.output_tokens == 12  # 未命中用真实 usage
```
- [ ] **Step 2: 跑（红）**
- [ ] **Step 3: 改实现** `server/app/services/translator.py`
  - 加事件类型：
```python
@dataclass(frozen=True)
class UsageEvent:
    input_tokens: int
    output_tokens: int

Event = BlockEvent | DoneEvent | ErrorEvent | UsageEvent
```
  - import `from app.services.deepseek import Usage`（仅类型/运行期 isinstance）。
  - `translate`：维护 `total_in/total_out`。命中循环里 `total_in += hit.input_tokens; total_out += hit.output_tokens`。全命中分支在 DoneEvent 前 `yield UsageEvent(total_in, total_out)`。
  - `run_batch`：把 `async for delta in deepseek_stream(...)` 改为 `async for item in ...`，`Usage` 项存 `batch_usage`，否则 `splitter.feed(item)`。批末若 `batch_usage` 非空累加真实值到 nonlocal `miss_in/miss_out`，否则累加该批 `estimate_tokens(source)+estimate_tokens(translated)` 之和（回退）。
  - gather 后 `total_in += miss_in; total_out += miss_out`，在 DoneEvent / ErrorEvent 前 `yield UsageEvent(total_in, total_out)`。（错误分支也先发 UsageEvent，记已成功部分。）
- [ ] **Step 4: 跑（绿）**
- [ ] **Step 5: Commit** — `P4: translator Token 记账（命中读缓存/未命中读真实 usage）+ UsageEvent`

---

## Task 4: 端点写 daily_usage + /v1/usage 返回 tokensToday

**Files:** `server/app/routers/translate.py`、`server/app/routers/usage.py`、`server/tests/test_translate_endpoint.py`、`server/tests/test_usage_endpoint.py`

- [ ] **Step 1: translate 端点处理 UsageEvent**
  - import `UsageEvent`、`from app.services.usage_repo import DailyUsageRepo`。
  - 加依赖 `get_daily_usage`（async_session → DailyUsageRepo）。端点签名加 `daily=Depends(get_daily_usage)`。
  - `gen()` 里 import 分支：`elif isinstance(ev, UsageEvent): ` → 若 `user_id is not None`：`await daily.add(user_id, local_date, ev.input_tokens, ev.output_tokens, pages=1)`（不转发 SSE）。
- [ ] **Step 2: usage 端点登录返回 tokensToday**
  - 登录分支改为：`tokens = await daily.tokens_today(user_id, local_date); return {"loggedIn": True, "tokensToday": tokens}`（加 `daily=Depends(get_daily_usage)` 与 local_date 计算）。
- [ ] **Step 3: 补测试**
  - `test_translate_endpoint.py`：覆盖 `get_daily_usage` 为 fake（记录 add 调用），登录态翻译后断言 fake.add 被调用且 tokens>0。
  - `test_usage_endpoint.py`：覆盖 daily fake，登录态断言返回含 `tokensToday`。
- [ ] **Step 4: 全量后端（绿）** — `uv run pytest -q`
- [ ] **Step 5: Commit** — `P4: 端点写 daily_usage + /v1/usage 返回 tokensToday`

---

## Task 5: 客户端 popup 显示今日 token

**Files:** `entrypoints/popup/App.tsx`

- [ ] **Step 1: usage 类型 + 渲染**
  - `PopupState.usage` 类型改为：`{ loggedIn: boolean; used?: number; limit?: number | null; remaining?: number | null; tokensToday?: number } | null`。
  - foot-hint 登录分支：`已登录 · 今日 ${s.usage.tokensToday ?? 0} token`。
- [ ] **Step 2: 编译** — `pnpm compile`
- [ ] **Step 3: Commit** — `P4 客户端: popup 显示登录用户今日 token`

---

## Task 6: 端到端验证

- [ ] **Step 1: 后端全量 + 客户端单测/编译**
- [ ] **Step 2: curl** —— 注册拿 access；翻一个新页（未命中→真实 usage 记账）；**再翻同页**（命中→缓存 token 也记账，tokensToday 继续增长）；`/v1/usage` 看 `tokensToday`：
```bash
cd server && uv run uvicorn app.main:app --port 8000 --log-level warning &
sleep 2
ACC=$(curl -s -d '{"email":"p4@x.com","password":"pw12345"}' -H 'Content-Type: application/json' http://localhost:8000/v1/auth/register | python3 -c "import sys,json;print(json.load(sys.stdin)['access'])")
T(){ curl -s -N -H 'Content-Type: application/json' -H "Authorization: Bearer $ACC" -H 'X-Device-Id: p4-dev' -d "{\"blocks\":[{\"id\":\"b1\",\"source\":\"You must call fetch() before rendering.\"}],\"pageKey\":\"$1\",\"localDate\":\"2026-06-08\"}" http://localhost:8000/v1/translate >/dev/null; curl -s -H "Authorization: Bearer $ACC" -H 'X-Device-Id: p4-dev' "http://localhost:8000/v1/usage?localDate=2026-06-08"; echo; }
echo "首译(未命中):"; T pa
echo "重译同页(命中):"; T pa
psql -h localhost -p 5432 -d imt -tAc "select input_tokens,output_tokens,pages from daily_usage;" ; psql -h localhost -p 5432 -d imt -tAc "delete from users where email='p4@x.com';" >/dev/null
kill %1
```
Expected: 首译后 `tokensToday` > 0（真实 usage）；重译同页后 `tokensToday` 进一步增大（命中也记账）；daily_usage 行 pages=2。
- [ ] **Step 3:** 合并 main（fast-forward），删分支。

---

## Self-Review
- 覆盖设计 P4：未命中真实 usage、命中缓存 token、daily_usage、缓存命中归因、popup 今日 token。
- 兼容：`StreamItem=str|Usage` 使旧 deepseek/translator fake（只 yield str）仍可用，未命中无 Usage 时回退本地估算。
- 类型一致：`Usage`、`UsageEvent`、`DailyUsageRepo.add/tokens_today`。
- 已知后续：P5 据 daily_usage 做按日上限分档限流；popup token 展示为只读，无需交互。
