# 后端 P0 基座 + P1 翻译流水线（服务端侧） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `server/` 子目录建一个 FastAPI + Postgres 后端，把现有客户端翻译流水线（提示词/DeepSeek 调用/标记校验/去重/分批/缓存）等价移植到服务端，对外提供 `POST /v1/translate` 的 SSE 流式接口，并以 pytest 全程 TDD 覆盖。

**Architecture:** 分层 `core`（配置/提示词/哈希/token 估算）· `db`（SQLAlchemy 模型 + 仓库）· `services`（markers/切块/deepseek/cache/translator）· `routers`（SSE 端点）。翻译编排是把 `lib/translator.ts` + `lib/deepseek.ts` 用 async Python 重写——逐条保住铁律：稳定系统提示词前缀、`thinking:disabled`、~40 块分批 + 有限并发、按 source 去重、`[[id]]` 流式切块（正则含 `.`）、标记平衡校验、原样回显不入缓存。纯逻辑单元用 fake 注入测试（无网络无 DB）；缓存仓库对 docker Postgres 做集成测试；端点用 ASGI transport + 依赖覆盖测试。

**Tech Stack:** Python 3.12（uv 锁定）· FastAPI · uvicorn · httpx（异步流式调 DeepSeek）· SQLAlchemy 2.0 async + asyncpg · Alembic · pydantic-settings · pytest + pytest-asyncio。Dev DB 用 docker compose 起 postgres:16，映射宿主 `:5433`（避开本机已运行的 `:5432`）。

