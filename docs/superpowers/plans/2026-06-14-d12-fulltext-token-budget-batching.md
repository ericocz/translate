# D-12 全文翻译 · Token 预算分批 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 取消固定 40 块分批，改为「按估算输出 token 装箱」，正常文章一次请求、超长文才透明分片，且不再因块多而被模型 `max_tokens` 截断丢尾。

**Architecture:** 新增一个纯函数 `batch_by_token_budget(blocks, budget)` 替换 translator 里 `model_blocks[i:i+BATCH_SIZE]` 的按数装箱；用 `estimate_tokens(source)` 作为每块输出 token 的代理估算（译文与原文 token 量级相当）。同时在 `build_request_body` 显式设 `max_tokens`，使截断行为确定，并令装箱预算 `OUTPUT_TOKEN_BUDGET` < `MAX_OUTPUT_TOKENS` 留安全余量。并发/queue 合流/usage 记账机制全部不动。

**Tech Stack:** Python 3.12 · FastAPI · pytest（pytest-asyncio auto 模式，纯函数 + 现有 `translate()` 事件流测试）

**Decision source:** 产品蓝图 V2 §2 D-12（`产品蓝图V2-商业化.html`）。

---

## File Structure

- `server/app/services/translator.py` — 新增纯函数 `batch_by_token_budget`；删 `BATCH_SIZE`、加 `OUTPUT_TOKEN_BUDGET`；第 109 行装箱改调新函数。
- `server/app/services/deepseek.py` — 加 `MAX_OUTPUT_TOKENS` 常量；`build_request_body` 加 `max_tokens`。
- `server/tests/test_translator.py` — 加 `batch_by_token_budget` 单测 + 「正常页一次请求」集成测试。
- `server/tests/test_deepseek.py` — 加 `build_request_body` 含 `max_tokens` 的断言。
- `server/CLAUDE.md` — 铁律 #3 文字从「~40 块分批」改为「token 预算装箱」。

**装箱契约（锁定，后续任务引用同一签名/语义）：**
`batch_by_token_budget(blocks: list[tuple[str, str]], budget: int) -> list[list[tuple[str, str]]]`
- 顺序保持；累计 `estimate_tokens(src)` 超 `budget` 即开新箱。
- 单块自身超 `budget`：独占一箱（块是原子的，拆块会破坏 `<gN>` 标记）。
- 空输入 → `[]`。

---

### Task 1: 纯函数 `batch_by_token_budget`

**Files:**
- Modify: `server/app/services/translator.py`（加函数，import 已有 `estimate_tokens`）
- Test: `server/tests/test_translator.py`

- [ ] **Step 1: Write the failing tests**

在 `server/tests/test_translator.py` 顶部 import 区把 `translate` 那组 import 补上 `batch_by_token_budget`：

```python
from app.services.translator import (
    BlockEvent,
    DoneEvent,
    SourceBlock,
    UsageEvent,
    batch_by_token_budget,
    translate,
)
```

在文件末尾追加（注：`estimate_tokens` 对 ASCII 是 `ceil(len/4)`，所以 8 个 `a` = 2 token，便于构造确定用例）：

```python
def _ids(batches):
    return [[bid for bid, _ in batch] for batch in batches]


def test_batch_empty():
    assert batch_by_token_budget([], 100) == []


def test_batch_all_under_budget_single_batch():
    blocks = [("b1", "hello"), ("b2", "world")]
    assert batch_by_token_budget(blocks, 1000) == [blocks]  # 全装一箱 → 一次请求


def test_batch_accumulates_until_budget():
    # 每块 "aaaaaaaa"(8 ASCII)=2 token；budget=5 → 每箱最多 2 块（2+2=4≤5，再+2=6>5）
    blocks = [(f"b{i}", "aaaaaaaa") for i in range(1, 6)]
    assert _ids(batch_by_token_budget(blocks, 5)) == [["b1", "b2"], ["b3", "b4"], ["b5"]]


def test_batch_single_oversized_block_alone():
    big = "a" * 400  # ceil(400/4)=100 token
    blocks = [("b1", "aaaa"), ("b2", big), ("b3", "aaaa")]  # 1,100,1 token；budget=10
    assert _ids(batch_by_token_budget(blocks, 10)) == [["b1"], ["b2"], ["b3"]]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && uv run pytest tests/test_translator.py -k batch -v`
Expected: FAIL with `ImportError: cannot import name 'batch_by_token_budget'`（或 NameError）。

- [ ] **Step 3: Write minimal implementation**

