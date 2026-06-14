# D-11（服务端侧）取消跨用户缓存 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 服务端不再持有翻译缓存（隐私=不在我方留存用户内容），`translate()` 只翻译收到的块、只对实际翻译的用量记账；删除 `translation_cache` 表与相关代码。

**Architecture:** 客户端将在 Plan 2（D-11b）加 IndexedDB 本地缓存、命中的块根本不发到服务端，因此服务端的「缓存优先 + 命中也记账」整层下线。`translate()` 去掉 `cache` 参数、去重后直接装箱翻译；UsageEvent 只含模型真实用量（接口 `usage`，缺失时 `estimate_tokens` 兜底）。`cache.py` / `TranslationCache` 模型 / `translation_cache` 表一并移除。

**Tech Stack:** Python 3.12 · FastAPI · SQLAlchemy 2.0 async · Alembic · pytest（纯函数 + ASGITransport 端点测试，均不依赖真实 DB）

**Decision source:** 产品蓝图 V2 §2 D-11 + §7 缓存节（`产品蓝图V2-商业化.html`）。

**Scope note:** 本计划只做服务端。「命中本地不扣费」的承诺由客户端只发未命中块来兑现 —— 见后续 D-11b（前端 IndexedDB L1）。

---

## File Structure

- `server/app/services/translator.py` — `translate()` 去掉 `cache` 参数与缓存收发；删 `CacheLike` Protocol、`is_verbatim_echo` 用法。
- `server/app/routers/translate.py` — 去掉 `get_cache` 依赖、`TranslationCacheRepo` import、调用处 `cache=cache`。
- `server/app/services/cache.py` — 删除整文件。
- `server/app/db/models.py` — 删 `TranslationCache` 模型。
- `server/alembic/versions/b9d2c1f4e7a3_drop_translation_cache.py` — 新增：drop 表（downgrade 重建）。
- `server/tests/test_translator.py` — 重写：去 FakeCache、删 3 个缓存专属用例。
- `server/tests/test_translate_endpoint.py` — 去 FakeCache 与 `get_cache` override。
- `server/tests/test_cache.py` — 删除整文件。
- `server/CLAUDE.md` — 缓存相关铁律 #5/#6 与数据模型行更新。

---

### Task 1: `translate()` 去缓存层

**Files:**
- Modify: `server/app/services/translator.py`
- Test: `server/tests/test_translator.py`（重写）

- [ ] **Step 1: 重写 translator 测试（先红）**

把 `server/tests/test_translator.py` 顶部 import 块（`from app.services.cache import CacheHit` 那行起）整体替换为：

```python
from app.services.deepseek import Usage
from app.services.translator import (
    BlockEvent,
    DoneEvent,
    SourceBlock,
    UsageEvent,
    batch_by_token_budget,
    translate,
)


async def drain(gen):
    return [ev async for ev in gen]


def fake_deepseek(scripted: dict[str, str]):
    """deepseek_stream 替身：按块 id 直接吐 `[[id]] 译文`。"""
    async def _stream(api_key, blocks):
        for bid, _src in blocks:
            yield f"[[{bid}]] {scripted.get(bid, '')}"
    return _stream
```

然后把文件中**所有** `translate(...)` 调用里的 `cache=cache,` 参数删掉，并删除这三个缓存专属测试函数（连同它们的 `FakeCache` 依赖）：`test_full_cache_hit_no_model_call`、`test_verbatim_echo_not_cached`、`test_usage_event_from_cache_hits`。其余测试改成下面这版（用它们整体替换 `test_miss_calls_model_and_caches` 到 `test_usage_event_from_model_real_usage` 之间的旧内容；batch 与 single-request 用例保持不变）：