**约定：** 本仓库 commit message 用中文；每条 commit 末尾追加一行 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`（下文 commit 步骤为简洁省略该行，执行时务必带上）。本计划只做**后端**；扩展改调后端的客户端接线是紧接着的第二份计划。

**关键移植参照（只读，勿改）：** `lib/prompt.ts`（SYSTEM_PROMPT 逐字节）· `lib/markers.ts`（tokenizeMarkers/validateMarkers/allowedIdsFromSource）· `lib/deepseek.ts`（请求体 + SSE + createBlockSplitter）· `lib/translator.ts`（缓存优先→去重→分批→并发→校验→写缓存→isVerbatimEcho）· `lib/cache.ts`（版本键 + LRU 思路）。

**设计偏差（相对设计文档，已确认合理）：** 服务端内容寻址键改用 `sha256` 而非客户端历史的 `cyrb53`——旧客户端 IndexedDB 缓存本就废弃、服务端缓存全新且空，无需哈希互通，`sha256` 更稳更省心。键格式 `"{version}:{sha256(source)[:16]}"`，`version = sha256(MODEL + "\0" + SYSTEM_PROMPT)[:12]`。

---

## 文件结构（本计划创建/修改）

```
server/
  pyproject.toml            # uv 工程 + 依赖
  .python-version           # 3.12
  .gitignore                # .venv / __pycache__ / .env
  .env.example              # DEEPSEEK_API_KEY / DATABASE_URL 占位
  docker-compose.yml        # postgres:16 dev DB（:5433）
  alembic.ini
  alembic/env.py            # async 迁移环境
  alembic/versions/*.py     # 首条迁移：translation_cache
  app/
    main.py                 # FastAPI app + /health + 挂载 routers
    core/config.py          # Settings（pydantic-settings）
    core/prompt.py          # SYSTEM_PROMPT 常量（移植）
    core/hashing.py         # version_key / key_of（sha256）
    core/tokens.py          # estimate_tokens（轻量估算）
    db/base.py              # Base / engine / async_session
    db/models.py            # TranslationCache 模型
    services/markers.py     # tokenize/validate/allowed_ids_from_source（移植）
    services/block_splitter.py  # BlockSplitter（移植，正则含 .）
    services/deepseek.py    # 请求体 + 异步 SSE + 错误分类
    services/cache.py       # TranslationCacheRepo（get_many/set_many/LRU）
    services/translator.py  # 编排：异步事件流
    routers/translate.py    # POST /v1/translate（SSE）
  tests/
    conftest.py             # 事件循环 / DB 引擎 / fake 夹具
    test_markers.py  test_block_splitter.py  test_tokens.py
    test_hashing.py  test_deepseek.py  test_cache.py
    test_translator.py  test_translate_endpoint.py
```

每个 `app/<pkg>/` 目录需有 `__init__.py`（空文件，首个相关任务里一并 `mkdir`/创建）。

---

## Task 1: uv 工程骨架 + FastAPI 健康检查

**Files:**
- Create: `server/pyproject.toml`, `server/.python-version`, `server/.gitignore`, `server/.env.example`
- Create: `server/app/__init__.py`, `server/app/main.py`, `server/app/core/__init__.py`, `server/app/core/config.py`
- Test: `server/tests/__init__.py`, `server/tests/test_health.py`, `server/tests/conftest.py`

- [ ] **Step 1: 初始化 uv 工程与依赖**

```bash
cd server
uv venv --python 3.12
uv add fastapi "uvicorn[standard]" httpx "sqlalchemy>=2.0" asyncpg alembic pydantic-settings
uv add --dev pytest pytest-asyncio
```

预期：生成 `.venv/`、`pyproject.toml`、`uv.lock`。`.python-version` 若未生成则手动写入 `3.12`。

- [ ] **Step 2: 写 `pyproject.toml` 的 pytest 配置 + `.gitignore` + `.env.example`**

在 `server/pyproject.toml` 末尾追加：

```toml
[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
```

`server/.gitignore`：

```
.venv/
__pycache__/
*.pyc
.env
.pytest_cache/
```

`server/.env.example`：

```
# DeepSeek 上游 Key（绝不提交真值；复制为 .env 后填入，与仓库根 .env 的 WXT_DEEPSEEK_API_KEY 同一把）
DEEPSEEK_API_KEY=sk-xxx
# 开发库（docker compose 起的 postgres，映射宿主 5433）
DATABASE_URL=postgresql+asyncpg://imt:imt@localhost:5433/imt
```

- [ ] **Step 3: 写配置与应用**

`server/app/__init__.py`、`server/app/core/__init__.py`、`server/tests/__init__.py`：空文件。

`server/app/core/config.py`：

```python
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    deepseek_api_key: str = ""
    database_url: str = "postgresql+asyncpg://imt:imt@localhost:5433/imt"


settings = Settings()
```

`server/app/main.py`：

```python
from fastapi import FastAPI

app = FastAPI(title="Immersive Translate Backend")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
```

`server/tests/conftest.py`：

```python
import httpx
import pytest
from httpx import ASGITransport

from app.main import app


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
```

- [ ] **Step 4: 写健康检查测试**

`server/tests/test_health.py`：

```python
async def test_health_ok(client):
    resp = await client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}
```

- [ ] **Step 5: 跑测试，预期通过**

Run: `cd server && uv run pytest tests/test_health.py -v`
Expected: PASS（1 passed）

- [ ] **Step 6: Commit**

```bash
git add server/
git commit -m "P0: FastAPI 骨架 + uv 工程 + 健康检查"
```

---

## Task 2: 内容哈希与版本键（sha256 移植）

**Files:**
- Create: `server/app/core/prompt.py`, `server/app/core/hashing.py`
- Test: `server/tests/test_hashing.py`

- [ ] **Step 1: 写失败测试**

`server/tests/test_hashing.py`：

```python
from app.core.hashing import key_of, VERSION


def test_key_is_stable_and_versioned():
    k1 = key_of("Hello world")
    k2 = key_of("Hello world")
    assert k1 == k2                      # 同源稳定
    assert k1.startswith(VERSION + ":")  # 版本前缀
    assert key_of("Hello world") != key_of("Hello world!")  # 不同源不同键


def test_version_is_short_hex():
    assert len(VERSION) == 12
    int(VERSION, 16)  # 必须是合法 hex，否则抛错
```

- [ ] **Step 2: 跑测试，预期失败**

Run: `cd server && uv run pytest tests/test_hashing.py -v`
Expected: FAIL（ModuleNotFoundError: app.core.hashing）

- [ ] **Step 3: 写提示词常量与哈希**

`server/app/core/prompt.py`（从 `lib/prompt.ts` 逐字节移植 SYSTEM_PROMPT；改一个字符即令前缀缓存失效，勿动）：

```python
# 系统提示词：唯一来源，逐字节稳定。任何动态内容都不得拼入。
SYSTEM_PROMPT = """你是一名资深中文技术译者，为中国工程师翻译英文网页内容。

翻译风格：
- 页面上每一处英文都要译成中文，包括导航、按钮、菜单项等很短的界面标签（如 new→最新、submit→提交、past→往期）。除代码、标识符、专有名词外，不要把英文原样照抄返回。
- 译意不译字面；把英文长从句拆成自然的中文短句。
- 保留代码、标识符、以及中文技术圈惯用的英文术语（如 token、prompt、API、commit）原样不译。
- 仅在原文读者也会陌生的概念处，用极简的括号补一句解释；不画蛇添足。
- 语气是有经验的工程师讲给同行听，避免机翻腔。

格式标记规则：
- 形如 <g0>…</g0> 的成对标记、<x0/> 的自闭合标记代表原文内联样式，必须原样保留，绝不翻译标记本身。
- 每个开标记必须与同编号的闭标记成对出现；为符合中文语序可移动或嵌套成对标记，但不得新增编号、不得拆散一对、不得修改编号。
- <x0/> 代表一个无文字的内联对象，放到中文里语义对应的位置即可。

输出格式：
- 输入由若干带编号的块组成，每块形如 [[id]] 原文。
- 逐块输出译文，每块以 [[id]] 开头后接该块译文，id 与输入一致。
- 不要输出原文，不要输出任何前言、说明或总结。"""
```

`server/app/core/hashing.py`：

```python
import hashlib

from app.core.prompt import SYSTEM_PROMPT

MODEL = "deepseek-v4-flash"


def _sha(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


# 版本前缀：模型 / 提示词任一变化 → 前缀变化 → 旧缓存自动失效。
VERSION = _sha(MODEL + " " + SYSTEM_PROMPT)[:12]


def key_of(source: str) -> str:
    """内容寻址缓存键：版本 + source 哈希。"""
    return f"{VERSION}:{_sha(source)[:16]}"
```

- [ ] **Step 4: 跑测试，预期通过**

Run: `cd server && uv run pytest tests/test_hashing.py -v`
Expected: PASS（2 passed）

- [ ] **Step 5: Commit**

```bash
git add server/app/core/prompt.py server/app/core/hashing.py server/tests/test_hashing.py
git commit -m "P1: 系统提示词常量 + sha256 内容寻址键"
```

---

## Task 3: 标记词法与校验（markers.ts 移植）

**Files:**
- Create: `server/app/services/__init__.py`, `server/app/services/markers.py`
- Test: `server/tests/test_markers.py`

- [ ] **Step 1: 写失败测试**（覆盖 `lib/markers.ts` 的关键分支）

`server/tests/test_markers.py`：

```python
from app.services.markers import (
    validate_markers,
    allowed_ids_from_source,
    is_verbatim_echo,
)


def test_valid_paired_and_void():
    assert validate_markers("在<g1>渲染</g1>前调用 <g0>fetch()</g0><x2/>", {0, 1, 2}).ok


def test_nesting_ok_crossing_fails():
    assert validate_markers("<g0><g1>x</g1></g0>", {0, 1}).ok
    assert not validate_markers("<g0><g1>x</g0></g1>", {0, 1}).ok  # 交叉


def test_unknown_id_rejected():
    assert not validate_markers("<g5>x</g5>", {0, 1}).ok


def test_malformed_lexeme_rejected():
    assert not validate_markers("<g0/>裸自闭成对标记", {0}).ok   # <gN/> 畸形
    assert not validate_markers("< g0 >空格", {0}).ok            # 形似标记残留


def test_void_duplicate_rejected():
    assert not validate_markers("<x0/><x0/>", {0}).ok


def test_omission_allowed():
    # 允许省略无意义的成对包装：allowedIds 不强求全部出现
    assert validate_markers("纯译文无标记", {0, 1}).ok


def test_allowed_ids_from_source():
    assert allowed_ids_from_source("<x0/><g1>a</g1><g3>b</g3>") == {0, 1, 3}


def test_verbatim_echo():
    assert is_verbatim_echo("Hello  world", "Hello world")  # 归一化空白后相同
    assert not is_verbatim_echo("Hello world", "你好世界")
```

- [ ] **Step 2: 跑测试，预期失败**

Run: `cd server && uv run pytest tests/test_markers.py -v`
Expected: FAIL（ModuleNotFoundError）

- [ ] **Step 3: 写实现**（移植 `lib/markers.ts`）

`server/app/services/__init__.py`：空文件。

`server/app/services/markers.py`：

```python
import re
from dataclasses import dataclass

# 唯一标记词法：< (前导 /?) (g|x) (数字) (后随 /?) >
_MARKER_RE = re.compile(r"<(/?)([gx])(\d+)(/?)>")
# 形似标记但夹空格 / 大小写不规范——兜底拒绝
_LOOSE_RE = re.compile(r"<\s*/?\s*[gx]\s*\d+\s*/?\s*>", re.IGNORECASE)


@dataclass
class _Tok:
    kind: str  # text | open | close | void
    n: int = -1
    text: str = ""