在 `server/app/services/translator.py`，把第 14–16 行的常量：

```python
# 单请求块数上限：过多会超出模型输出 max_tokens 被截断，尾部块永远译不出。
BATCH_SIZE = 40
CONCURRENCY = 4
```

替换为：

```python
# 单请求「估算输出 token」预算：装箱上限，低于 deepseek.MAX_OUTPUT_TOKENS 留安全余量，
# 避免一次发太多块、输出超模型 max_tokens 被截断丢尾。正常文章整篇估算 < 此值 → 一次请求（D-12）。
OUTPUT_TOKEN_BUDGET = 6500
CONCURRENCY = 4


def batch_by_token_budget(
    blocks: list[tuple[str, str]], budget: int
) -> list[list[tuple[str, str]]]:
    """按估算输出 token 把 (id, source) 块顺序装箱，每箱累计 estimate_tokens(source) ≤ budget。

    - 译文与原文 token 量级相当，故用 estimate_tokens(source) 代理输出量；budget 已留安全余量。
    - 单块自身超 budget：独占一箱（块是原子的，拆块会破坏 <gN> 标记）。
    - 空输入 → []。
    """
    batches: list[list[tuple[str, str]]] = []
    current: list[tuple[str, str]] = []
    current_tokens = 0
    for bid, src in blocks:
        t = estimate_tokens(src)
        if current and current_tokens + t > budget:
            batches.append(current)
            current = []
            current_tokens = 0
        current.append((bid, src))
        current_tokens += t
    if current:
        batches.append(current)
    return batches
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && uv run pytest tests/test_translator.py -k batch -v`
Expected: 4 个用例 PASS。

- [ ] **Step 5: Commit**

```bash
cd server && git add app/services/translator.py tests/test_translator.py
git commit -m "feat(translator): token 预算装箱纯函数 batch_by_token_budget（D-12）"
```

---

### Task 2: `translate()` 改用 token 预算装箱

**Files:**
- Modify: `server/app/services/translator.py:109`（装箱调用）
- Test: `server/tests/test_translator.py`

- [ ] **Step 1: Write the failing test**

在 `server/tests/test_translator.py` 末尾追加（验证 D-12 的核心承诺：正常一页只发一次请求）：

```python
async def test_normal_page_is_single_request():
    cache = FakeCache()
    sent_batches: list[list[str]] = []

    async def deepseek(api_key, blocks):
        sent_batches.append([bid for bid, _ in blocks])
        for bid, _ in blocks:
            yield f"[[{bid}]] 译"

    # 30 个普通短块（远小于 OUTPUT_TOKEN_BUDGET）→ 必须只装一箱、只发一次
    blocks = [SourceBlock(f"b{i}", f"hello world {i}") for i in range(30)]
    await drain(translate(blocks, cache=cache, deepseek_stream=deepseek, api_key="k"))
    assert len(sent_batches) == 1
    assert len(sent_batches[0]) == 30
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && uv run pytest tests/test_translator.py::test_normal_page_is_single_request -v`
Expected: FAIL —— 现有 `BATCH_SIZE`/`model_blocks[i:i+BATCH_SIZE]` 已被 Task 1 删除（`NameError: BATCH_SIZE`），`translate()` 暂时跑不通。

- [ ] **Step 3: Write minimal implementation**

在 `server/app/services/translator.py`，把第 108–109 行：

```python
    # 3) 分批 + 有限并发，结果经 queue 合流回送
    batches = [model_blocks[i:i + BATCH_SIZE] for i in range(0, len(model_blocks), BATCH_SIZE)]
```

替换为：

```python
    # 3) 按 token 预算装箱 + 有限并发，结果经 queue 合流回送
    batches = batch_by_token_budget(model_blocks, OUTPUT_TOKEN_BUDGET)
```

- [ ] **Step 4: Run the full translator suite**

Run: `cd server && uv run pytest tests/test_translator.py -v`
Expected: 全部 PASS（新 `test_normal_page_is_single_request` + Task 1 的 4 个 batch 用例 + 原有 7 个 translate 用例都绿；原用例每个 source 都小，仍是一箱，去重/usage/缓存语义不变）。

- [ ] **Step 5: Commit**

```bash
cd server && git add app/services/translator.py tests/test_translator.py
git commit -m "feat(translator): translate() 改用 token 预算装箱、删 BATCH_SIZE（D-12）"
```

---

### Task 3: `build_request_body` 显式 `max_tokens`