```python
async def test_translates_and_emits_block():
    evs = await drain(translate(
        [SourceBlock("b1", "Hello")],
        deepseek_stream=fake_deepseek({"b1": "你好"}), api_key="k",
    ))
    assert BlockEvent("b1", "你好") in evs
    assert any(isinstance(e, DoneEvent) for e in evs)


async def test_dedupe_same_source_translated_once():
    sent_batches = []

    async def deepseek(api_key, blocks):
        sent_batches.append([b[0] for b in blocks])
        for bid, _ in blocks:
            yield f"[[{bid}]] 提交"

    evs = await drain(translate(
        [SourceBlock("b1", "Submit"), SourceBlock("b2", "Submit")],
        deepseek_stream=deepseek, api_key="k",
    ))
    assert sum(len(b) for b in sent_batches) == 1  # 同 source 只发一个代表块
    assert BlockEvent("b1", "提交") in evs and BlockEvent("b2", "提交") in evs


async def test_invalid_markers_still_emitted():
    # source 无标记，译文凭空冒 <g0> → 校验失败但仍回送（客户端再校验）
    evs = await drain(translate(
        [SourceBlock("b1", "Hello")],
        deepseek_stream=fake_deepseek({"b1": "<g0>你好</g0>"}), api_key="k",
    ))
    assert BlockEvent("b1", "<g0>你好</g0>") in evs


async def test_usage_event_estimates_when_no_api_usage():
    # 接口没给 usage → est 兜底，input/output 估算 > 0
    evs = await drain(translate(
        [SourceBlock("b1", "Hello")],
        deepseek_stream=fake_deepseek({"b1": "你好世界"}), api_key="k",
    ))
    u = next(e for e in evs if isinstance(e, UsageEvent))
    assert u.input_tokens > 0 and u.output_tokens > 0


async def test_usage_event_from_model_real_usage():
    async def ds(api_key, blocks):
        for bid, _ in blocks:
            yield f"[[{bid}]] 你好"
        yield Usage(40, 12)

    evs = await drain(translate([SourceBlock("b1", "Hi")], deepseek_stream=ds, api_key="k"))
    u = next(e for e in evs if isinstance(e, UsageEvent))
    assert u.input_tokens == 40 and u.output_tokens == 12  # 真实 usage 优先于估算
```