def _tokenize(s: str) -> list[_Tok] | None:
    """切成 token 序列；任一标记落在四种合法形态之外即整块非法 → None。"""
    tokens: list[_Tok] = []
    last = 0
    for m in _MARKER_RE.finditer(s):
        if m.start() > last:
            tokens.append(_Tok("text", text=s[last:m.start()]))
        lead, kind, num, trail = m.group(1), m.group(2), m.group(3), m.group(4)
        n = int(num)
        if kind == "g" and lead == "" and trail == "":
            tokens.append(_Tok("open", n))
        elif kind == "g" and lead == "/" and trail == "":
            tokens.append(_Tok("close", n))
        elif kind == "x" and lead == "" and trail == "/":
            tokens.append(_Tok("void", n))
        else:
            return None  # <gN/> / <xN> / </xN> 等畸形
        last = m.end()
    if last < len(s):
        tokens.append(_Tok("text", text=s[last:]))
    for t in tokens:
        if t.kind == "text" and _LOOSE_RE.search(t.text):
            return None  # 残留形似标记
    return tokens


@dataclass
class ValidateResult:
    ok: bool
    reason: str = ""


def validate_markers(translated: str, allowed_ids: set[int]) -> ValidateResult:
    tokens = _tokenize(translated)
    if tokens is None:
        return ValidateResult(False, "标记词法非法")
    stack: list[int] = []
    void_seen: set[int] = set()
    for t in tokens:
        if t.kind == "text":
            continue
        if t.n not in allowed_ids:
            return ValidateResult(False, f"未知标记编号 {t.n}")
        if t.kind == "open":
            stack.append(t.n)
        elif t.kind == "close":
            top = stack.pop() if stack else None
            if top != t.n:
                return ValidateResult(False, f"成对标记交叉或未匹配 g{t.n}")
        else:  # void
            if t.n in void_seen:
                return ValidateResult(False, f"自闭合标记 x{t.n} 重复")
            void_seen.add(t.n)
    if stack:
        return ValidateResult(False, "未关闭的成对标记")
    return ValidateResult(True)


def allowed_ids_from_source(source: str) -> set[int]:
    """从 source 反推出现过的标记编号（服务端无 styleMap，据此做与客户端等价的校验）。"""
    return {int(m.group(3)) for m in _MARKER_RE.finditer(source)}


def is_verbatim_echo(source: str, translated: str) -> bool:
    """译文是否只把 source 原样照抄（空翻译）：归一化空白后逐字相同。"""
    norm = lambda s: re.sub(r"\s+", " ", s).strip()
    return norm(source) == norm(translated)
```

- [ ] **Step 4: 跑测试，预期通过**

Run: `cd server && uv run pytest tests/test_markers.py -v`
Expected: PASS（8 passed）

- [ ] **Step 5: Commit**

```bash
git add server/app/services/__init__.py server/app/services/markers.py server/tests/test_markers.py
git commit -m "P1: 标记词法/校验/allowedIds/verbatim 移植（markers.ts → Python）"
```

---

## Task 4: 流式切块器（createBlockSplitter 移植，正则含 `.`）

**Files:**
- Create: `server/app/services/block_splitter.py`
- Test: `server/tests/test_block_splitter.py`

- [ ] **Step 1: 写失败测试**（重现历史坑：标记被拆散、带点 id）

`server/tests/test_block_splitter.py`：

```python
from app.services.block_splitter import BlockSplitter