**Files:**
- Modify: `server/app/services/deepseek.py`（加常量 + body 字段）
- Test: `server/tests/test_deepseek.py`

- [ ] **Step 1: Write the failing test**

在 `server/tests/test_deepseek.py` 末尾追加：

```python
from app.services.deepseek import MAX_OUTPUT_TOKENS, build_request_body


def test_request_body_sets_explicit_max_tokens():
    body = build_request_body([("b1", "hi")])
    # 显式设 max_tokens，令截断行为确定；须 ≥ translator 的 OUTPUT_TOKEN_BUDGET
    assert body["max_tokens"] == MAX_OUTPUT_TOKENS
    assert MAX_OUTPUT_TOKENS >= 6500
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && uv run pytest tests/test_deepseek.py::test_request_body_sets_explicit_max_tokens -v`
Expected: FAIL —— `ImportError: cannot import name 'MAX_OUTPUT_TOKENS'`。

- [ ] **Step 3: Write minimal implementation**

在 `server/app/services/deepseek.py`，第 10 行 `DEEPSEEK_URL = ...` 之后加常量：

```python
# DeepSeek V4 Flash 输出上限：显式设定使「超长被截断」行为确定，并与 translator.OUTPUT_TOKEN_BUDGET
# 配合（后者 < 此值、留安全余量）。⚠️ 上线前以 DeepSeek 官方 max_tokens 实际上限校准本值。
MAX_OUTPUT_TOKENS = 384000
```

在 `build_request_body` 返回的 dict 里，`"temperature": 0.2,` 那行之后加一行：

```python
        "max_tokens": MAX_OUTPUT_TOKENS,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && uv run pytest tests/test_deepseek.py -v`
Expected: 全部 PASS（新断言 + 原有 deepseek 用例）。

- [ ] **Step 5: Commit**

```bash
cd server && git add app/services/deepseek.py tests/test_deepseek.py
git commit -m "feat(deepseek): build_request_body 显式 max_tokens（D-12 配合 token 预算）"
```

---

### Task 4: 文档同步（server/CLAUDE.md 铁律 #3）

**Files:**
- Modify: `server/CLAUDE.md`（铁律 #3）

- [ ] **Step 1: 改铁律措辞**

在 `server/CLAUDE.md` 把这一行：

```
3. **分批 ~40 块 + 有限并发**（避免输出超 `max_tokens` 截断）；**按 source 去重**。
```

改为：

```
3. **按 token 预算装箱 + 有限并发**（`batch_by_token_budget`：累计 `estimate_tokens(src)` ≤ `OUTPUT_TOKEN_BUDGET`，正常文章一次请求、超长才分片，配合 `deepseek.MAX_OUTPUT_TOKENS` 防截断）；**按 source 去重**。
```

- [ ] **Step 2: 全量回归**

Run: `cd server && uv run pytest`
Expected: 全绿（确认 D-12 改动未波及其他用例）。

- [ ] **Step 3: Commit**

```bash
cd server && git add CLAUDE.md
git commit -m "docs(server): 铁律 #3 改为 token 预算装箱（D-12）"
```

---

## Self-Review

**1. Spec coverage（蓝图 D-12）：**
- 「取消固定 40 块分批」→ Task 1 删 `BATCH_SIZE`、Task 2 改装箱调用 ✓
- 「单次整篇 + token 预算自动分片」→ `batch_by_token_budget` + Task 2 集成测试「正常页一次请求」 ✓
- 「仅会超输出上限/尾部漏译时才透明分片」→ 装箱上限 `OUTPUT_TOKEN_BUDGET` < `MAX_OUTPUT_TOKENS`，单块超预算独占一箱 ✓
- 「阈值=V4 实际输出上限，实现时定」→ Task 3 常量带 ⚠️ 校准注释 ✓

**2. Placeholder scan：** 无 TBD/TODO；每个改码步骤都给了完整代码与确切命令。

**3. Type consistency：** 全程用同一签名 `batch_by_token_budget(list[tuple[str,str]], int) -> list[list[tuple[str,str]]]`；常量名 `OUTPUT_TOKEN_BUDGET`（translator）/`MAX_OUTPUT_TOKENS`（deepseek）前后一致；`OUTPUT_TOKEN_BUDGET=6500 < MAX_OUTPUT_TOKENS=384000` 满足 Task 3 断言。

**遗留（不属本计划，下一份 D-11 处理）：** 客户端本地 IndexedDB 缓存、取消服务端缓存、命中本地不扣费。