并把 `test_normal_page_is_single_request` 里的 `translate(blocks, cache=cache, ...)` 改成 `translate(blocks, deepseek_stream=deepseek, api_key="k")`、删掉它的 `cache = FakeCache()` 行。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && uv run pytest tests/test_translator.py -v`
Expected: FAIL —— `translate()` 仍要求 `cache` 关键字参数（`TypeError: translate() missing ... 'cache'`）。

- [ ] **Step 3: 改 translate() 去缓存**

在 `server/app/services/translator.py`：

(a) 删掉这两个 import 用法 —— 把第 8–12 行的 markers import 改为（去掉 `is_verbatim_echo`）：

```python
from app.services.markers import allowed_ids_from_source, validate_markers
```

(b) 删除 `CacheLike` Protocol（`class CacheLike(Protocol): ...` 整段）与未用的 `Protocol` import（把第 3 行 `from typing import AsyncIterator, Callable, Protocol` 改为 `from typing import AsyncIterator, Callable`）。

(c) 用下面整段替换现有的 `async def translate(...)` 整个函数（从 `async def translate(` 到函数末尾 `yield DoneEvent()`）：

```python
async def translate(
    blocks: list[SourceBlock],
    *,
    deepseek_stream: DeepSeekStream,
    api_key: str,
) -> AsyncIterator[Event]:
    """去重 → token 预算装箱 + 有限并发 → 切块 → 标记校验 → 逐块 yield 事件。

    D-11：服务端不再持有缓存（隐私=不留存用户内容）；客户端 IndexedDB 命中的块根本不发到这里。
    服务端只翻译收到的块、只对实际翻译的用量记账（接口 usage 优先，缺失时本地估算兜底）。
    - 流式：每块译好即 yield（经 queue 合流）。
    - 失败隔离：单批失败不打断其余；只有「一块都没成功」才整体 ErrorEvent。
    - 原样回显 / 校验不过的块：仍回送（客户端再校验）。
    """
    if not blocks:
        yield DoneEvent()
        return

    # 1) 按 source 去重：代表块发模型，译文广播给共享同 source 的所有 id
    by_source: dict[str, list[str]] = {}
    rep_source: dict[str, str] = {}  # rep_id -> source
    model_blocks: list[tuple[str, str]] = []
    for b in blocks:
        if b.source in by_source:
            by_source[b.source].append(b.id)
            continue
        by_source[b.source] = [b.id]
        rep_source[b.id] = b.source
        model_blocks.append((b.id, b.source))

    # 2) 按 token 预算装箱 + 有限并发，结果经 queue 合流回送
    batches = batch_by_token_budget(model_blocks, OUTPUT_TOKEN_BUDGET)
    queue: asyncio.Queue = asyncio.Queue()
    sem = asyncio.Semaphore(CONCURRENCY)
    success = 0
    last_error: ErrorEvent | None = None
    used_in = 0
    used_out = 0

    async def run_batch(batch: list[tuple[str, str]]) -> None:
        nonlocal success, last_error, used_in, used_out
        async with sem:
            collected: list[tuple[str, str]] = []
            splitter = BlockSplitter(lambda i, t: collected.append((i, t)))
            batch_usage: Usage | None = None
            try:
                async for item in deepseek_stream(api_key, batch):
                    if isinstance(item, Usage):
                        batch_usage = item  # 最后一块的真实用量
                    else:
                        splitter.feed(item)
                splitter.flush()
            except Exception as e:  # DeepSeekError 等：单批失败不打断其余
                last_error = ErrorEvent(getattr(e, "kind", "unknown"), getattr(e, "message", str(e)))
                return
            est_in = 0
            est_out = 0
            for rep_id, translated in collected:
                source = rep_source.get(rep_id)
                if source is None:
                    continue  # 模型乱编 id：忽略
                for bid in by_source[source]:
                    await queue.put(BlockEvent(bid, translated))
                if validate_markers(translated, allowed_ids_from_source(source)).ok:
                    success += 1
                est_in += estimate_tokens(source)
                est_out += estimate_tokens(translated)
            # 记账：优先真实 usage；接口没给时回退本地估算之和。
            if batch_usage is not None:
                used_in += batch_usage.input_tokens
                used_out += batch_usage.output_tokens
            else:
                used_in += est_in
                used_out += est_out

    async def producer() -> None:
        await asyncio.gather(*(run_batch(b) for b in batches))
        await queue.put(None)  # 哨兵：通知消费端结束

    task = asyncio.create_task(producer())
    while True:
        item = await queue.get()
        if item is None:
            break
        yield item
    await task

    yield UsageEvent(used_in, used_out)
    # 全失败才报错；部分成功照常结束（未成功的块留待下次刷新重试）。
    if success == 0 and last_error is not None:
        yield last_error
    else:
        yield DoneEvent()
```

(d) 把 `UsageEvent` 的 docstring（第 70 行附近）从「命中读缓存 token + 未命中读真实 usage」改为：

```python
    """本次请求应计入用户当日用量的 token（接口真实 usage 优先，缺失时本地估算兜底）。"""
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && uv run pytest tests/test_translator.py -v`
Expected: 全部 PASS（batch 4 + single-request 1 + 上面 5 个 translate 用例）。

- [ ] **Step 5: Commit**

```bash
cd server && git add app/services/translator.py tests/test_translator.py
git commit -m "refactor(translator): 去服务端缓存层、只对实际翻译记账（D-11）"
```

---

### Task 2: 端点去掉缓存依赖注入

**Files:**
- Modify: `server/app/routers/translate.py`
- Test: `server/tests/test_translate_endpoint.py`

- [ ] **Step 1: 改端点测试（先红 / 防回归）**

在 `server/tests/test_translate_endpoint.py`：删掉 `get_cache` 这个 import（第 9–15 行 import 块里去掉 `get_cache,` 一行）、删掉 `FakeCache` 整个类（第 19–27 行）、删掉 fixture 里 `app.dependency_overrides[get_cache] = lambda: FakeCache()` 一行。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && uv run pytest tests/test_translate_endpoint.py -v`
Expected: FAIL —— `ImportError: cannot import name 'get_cache'`（端点仍定义并依赖它，但测试已先删 import 触发收集错误前，端点未改）。实际此步是确保测试与端点同步改：先让 import 失败暴露依赖。

- [ ] **Step 3: 改端点去缓存**

在 `server/app/routers/translate.py`：

(a) 删掉 import：`from app.services.cache import TranslationCacheRepo`（第 12 行）。

(b) 删掉 `get_cache` 依赖函数整段（第 46–49 行的 `async def get_cache() -> ...: ... yield TranslationCacheRepo(s)`）。

(c) 端点签名去掉 `cache=Depends(get_cache),`（第 76 行）。

(d) 调用处去掉 `cache=cache,`，即把

```python
        async for ev in translate(
            blocks,
            cache=cache,
            deepseek_stream=deepseek_stream,
            api_key=settings.deepseek_api_key,
        ):
```

改为

```python
        async for ev in translate(
            blocks,
            deepseek_stream=deepseek_stream,
            api_key=settings.deepseek_api_key,
        ):
```

(e) 把 UsageEvent 分支那行注释（第 122 行）「含缓存命中归因」改为「只计实际翻译用量」：

```python
                # 登录用户记当日 token（只计服务端实际翻译的用量）；匿名不记 daily_usage（走页配额）。
```

- [ ] **Step 4: 跑端点测试确认通过**

Run: `cd server && uv run pytest tests/test_translate_endpoint.py -v`
Expected: 5 个端点用例全 PASS（`test_logged_in_records_daily_usage` 仍 >0：fake_stream 无 usage、走 estimate 兜底）。

- [ ] **Step 5: Commit**

```bash
cd server && git add app/routers/translate.py tests/test_translate_endpoint.py
git commit -m "refactor(translate endpoint): 去掉缓存依赖注入（D-11）"
```

---

### Task 3: 删除缓存模块 / 模型 / 表

**Files:**
- Delete: `server/app/services/cache.py`、`server/tests/test_cache.py`
- Modify: `server/app/db/models.py`（删 `TranslationCache`）
- Create: `server/alembic/versions/b9d2c1f4e7a3_drop_translation_cache.py`

- [ ] **Step 1: 删文件 + 删模型**

```bash
cd server && git rm app/services/cache.py tests/test_cache.py
```

在 `server/app/db/models.py` 删除 `class TranslationCache(Base): ...` 整个类（从 `class TranslationCache` 到它最后一个字段 `last_access` 的 `mapped_column(...)` 结束、下一个 `class` 之前）。若删除后 `models.py` 顶部某些 import（如 `Integer`）变为未使用，保留即可（其他模型仍在用 `Integer`/`BigInteger`/`Text`/`String`/`DateTime`/`func`）。

- [ ] **Step 2: 写删表迁移**

创建 `server/alembic/versions/b9d2c1f4e7a3_drop_translation_cache.py`：

```python
"""drop translation_cache (D-11：服务端不再持有缓存)

Revision ID: b9d2c1f4e7a3
Revises: c0dcd9df17ec
Create Date: 2026-06-14

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b9d2c1f4e7a3'
down_revision: Union[str, Sequence[str], None] = 'c0dcd9df17ec'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_table('translation_cache')


def downgrade() -> None:
    op.create_table(
        'translation_cache',
        sa.Column('key', sa.String(length=80), nullable=False),
        sa.Column('translated', sa.Text(), nullable=False),
        sa.Column('input_tokens', sa.Integer(), nullable=False),
        sa.Column('output_tokens', sa.Integer(), nullable=False),
        sa.Column('hits', sa.BigInteger(), nullable=False),
        sa.Column('last_access', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('key'),
    )
```

- [ ] **Step 3: 验证 import 不残留 + 测试不依赖该表**

Run: `cd server && uv run python -c "import app.main" && uv run pytest tests/test_translator.py tests/test_translate_endpoint.py -q`
Expected: 导入成功（无对 `cache`/`TranslationCache` 的悬空引用）；两套测试 PASS（conftest 用 `Base.metadata` 建表，模型已删 → 不再建该表，测试本就不碰它）。

- [ ] **Step 4: 应用迁移到 dev 库（需本机 Postgres.app `imt` 已起）**

Run: `cd server && uv run alembic upgrade head`
Expected: 执行到 `b9d2c1f4e7a3`，`translation_cache` 表被删。
（若 dev DB 未起，可跳过本步，迁移文件已提交、下次起库再 `upgrade head`。）

- [ ] **Step 5: Commit**

```bash
cd server && git add app/db/models.py alembic/versions/b9d2c1f4e7a3_drop_translation_cache.py
git commit -m "refactor(db): 删除 translation_cache 模型/仓库/测试 + 删表迁移（D-11）"
```

---

### Task 4: 全量回归 + 文档同步

**Files:**
- Modify: `server/CLAUDE.md`

- [ ] **Step 1: 全量测试**

Run: `cd server && uv run pytest`
Expected: 全绿（test_cache.py 已删；其余不受影响）。

- [ ] **Step 2: 改 server/CLAUDE.md**

(a) 铁律 #5「标记平衡校验……通过才入缓存；原样回显不入缓存」改为：

```
5. **标记平衡校验**（`markers.py`，与客户端等价）——校验决定 `success` 计数与「全失败才报错」；服务端不再写缓存（D-11）。
```

(b) 铁律 #6「真实 usage……命中读缓存里记的 token，**命中也记账**」改为：

```
6. **真实 usage**：请求带 `stream_options.include_usage`，取末块 `usage` 计 Token，接口缺失时 `estimate_tokens` 兜底；**服务端只对实际翻译的块记账**（命中本地缓存的块由客户端拦下、根本不发服务端，D-11）。
```

(c) 数据模型行删掉 `translation_cache`（内容寻址 + token 列 + LRU）一项，并在该段末补一句：

```
（D-11：原 `translation_cache` 跨用户共享缓存已下线——隐私上不在服务端留存用户译文；缓存改为客户端 IndexedDB 本地层，见 front。）
```

- [ ] **Step 3: Commit**

```bash
cd server && git add CLAUDE.md
git commit -m "docs(server): 缓存铁律/数据模型同步 D-11（服务端去缓存）"
```

---

## Self-Review

**1. Spec coverage（D-11 服务端侧）：** 「取消服务端跨用户缓存」→ Task 1（translate 去缓存）+ Task 3（删模块/表）✓；「只对实际翻译记账」→ Task 1 UsageEvent=used_in/out ✓；隐私「不留存内容」→ Task 3 drop 表 ✓。客户端「命中不扣费」属 D-11b，本计划 Scope note 已标。

**2. Placeholder scan：** 无 TBD；每步给完整代码/命令；删除步骤指明确切类/行范围。

**3. Type consistency：** `translate()` 新签名 `(blocks, *, deepseek_stream, api_key)` 在 translator + 端点 + 两处测试一致；`UsageEvent(used_in, used_out)`；迁移 down_revision `c0dcd9df17ec`（现 HEAD）。

**遗留（D-11b 另起计划）：** 前端 IndexedDB L1 缓存（先查本地、只发未命中、写回）+ 设置可关可清。