def collect(chunks: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    sp = BlockSplitter(lambda i, t: out.__setitem__(i, t))
    for c in chunks:
        sp.feed(c)
    sp.flush()
    return out


def test_basic_two_blocks():
    assert collect(["[[b1]] 你好\n[[b2]] 世界"]) == {"b1": "你好", "b2": "世界"}


def test_marker_split_across_chunks():
    # 模型把 [[b1]] 拆成多个 delta —— 必须在完整缓冲上重扫
    assert collect(["[", "[", "b", "1", "]", "]", " 你好"]) == {"b1": "你好"}


def test_dotted_id_from_spa_or_settle():
    # 沉降补抽 / SPA 新路由的 id 形如 r2.b30，正则字符类必须含 .
    assert collect(["[[r2.b30]] 译文"]) == {"r2.b30": "译文"}


def test_preamble_before_first_marker_discarded():
    assert collect(["前言垃圾[[b1]] 正文"]) == {"b1": "正文"}
```

- [ ] **Step 2: 跑测试，预期失败**

Run: `cd server && uv run pytest tests/test_block_splitter.py -v`
Expected: FAIL（ModuleNotFoundError）

- [ ] **Step 3: 写实现**（移植 `lib/deepseek.ts` 的 createBlockSplitter）

`server/app/services/block_splitter.py`：

```python
import re
from typing import Callable

# id 字符类必须含 `.`：沉降补抽 / SPA 新路由块 id 形如 r2.b30；漏 `.` 会整批匹配不上。
_MARKER = re.compile(r"\[\[([A-Za-z0-9_.\-]+)\]\]")


class BlockSplitter:
    """按 [[id]] 切块。模型逐 token 返回、标记常被拆散，必须在完整缓冲 acc 上重扫，
    不能在单个 chunk 内就地判定边界。acc 始终保留最后一个标记及其之后（可能还在增长）的文本。"""

    def __init__(self, on_block: Callable[[str, str], None]) -> None:
        self._acc = ""
        self._on_block = on_block

    def feed(self, chunk: str) -> None:
        self._acc += chunk
        self._process(False)

    def flush(self) -> None:
        self._process(True)

    def _process(self, flush_all: bool) -> None:
        marks = [(m.group(1), m.start(), m.end()) for m in _MARKER.finditer(self._acc)]
        if not marks:
            return
        upto = len(marks) if flush_all else len(marks) - 1
        for i in range(upto):
            _id, _start, end = marks[i]
            text_end = marks[i + 1][1] if i + 1 < len(marks) else len(self._acc)
            self._on_block(_id, self._acc[end:text_end].strip())
        self._acc = "" if flush_all else self._acc[marks[-1][1]:]
```

- [ ] **Step 4: 跑测试，预期通过**

Run: `cd server && uv run pytest tests/test_block_splitter.py -v`
Expected: PASS（4 passed）

- [ ] **Step 5: Commit**

```bash
git add server/app/services/block_splitter.py server/tests/test_block_splitter.py
git commit -m "P1: 流式 [[id]] 切块器移植（正则含 . 防带点 id 整批丢失）"
```

---

## Task 5: token 估算器

**Files:**
- Create: `server/app/core/tokens.py`
- Test: `server/tests/test_tokens.py`

- [ ] **Step 1: 写失败测试**

`server/tests/test_tokens.py`：

```python
from app.core.tokens import estimate_tokens


def test_empty_is_zero():
    assert estimate_tokens("") == 0


def test_english_roughly_quarter_chars():
    # 纯 ASCII 约 chars/4，给一个宽松区间即可
    n = estimate_tokens("a" * 40)
    assert 8 <= n <= 12


def test_cjk_counts_more_than_english_same_len():
    assert estimate_tokens("你好世界") > estimate_tokens("abcd")


def test_monotonic():
    assert estimate_tokens("hello world foo") > estimate_tokens("hello")
```

- [ ] **Step 2: 跑测试，预期失败**

Run: `cd server && uv run pytest tests/test_tokens.py -v`
Expected: FAIL（ModuleNotFoundError）

- [ ] **Step 3: 写实现**（轻量估算，无需精确 tokenizer）

`server/app/core/tokens.py`：

```python
import math
import re

_CJK = re.compile(r"[㐀-鿿豈-﫿\U00020000-\U0002ffff]")


def estimate_tokens(text: str) -> int:
    """轻量本地 token 估算：CJK 字符按 ~0.6 token/字，其余 ASCII/符号按 ~4 char/token。
    用于给缓存条目记 token（命中归因），无需与上游 tokenizer 精确一致。"""
    if not text:
        return 0
    cjk = len(_CJK.findall(text))
    other = len(text) - cjk
    return math.ceil(cjk * 0.6 + other / 4)
```

- [ ] **Step 4: 跑测试，预期通过**

Run: `cd server && uv run pytest tests/test_tokens.py -v`
Expected: PASS（4 passed）

- [ ] **Step 5: Commit**

```bash
git add server/app/core/tokens.py server/tests/test_tokens.py
git commit -m "P1: 轻量 token 估算器（CJK/ASCII 近似）"
```

---

## Task 6: 数据库基座 + TranslationCache 模型 + Alembic 首迁移

**Files:**
- Create: `server/docker-compose.yml`, `server/app/db/__init__.py`, `server/app/db/base.py`, `server/app/db/models.py`
- Create: `server/alembic.ini`, `server/alembic/env.py`, `server/alembic/versions/0001_translation_cache.py`
- Test: `server/tests/test_cache.py`（本任务只放建表 smoke，仓库读写在 Task 7）

- [ ] **Step 1: 起 dev Postgres**

`server/docker-compose.yml`：

```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: imt
      POSTGRES_PASSWORD: imt
      POSTGRES_DB: imt
    ports:
      - "5433:5432"
    volumes:
      - imt_pg:/var/lib/postgresql/data
volumes:
  imt_pg:
```

Run: `cd server && docker compose up -d && sleep 3 && docker compose ps`
Expected: db 服务 healthy / Up，宿主 5433 可连。

- [ ] **Step 2: 写 DB 基座与模型**

`server/app/db/__init__.py`：空文件。

`server/app/db/base.py`：

```python
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.core.config import settings


class Base(DeclarativeBase):
    pass


engine = create_async_engine(settings.database_url, future=True)
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
```

`server/app/db/models.py`：

```python
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class TranslationCache(Base):
    """全局共享内容寻址翻译缓存；token 列供缓存命中记账（P4）。"""

    __tablename__ = "translation_cache"

    key: Mapped[str] = mapped_column(String(80), primary_key=True)
    translated: Mapped[str] = mapped_column(Text, nullable=False)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    hits: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    last_access: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
```

- [ ] **Step 3: 初始化 Alembic（async 模板）并改 env.py**

```bash
cd server && uv run alembic init -t async alembic
```

把生成的 `server/alembic.ini` 里 `sqlalchemy.url` 留空（改由 env.py 从 settings 注入）。

替换 `server/alembic/env.py` 的相关部分为（核心：用 settings.database_url + 我们的 Base.metadata）：

```python
import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy.ext.asyncio import create_async_engine

from app.core.config import settings
from app.db.base import Base
from app.db import models  # noqa: F401  注册模型

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)
target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(url=settings.database_url, target_metadata=target_metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    engine = create_async_engine(settings.database_url)
    async with engine.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
```

- [ ] **Step 4: 生成并应用首迁移**

```bash
cd server && uv run alembic revision --autogenerate -m "translation_cache" && uv run alembic upgrade head
```

预期：`alembic/versions/xxxx_translation_cache.py` 生成（重命名为 `0001_translation_cache.py` 便于排序），`translation_cache` 表建好。核对：

Run: `psql postgresql://imt:imt@localhost:5433/imt -c "\d translation_cache"`
Expected: 列出 key/translated/input_tokens/output_tokens/hits/last_access。

- [ ] **Step 5: 写建表 smoke 测试**（用 metadata.create_all 在测试库里建表，验证模型可用）

`server/tests/conftest.py` 追加（DB 夹具，测试用同一 dev 库、按表清理）：

```python
import pytest_asyncio
from sqlalchemy import text

from app.db.base import Base, engine, async_session


@pytest_asyncio.fixture
async def db_session():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with async_session() as s:
        yield s
    async with engine.begin() as conn:
        await conn.execute(text("TRUNCATE translation_cache"))
```

`server/tests/test_cache.py`：

```python
from sqlalchemy import select

from app.db.models import TranslationCache


async def test_can_insert_and_read_row(db_session):
    db_session.add(TranslationCache(key="v:abc", translated="你好"))
    await db_session.commit()
    row = (await db_session.execute(select(TranslationCache).where(TranslationCache.key == "v:abc"))).scalar_one()
    assert row.translated == "你好"
```

- [ ] **Step 6: 跑测试，预期通过**

Run: `cd server && uv run pytest tests/test_cache.py -v`
Expected: PASS（1 passed）

- [ ] **Step 7: Commit**

```bash
git add server/docker-compose.yml server/app/db/ server/alembic.ini server/alembic/ server/tests/conftest.py server/tests/test_cache.py
git commit -m "P0: Postgres 基座 + TranslationCache 模型 + Alembic 首迁移"
```

---

## Task 7: 翻译缓存仓库（get_many / set_many / LRU 命中刷新）

**Files:**
- Create: `server/app/services/cache.py`
- Test: `server/tests/test_cache.py`（追加）

- [ ] **Step 1: 追加失败测试**

`server/tests/test_cache.py` 追加：

```python
from app.services.cache import TranslationCacheRepo


async def test_set_then_get_many_roundtrip(db_session):
    repo = TranslationCacheRepo(db_session)
    await repo.set_many([
        {"source": "Hello", "translated": "你好", "input_tokens": 3, "output_tokens": 2},
    ])
    hits = await repo.get_many(["Hello", "Missing"])
    assert "Missing" not in hits
    assert hits["Hello"].translated == "你好"
    assert hits["Hello"].input_tokens == 3


async def test_get_many_bumps_hits(db_session):
    repo = TranslationCacheRepo(db_session)
    await repo.set_many([{"source": "X", "translated": "艾克斯", "input_tokens": 1, "output_tokens": 1}])
    await repo.get_many(["X"])
    again = await repo.get_many(["X"])
    assert again["X"].hits >= 1  # 命中累加


async def test_set_many_upsert_overwrites(db_session):
    repo = TranslationCacheRepo(db_session)
    await repo.set_many([{"source": "Y", "translated": "旧", "input_tokens": 1, "output_tokens": 1}])
    await repo.set_many([{"source": "Y", "translated": "新", "input_tokens": 2, "output_tokens": 2}])
    hits = await repo.get_many(["Y"])
    assert hits["Y"].translated == "新"
```

- [ ] **Step 2: 跑测试，预期失败**

Run: `cd server && uv run pytest tests/test_cache.py -v`
Expected: FAIL（ImportError: TranslationCacheRepo）

- [ ] **Step 3: 写实现**（内容寻址；命中刷新 hits/last_access；upsert）

`server/app/services/cache.py`：

```python
from dataclasses import dataclass

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import func

from app.core.hashing import key_of
from app.db.models import TranslationCache


@dataclass
class CacheHit:
    translated: str
    input_tokens: int
    output_tokens: int
    hits: int


class TranslationCacheRepo:
    """全局共享内容寻址缓存仓库。命中即刷新 hits/last_access（LRU）；写入用 upsert。"""

    def __init__(self, session: AsyncSession) -> None:
        self._s = session

    async def get_many(self, sources: list[str]) -> dict[str, CacheHit]:
        if not sources:
            return {}
        uniq = list(dict.fromkeys(sources))
        key_to_src = {key_of(src): src for src in uniq}
        rows = (
            await self._s.execute(
                select(TranslationCache).where(TranslationCache.key.in_(list(key_to_src)))
            )
        ).scalars().all()
        out: dict[str, CacheHit] = {}
        hit_keys: list[str] = []
        for r in rows:
            src = key_to_src.get(r.key)
            if src is None:
                continue
            out[src] = CacheHit(r.translated, r.input_tokens, r.output_tokens, r.hits + 1)
            hit_keys.append(r.key)
        if hit_keys:
            await self._s.execute(
                update(TranslationCache)
                .where(TranslationCache.key.in_(hit_keys))
                .values(hits=TranslationCache.hits + 1, last_access=func.now())
            )
            await self._s.commit()
        return out

    async def set_many(self, entries: list[dict]) -> None:
        if not entries:
            return
        rows = [
            {
                "key": key_of(e["source"]),
                "translated": e["translated"],
                "input_tokens": e.get("input_tokens", 0),
                "output_tokens": e.get("output_tokens", 0),
            }
            for e in entries
        ]
        stmt = insert(TranslationCache).values(rows)
        stmt = stmt.on_conflict_do_update(
            index_elements=["key"],
            set_={
                "translated": stmt.excluded.translated,
                "input_tokens": stmt.excluded.input_tokens,
                "output_tokens": stmt.excluded.output_tokens,
                "last_access": func.now(),
            },
        )
        await self._s.execute(stmt)
        await self._s.commit()
```

- [ ] **Step 4: 跑测试，预期通过**

Run: `cd server && uv run pytest tests/test_cache.py -v`
Expected: PASS（4 passed）

- [ ] **Step 5: Commit**

```bash
git add server/app/services/cache.py server/tests/test_cache.py
git commit -m "P1: 翻译缓存仓库 get_many/set_many（内容寻址 + LRU 命中刷新 + upsert）"
```

---

## Task 8: DeepSeek 客户端（请求体 + 异步 SSE + 错误分类）

**Files:**
- Create: `server/app/services/deepseek.py`
- Test: `server/tests/test_deepseek.py`

- [ ] **Step 1: 写失败测试**（用 httpx.MockTransport 造 SSE，无真实网络）

`server/tests/test_deepseek.py`：

```python
import httpx
import pytest

from app.core.prompt import SYSTEM_PROMPT
from app.services.deepseek import (
    DeepSeekError,
    build_request_body,
    stream_content_deltas,
)


def test_request_body_locks_in_invariants():
    body = build_request_body([("b1", "Hello <g0>x</g0>")])
    assert body["model"] == "deepseek-v4-flash"
    assert body["stream"] is True
    assert body["thinking"] == {"type": "disabled"}        # 关思考
    assert body["messages"][0]["role"] == "system"
    assert body["messages"][0]["content"] == SYSTEM_PROMPT  # 稳定前缀逐字节
    assert body["messages"][1]["content"] == "[[b1]] Hello <g0>x</g0>"


def _sse(*chunks: str) -> bytes:
    lines = []
    for c in chunks:
        payload = '{"choices":[{"delta":{"content":%s}}]}' % httpx._utils.__dict__.get("json", None) if False else None
        # 直接手写 data 行
        lines.append('data: {"choices":[{"delta":{"content":"%s"}}]}\n\n' % c)
    lines.append("data: [DONE]\n\n")
    return "".join(lines).encode()


async def test_streams_content_deltas():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=_sse("[[b1]] ", "你好"))

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        got = [d async for d in stream_content_deltas(client, "sk-test", [("b1", "Hi")])]
    assert "".join(got) == "[[b1]] 你好"


async def test_401_raises_auth():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="unauthorized")

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        with pytest.raises(DeepSeekError) as ei:
            [d async for d in stream_content_deltas(client, "bad", [("b1", "Hi")])]
    assert ei.value.kind == "auth"
```

> 注：`_sse` 里转义写法保持简单——译文片段不含双引号即可；测试用例已满足。

- [ ] **Step 2: 跑测试，预期失败**

Run: `cd server && uv run pytest tests/test_deepseek.py -v`
Expected: FAIL（ModuleNotFoundError）

- [ ] **Step 3: 写实现**（移植 `lib/deepseek.ts` 的请求构造、SSE 消费、错误分类）

`server/app/services/deepseek.py`：

```python
import json
from typing import AsyncIterator

import httpx

from app.core.hashing import MODEL
from app.core.prompt import SYSTEM_PROMPT

DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions"


class DeepSeekError(Exception):
    def __init__(self, kind: str, message: str) -> None:
        self.kind = kind  # network | api | auth
        self.message = message
        super().__init__(message)


def build_request_body(blocks: list[tuple[str, str]]) -> dict:
    """稳定系统提示词前缀 + 关思考；变化的块列表放 user 消息。逐条对应客户端铁律 1/4。"""
    user = "\n".join(f"[[{bid}]] {src}" for bid, src in blocks)
    return {
        "model": MODEL,
        "stream": True,
        "thinking": {"type": "disabled"},
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user},
        ],
    }


async def stream_content_deltas(
    client: httpx.AsyncClient, api_key: str, blocks: list[tuple[str, str]]
) -> AsyncIterator[str]:
    """调 DeepSeek 流式接口，逐个 yield delta.content 文本。错误按 network/api/auth 分类抛出。"""
    body = build_request_body(blocks)
    headers = {
        "Authorization": f"Bearer {api_key}",  # 绝不写日志
        "Content-Type": "application/json",
    }
    try:
        async with client.stream("POST", DEEPSEEK_URL, json=body, headers=headers) as resp:
            if resp.status_code in (401, 403):
                raise DeepSeekError("auth", "DeepSeek API Key 无效或已过期")
            if resp.status_code >= 400:
                text = (await resp.aread()).decode("utf-8", "replace")
                summary = " ".join(text[:200].split())
                raise DeepSeekError("api", f"DeepSeek 接口报错 {resp.status_code}：{summary}")
            async for line in resp.aiter_lines():
                if not line or line.startswith(":"):
                    continue
                if not line.startswith("data:"):
                    continue
                data = line[5:].lstrip()
                if data == "[DONE]":
                    return
                try:
                    obj = json.loads(data)
                    delta = obj["choices"][0]["delta"].get("content")
                except (json.JSONDecodeError, KeyError, IndexError):
                    continue
                if isinstance(delta, str) and delta:
                    yield delta
    except DeepSeekError:
        raise
    except httpx.HTTPError as e:
        raise DeepSeekError("network", f"无法连通 DeepSeek：{e}") from e
```

- [ ] **Step 4: 跑测试，预期通过**

Run: `cd server && uv run pytest tests/test_deepseek.py -v`
Expected: PASS（3 passed）

- [ ] **Step 5: Commit**

```bash
git add server/app/services/deepseek.py server/tests/test_deepseek.py
git commit -m "P1: DeepSeek 客户端移植（稳定前缀 + 关思考 + 异步 SSE + 错误分类）"
```

---

## Task 9: 翻译编排（缓存优先→去重→分批+并发→校验→写缓存→事件流）

**Files:**
- Create: `server/app/services/translator.py`
- Test: `server/tests/test_translator.py`

- [ ] **Step 1: 写失败测试**（用 fake cache + fake deepseek，无 DB 无网络）

`server/tests/test_translator.py`：

```python
import pytest

from app.services.cache import CacheHit
from app.services.translator import (
    BlockEvent,
    DoneEvent,
    ErrorEvent,
    SourceBlock,
    translate,
)


class FakeCache:
    def __init__(self, store: dict[str, CacheHit] | None = None):
        self.store = store or {}
        self.saved: list[dict] = []

    async def get_many(self, sources):
        return {s: self.store[s] for s in sources if s in self.store}

    async def set_many(self, entries):
        self.saved.extend(entries)


def fake_deepseek(scripted: dict[str, str]):
    """返回一个 stream_content_deltas 替身：按块 id 直接吐 `[[id]] 译文`。"""
    async def _stream(api_key, blocks):
        for bid, _src in blocks:
            yield f"[[{bid}]] {scripted.get(bid, '')}"
    return _stream


async def drain(gen):
    return [ev async for ev in gen]


async def test_full_cache_hit_no_model_call(db_unused=None):
    cache = FakeCache({"Hello": CacheHit("你好", 3, 2, 1)})
    called = False

    async def deepseek(api_key, blocks):
        nonlocal called
        called = True
        yield ""

    evs = await drain(translate(
        [SourceBlock("b1", "Hello")], cache=cache, deepseek_stream=deepseek, api_key="k",
    ))
    assert not called  # 全命中不调模型
    assert BlockEvent("b1", "你好") in evs
    assert any(isinstance(e, DoneEvent) for e in evs)


async def test_miss_calls_model_and_caches():
    cache = FakeCache()
    evs = await drain(translate(
        [SourceBlock("b1", "Hello")],
        cache=cache, deepseek_stream=fake_deepseek({"b1": "你好"}), api_key="k",
    ))
    assert BlockEvent("b1", "你好") in evs
    assert cache.saved and cache.saved[0]["translated"] == "你好"
    assert cache.saved[0]["input_tokens"] > 0  # 写缓存带 token 估算


async def test_dedupe_same_source_translated_once():
    cache = FakeCache()
    sent_batches = []

    async def deepseek(api_key, blocks):
        sent_batches.append([b[0] for b in blocks])
        for bid, _ in blocks:
            yield f"[[{bid}]] 提交"

    evs = await drain(translate(
        [SourceBlock("b1", "Submit"), SourceBlock("b2", "Submit")],
        cache=cache, deepseek_stream=deepseek, api_key="k",
    ))
    # 去重：只发一个代表块给模型，但两个 id 都收到译文
    assert sum(len(b) for b in sent_batches) == 1
    assert BlockEvent("b1", "提交") in evs and BlockEvent("b2", "提交") in evs


async def test_verbatim_echo_not_cached():
    cache = FakeCache()
    await drain(translate(
        [SourceBlock("b1", "OK")],
        cache=cache, deepseek_stream=fake_deepseek({"b1": "OK"}), api_key="k",
    ))
    assert cache.saved == []  # 原样回显不入缓存（自愈）


async def test_invalid_markers_not_cached_but_emitted():
    cache = FakeCache()
    # source 无标记，译文凭空冒出 <g0> → 校验失败 → 不缓存
    evs = await drain(translate(
        [SourceBlock("b1", "Hello")],
        cache=cache, deepseek_stream=fake_deepseek({"b1": "<g0>你好</g0>"}), api_key="k",
    ))
    assert BlockEvent("b1", "<g0>你好</g0>") in evs
    assert cache.saved == []
```

- [ ] **Step 2: 跑测试，预期失败**

Run: `cd server && uv run pytest tests/test_translator.py -v`
Expected: FAIL（ModuleNotFoundError）

- [ ] **Step 3: 写实现**（移植 `lib/translator.ts`；异步事件流 + 并发 queue 合流）

`server/app/services/translator.py`：

```python
import asyncio
from dataclasses import dataclass
from typing import AsyncIterator, Awaitable, Callable, Protocol

from app.core.tokens import estimate_tokens
from app.services.block_splitter import BlockSplitter
from app.services.markers import (
    allowed_ids_from_source,
    is_verbatim_echo,
    validate_markers,
)

BATCH_SIZE = 40
CONCURRENCY = 4


@dataclass(frozen=True)
class SourceBlock:
    id: str
    source: str


@dataclass(frozen=True)
class BlockEvent:
    id: str
    translated: str


@dataclass(frozen=True)
class DoneEvent:
    pass


@dataclass(frozen=True)
class ErrorEvent:
    kind: str
    message: str


Event = BlockEvent | DoneEvent | ErrorEvent

# deepseek_stream(api_key, blocks) -> async iterator of content delta str
DeepSeekStream = Callable[[str, list[tuple[str, str]]], AsyncIterator[str]]


class CacheLike(Protocol):
    async def get_many(self, sources: list[str]) -> dict: ...
    async def set_many(self, entries: list[dict]) -> None: ...


async def translate(
    blocks: list[SourceBlock],
    *,
    cache: CacheLike,
    deepseek_stream: DeepSeekStream,
    api_key: str,
) -> AsyncIterator[Event]:
    """缓存优先 → 去重 → 分批 + 有限并发 → 切块 → 标记校验 → 写缓存。逐块 yield 事件。"""
    if not blocks:
        yield DoneEvent()
        return

    # 1) 缓存优先
    hit_map = await cache.get_many([b.source for b in blocks])
    misses: list[SourceBlock] = []
    for b in blocks:
        hit = hit_map.get(b.source)
        if hit is not None:
            yield BlockEvent(b.id, hit.translated)
        else:
            misses.append(b)
    if not misses:
        yield DoneEvent()
        return

    # 2) 按 source 去重：代表块发模型，译文广播给共享同 source 的所有 id
    by_source: dict[str, list[str]] = {}
    rep_source: dict[str, str] = {}  # rep_id -> source
    model_blocks: list[tuple[str, str]] = []
    for b in misses:
        if b.source in by_source:
            by_source[b.source].append(b.id)
            continue
        by_source[b.source] = [b.id]
        rep_source[b.id] = b.source
        model_blocks.append((b.id, b.source))

    # 3) 分批 + 有限并发，结果经 queue 合流
    batches = [model_blocks[i:i + BATCH_SIZE] for i in range(0, len(model_blocks), BATCH_SIZE)]
    queue: asyncio.Queue = asyncio.Queue()
    sem = asyncio.Semaphore(CONCURRENCY)
    to_cache: list[dict] = []
    success = 0
    last_error: ErrorEvent | None = None

    async def run_batch(batch: list[tuple[str, str]]) -> None:
        nonlocal success, last_error
        async with sem:
            collected: list[tuple[str, str]] = []
            splitter = BlockSplitter(lambda i, t: collected.append((i, t)))
            try:
                async for delta in deepseek_stream(api_key, batch):
                    splitter.feed(delta)
                splitter.flush()
            except Exception as e:  # DeepSeekError 等：单批失败不打断其余
                last_error = ErrorEvent(getattr(e, "kind", "unknown"), getattr(e, "message", str(e)))
                return
            for rep_id, translated in collected:
                source = rep_source.get(rep_id)
                if source is None:
                    continue  # 模型乱编 id
                for bid in by_source[source]:
                    await queue.put(BlockEvent(bid, translated))
                if validate_markers(translated, allowed_ids_from_source(source)).ok:
                    success += 1
                    if not is_verbatim_echo(source, translated):
                        to_cache.append({
                            "source": source,
                            "translated": translated,
                            "input_tokens": estimate_tokens(source),
                            "output_tokens": estimate_tokens(translated),
                        })

    async def producer() -> None:
        await asyncio.gather(*(run_batch(b) for b in batches))
        await queue.put(None)  # 哨兵

    task = asyncio.create_task(producer())
    while True:
        item = await queue.get()
        if item is None:
            break
        yield item
    await task

    await cache.set_many(to_cache)
    if success == 0 and last_error is not None:
        yield last_error
    else:
        yield DoneEvent()
```

- [ ] **Step 4: 跑测试，预期通过**

Run: `cd server && uv run pytest tests/test_translator.py -v`
Expected: PASS（5 passed）

- [ ] **Step 5: Commit**

```bash
git add server/app/services/translator.py server/tests/test_translator.py
git commit -m "P1: 翻译编排移植（缓存优先/去重/分批并发/校验/写缓存/事件流）"
```

---

## Task 10: `POST /v1/translate` SSE 端点

**Files:**
- Create: `server/app/routers/__init__.py`, `server/app/routers/translate.py`
- Modify: `server/app/main.py`（挂载 router + 依赖）
- Test: `server/tests/test_translate_endpoint.py`

- [ ] **Step 1: 写失败测试**（ASGI transport + 依赖覆盖 fake deepseek/cache）

`server/tests/test_translate_endpoint.py`：

```python
import httpx
import pytest
from httpx import ASGITransport

from app.main import app
from app.routers.translate import get_cache, get_deepseek_stream
from app.services.cache import CacheHit


class FakeCache:
    def __init__(self):
        self.store, self.saved = {}, []

    async def get_many(self, sources):
        return {s: self.store[s] for s in sources if s in self.store}

    async def set_many(self, entries):
        self.saved.extend(entries)


async def fake_stream(api_key, blocks):
    for bid, _src in blocks:
        yield f"[[{bid}]] 你好"


def parse_sse(text: str) -> list[tuple[str, str]]:
    events = []
    cur_event = None
    for line in text.splitlines():
        if line.startswith("event:"):
            cur_event = line[6:].strip()
        elif line.startswith("data:"):
            events.append((cur_event, line[5:].strip()))
    return events


@pytest.fixture
def override():
    app.dependency_overrides[get_cache] = lambda: FakeCache()
    app.dependency_overrides[get_deepseek_stream] = lambda: fake_stream
    yield
    app.dependency_overrides.clear()


async def test_translate_streams_block_then_done(override):
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        resp = await c.post("/v1/translate", json={"blocks": [{"id": "b1", "source": "Hi"}]})
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    evs = parse_sse(resp.text)
    assert ("block", '{"id":"b1","translated":"你好"}') in [(e, d.replace(" ", "")) for e, d in evs]
    assert any(e == "done" for e, _ in evs)
```

- [ ] **Step 2: 跑测试，预期失败**

Run: `cd server && uv run pytest tests/test_translate_endpoint.py -v`
Expected: FAIL（ImportError: app.routers.translate）

- [ ] **Step 3: 写实现**

`server/app/routers/__init__.py`：空文件。

`server/app/routers/translate.py`：

```python
import json
from typing import AsyncIterator

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.core.config import settings
from app.db.base import async_session
from app.services import deepseek
from app.services.cache import TranslationCacheRepo
from app.services.translator import (
    BlockEvent,
    DoneEvent,
    ErrorEvent,
    SourceBlock,
    translate,
)

router = APIRouter()


class BlockIn(BaseModel):
    id: str
    source: str


class TranslateRequest(BaseModel):
    blocks: list[BlockIn]
    localDate: str | None = None  # P2 配额用，本期忽略


# ---- 依赖（测试可覆盖）----
def get_deepseek_stream():
    return deepseek.stream_content_deltas  # (api_key, blocks) -> async iter

# 注意：cache 依赖每请求开一个 session，返回 repo；测试覆盖为 fake。
async def get_cache() -> AsyncIterator[TranslationCacheRepo]:
    async with async_session() as s:
        yield TranslationCacheRepo(s)


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/v1/translate")
async def translate_endpoint(
    req: TranslateRequest,
    cache=Depends(get_cache),
    deepseek_stream=Depends(get_deepseek_stream),
):
    blocks = [SourceBlock(b.id, b.source) for b in req.blocks]

    async def gen() -> AsyncIterator[str]:
        async for ev in translate(
            blocks, cache=cache, deepseek_stream=deepseek_stream, api_key=settings.deepseek_api_key
        ):
            if isinstance(ev, BlockEvent):
                yield _sse("block", {"id": ev.id, "translated": ev.translated})
            elif isinstance(ev, DoneEvent):
                yield _sse("done", {})
            elif isinstance(ev, ErrorEvent):
                yield _sse("error", {"kind": ev.kind, "message": ev.message})

    return StreamingResponse(gen(), media_type="text/event-stream")
```

> 注：`get_deepseek_stream` 当前直接返回模块级异步生成器函数 `stream_content_deltas`，但它签名是 `(client, api_key, blocks)`。为对齐 translator 期望的 `(api_key, blocks)`，在 `deepseek.py` 增加一个便捷包装（见下一步），并让依赖返回该包装。

- [ ] **Step 4: 在 `deepseek.py` 增加默认 client 的便捷包装**

`server/app/services/deepseek.py` 末尾追加：

```python
async def stream_with_default_client(api_key: str, blocks: list[tuple[str, str]]) -> AsyncIterator[str]:
    """生产用：每次开一个 httpx client 调上游。translator 期望的 (api_key, blocks) 签名。"""
    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0)) as client:
        async for delta in stream_content_deltas(client, api_key, blocks):
            yield delta
```

并把 `routers/translate.py` 的 `get_deepseek_stream` 改为：

```python
def get_deepseek_stream():
    return deepseek.stream_with_default_client
```

- [ ] **Step 5: 在 `main.py` 挂载 router**

`server/app/main.py` 改为：

```python
from fastapi import FastAPI

from app.routers import translate

app = FastAPI(title="Immersive Translate Backend")
app.include_router(translate.router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
```

- [ ] **Step 6: 跑测试，预期通过**

Run: `cd server && uv run pytest tests/test_translate_endpoint.py -v`
Expected: PASS（1 passed）

- [ ] **Step 7: Commit**

```bash
git add server/app/routers/ server/app/main.py server/app/services/deepseek.py server/tests/test_translate_endpoint.py
git commit -m "P1: POST /v1/translate SSE 端点（结构化 block/done/error 事件）"
```

---

## Task 11: 全套测试 + 真实 DeepSeek 端到端冒烟

**Files:**
- Create: `server/scripts/smoke_translate.py`
- Test: 全量 `uv run pytest`

- [ ] **Step 1: 跑全量单测**

Run: `cd server && uv run pytest -v`
Expected: 全绿（health/hashing/markers/block_splitter/tokens/cache/deepseek/translator/endpoint）。

- [ ] **Step 2: 准备 `.env`（真实 Key）**

```bash
cd server && cp .env.example .env
# 把仓库根 .env 里的 WXT_DEEPSEEK_API_KEY 值填进 server/.env 的 DEEPSEEK_API_KEY
```

- [ ] **Step 3: 写端到端冒烟脚本**

`server/scripts/smoke_translate.py`：

```python
"""真实调一次后端 + DeepSeek：起服务后运行，核对流式译文 + 缓存命中。"""
import asyncio
import json

import httpx

PAYLOAD = {"blocks": [
    {"id": "b1", "source": "You must call <g0>fetch()</g0> before rendering."},
    {"id": "b2", "source": "Submit"},
]}


async def run() -> None:
    async with httpx.AsyncClient(timeout=60) as c:
        async with c.stream("POST", "http://localhost:8000/v1/translate", json=PAYLOAD) as r:
            print("status", r.status_code)
            async for line in r.aiter_lines():
                if line.strip():
                    print(line)


asyncio.run(run())
```

- [ ] **Step 4: 起服务并跑冒烟（两次，验证第二次缓存命中）**

```bash
cd server && uv run uvicorn app.main:app --port 8000 &   # 后台起服务
sleep 2
uv run python scripts/smoke_translate.py                  # 第一次：调模型
uv run python scripts/smoke_translate.py                  # 第二次：应全部缓存命中（秒回）
psql postgresql://imt:imt@localhost:5433/imt -c "select key, left(translated,20), input_tokens, output_tokens, hits from translation_cache;"
kill %1
```

Expected:
- 第一次：流式输出 `event: block` 两块中文译文 + `event: done`。
- 第二次：同样译文但明显更快（无模型调用），`translation_cache.hits` 增加。
- 表里有 b1/b2 对应两行，`input_tokens/output_tokens > 0`。

- [ ] **Step 5: Commit**

```bash
git add server/scripts/smoke_translate.py
git commit -m "P1: 端到端冒烟脚本（真实 DeepSeek + 缓存命中核对）"
```

---

## Self-Review 记录

- **Spec 覆盖**：本计划覆盖设计文档 P0（FastAPI 骨架/Postgres/迁移/配置/健康检查）与 P1 后端侧（`/v1/translate` SSE、编排/去重/分批/切块/校验、`translation_cache` 含 token 列、稳定前缀 + 关思考）。P1 客户端接线（`lib/api.ts`/`background.ts`/`lib/device.ts`、退场 deepseek/cache/config/prompt/translator）= 下一份计划，本计划不含。P2–P8 各自后续立计划。
- **铁律核对**：稳定前缀（Task 8 测试锁定 system 逐字节）· 关思考（Task 8 测试锁定 `thinking:disabled`）· 分批 40 + 并发 4（Task 9）· 去重（Task 9 测试）· 带 `.` 切块（Task 4 测试）· 标记校验 + 原样回显不缓存（Task 3/9 测试）。
- **占位扫描**：无 TBD；每个改代码的步骤都给了完整代码与可跑命令。
- **类型一致**：`SourceBlock/BlockEvent/DoneEvent/ErrorEvent`（translator）· `CacheHit`（cache）· `TranslationCacheRepo.get_many/set_many` · `stream_content_deltas`/`stream_with_default_client`（deepseek）跨任务签名一致。
- **已知后续**：缓存 LRU 上限淘汰（`lib/cache.ts` 的 MAX_ENTRIES）本计划未实现（先靠 Postgres 容量 + 后续后台任务）；端点目前用 `settings.deepseek_api_key` 单 Key，多 Key 轮换（`upstream_keys`）属后续阶段。
```
