# Creem Webhook 收单 + 验签 + 买断注册码发放（D-18）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`).

**Goal:** 接入 **Creem（MoR）** 海外 $9.99 买断收款（D-18）。Creem `checkout.completed` webhook → **HMAC-SHA256 验签** → **幂等发放一张注册码**（买断＝BYOK 终身 + 注册码×5 台，**不发 credits、不必建账号**，D-06）→ 落库 + 发邮件。纯加性：只加表/服务/端点 + 测试，不动翻译流/免费层/credits 扣费。

**Architecture:**
- 海外线＝**买断 only**（D-18：Creem 不做小额充值）。买断用户走 BYOK、翻译不过我们服务器，所以 webhook **不调 `CreditRepo.grant`**，而是**签发注册码**（与未来 YunGouOS 大陆买断共用同一 `RedeemCodeRepo`；大陆充值才走 `grant`，另计划）。
- **统一收单范式**（蓝图「统一 credits 账本：各自 webhook → 同一发放函数 + 幂等键 + 验签」的买断侧实例）：`verify → parse → 幂等 issue → 发邮件 → 200`。幂等键＝Creem **order id**（`source_ref` 唯一），webhook 重投/并发只发一张码。
- **验签**：`creem-signature` 头 = `HMAC_SHA256(raw_body, webhook_secret)` 的 hex；服务端同算法重算、**常量时间比较**（`hmac.compare_digest`）。密钥 `creem_webhook_secret` 在 env（Developers→Webhook 页取）。
- **邮件解耦**：定义 `EmailSender` 接口 + 本计划用 `LogEmailSender`（落日志，码已持久化故不丢）；真实 Resend/阿里云驱动 = 独立计划。**注册码落库即真相**，邮件失败可经「自助重查」补发（D-06，重查端点本计划暂留接口、不强求）。

**Tech Stack:** FastAPI 端点读 `await request.body()` 拿**原始字节**验签（不能用解析后再 dumps，字节须逐字节一致）；`hmac`/`hashlib` 标准库；SQLAlchemy 2.0 async + Alembic（down_revision=当前 head `c1d2e3f4a5b6`）；pytest + httpx ASGITransport（用真实算的签名头打端点）。

**Decision source:** 蓝图 V2 **D-18**（海外改 Creem + 个人支付宝）、D-06（买断不必建账号、注册码×5、邮箱自助重查）、§5 收款链路「统一发放函数 + 幂等 + 验签」。Creem 文档：`creem-signature` HMAC-SHA256 over raw body；`checkout.completed` 事件含 `id`(事件)/`object`(含 `request_id`)/`order`(id/customer/product/amount/currency/status)/`customer.email`。

**未定/不在本计划（后续切片）：** ① 注册码**激活端点**（code + 设备指纹 → 绑定、×5 上限）与**自助重查端点**；② 真实邮件驱动（Resend/阿里云）；③ 大陆 YunGouOS webhook（充值→`grant` + 买断→复用本表）；④ Creem **退款/争议** webhook（`refund.created`/`dispute.created`）→ 注册码吊销；⑤ 创建 checkout（下单）端点与 `request_id` 关联用户——买断走纯邮箱不依赖登录，下单可前端直跳 Creem product 链接。

---

## File Structure
- `server/app/core/config.py` — 加 `creem_webhook_secret`、`creem_buyout_product_id`。
- `server/app/services/creem.py` — **新增**：`verify_signature(raw, sig, secret)`（纯函数）+ `parse_checkout_completed(payload)`（取 order_id/email/product_id/status/amount/currency，非该事件或字段缺失返 None）。
- `server/app/services/redeem_repo.py` — **新增** `RedeemCodeRepo.issue(...)`（幂等：`source_ref` 唯一，重投返已存在码）+ `gen_code()`。
- `server/app/services/email.py` — **新增** `EmailSender` Protocol + `LogEmailSender`。
- `server/app/db/models.py` — 加 `RedeemCode`。
- `server/app/routers/billing.py` — **新增** `POST /v1/billing/creem/webhook`。
- `server/app/main.py` — 挂载 billing router。
- `server/alembic/versions/d2e3f4a5b6c7_redeem_codes.py` — **新增**建表（down=`c1d2e3f4a5b6`）。
- `server/tests/test_creem_sig.py` · `test_redeem_repo.py` · `test_billing_webhook.py` — **新增**。
- `server/CLAUDE.md` — 数据模型 + 模块 + API 表面同步。

---

### Task 1: 验签纯函数 + 事件解析 + 测试（先红）

- [ ] **Step 1: `server/app/services/creem.py`**
```python
import hmac, hashlib
from typing import Any


def verify_signature(raw_body: bytes, signature: str, secret: str) -> bool:
    """Creem: creem-signature 头 = HMAC_SHA256(raw_body, secret) 的 hex。常量时间比较。"""
    if not secret or not signature:
        return False
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


def parse_checkout_completed(payload: dict[str, Any]) -> dict[str, Any] | None:
    """仅认 eventType==checkout.completed 且订单已付。返回 {order_id,email,product_id,amount,currency}，否则 None。"""
    if payload.get("eventType") != "checkout.completed":
        return None
    obj = payload.get("object") or {}
    order = obj.get("order") or {}
    customer = obj.get("customer") or order.get("customer") or {}
    status = (order.get("status") or obj.get("status") or "").lower()
    if status not in ("paid", "completed"):
        return None
    order_id = str(order.get("id") or obj.get("id") or "")
    email = (customer.get("email") if isinstance(customer, dict) else "") or obj.get("customer_email") or ""
    product = order.get("product") or obj.get("product") or {}
    product_id = str(product.get("id") if isinstance(product, dict) else product or "")
    if not order_id or not email:
        return None
    return {"order_id": order_id, "email": email, "product_id": product_id,
            "amount": order.get("amount"), "currency": order.get("currency")}
```

- [ ] **Step 2: `server/tests/test_creem_sig.py`**（纯函数，无 DB）
```python
import hashlib, hmac, json
from app.services.creem import verify_signature, parse_checkout_completed

SECRET = "whsec_test_123"

def _sign(raw: bytes) -> str:
    return hmac.new(SECRET.encode(), raw, hashlib.sha256).hexdigest()

def test_verify_ok():
    raw = b'{"a":1}'
    assert verify_signature(raw, _sign(raw), SECRET) is True

def test_verify_tampered_body():
    raw = b'{"a":1}'
    assert verify_signature(b'{"a":2}', _sign(raw), SECRET) is False

def test_verify_empty_secret_or_sig():
    assert verify_signature(b'x', "deadbeef", "") is False
    assert verify_signature(b'x', "", SECRET) is False

def test_parse_paid_checkout():
    p = {"eventType": "checkout.completed", "object": {
        "order": {"id": "ord_1", "status": "paid", "amount": 999, "currency": "USD",
                  "product": {"id": "prod_buyout"}},
        "customer": {"email": "u@x.com"}}}
    out = parse_checkout_completed(p)
    assert out == {"order_id": "ord_1", "email": "u@x.com", "product_id": "prod_buyout",
                   "amount": 999, "currency": "USD"}

def test_parse_ignores_other_event():
    assert parse_checkout_completed({"eventType": "subscription.active"}) is None

def test_parse_ignores_unpaid():
    assert parse_checkout_completed({"eventType": "checkout.completed",
        "object": {"order": {"id": "o", "status": "pending"}, "customer": {"email": "a@b.c"}}}) is None
```

- [ ] **Step 3:** `cd server && uv run pytest tests/test_creem_sig.py -v` → 6 PASS。
- [ ] **Step 4: Commit** `feat(billing): Creem webhook HMAC 验签 + checkout.completed 解析（D-18）`

---

### Task 2: RedeemCode 模型 + 幂等签发仓库 + 测试

- [ ] **Step 1: `models.py` 加表**
```python
class RedeemCode(Base):
    """买断注册码：一张码 = 一次买断（BYOK 终身，激活时绑 ≤max_devices 台，绑定逻辑在激活端点/另计划）。
    source_ref 唯一 → 同一支付订单 webhook 重投只签发一张（幂等）。"""

    __tablename__ = "redeem_codes"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    email: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    product: Mapped[str] = mapped_column(String(32), default="buyout", nullable=False)
    source: Mapped[str] = mapped_column(String(16), nullable=False)          # creem|yungouos
    source_ref: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)  # 订单 id，幂等键
    max_devices: Mapped[int] = mapped_column(Integer, default=5, nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="active", nullable=False)  # active|revoked
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False)
```

- [ ] **Step 2: `server/app/services/redeem_repo.py`**
```python
import secrets, string
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.models import RedeemCode

_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # 去掉易混 0/O/1/I/L

def gen_code() -> str:
    g = lambda: "".join(secrets.choice(_ALPHABET) for _ in range(4))
    return f"IMT-{g()}-{g()}-{g()}"

class RedeemCodeRepo:
    def __init__(self, session: AsyncSession) -> None:
        self._s = session

    async def get_by_source_ref(self, source: str, source_ref: str) -> RedeemCode | None:
        return await self._s.scalar(
            select(RedeemCode).where(RedeemCode.source == source, RedeemCode.source_ref == source_ref))

    async def issue(self, *, email: str, source: str, source_ref: str,
                    product: str = "buyout", max_devices: int = 5) -> RedeemCode:
        """幂等签发：source_ref 已存在则返回原码；否则新建。返回 RedeemCode。"""
        existing = await self.get_by_source_ref(source, source_ref)
        if existing:
            return existing
        rc = RedeemCode(code=gen_code(), email=email, product=product,
                        source=source, source_ref=source_ref, max_devices=max_devices)
        self._s.add(rc)
        try:
            await self._s.commit()
        except IntegrityError:   # 并发：source_ref 唯一冲突 → 取已存在
            await self._s.rollback()
            return await self.get_by_source_ref(source, source_ref)  # type: ignore[return-value]
        await self._s.refresh(rc)
        return rc
```

- [ ] **Step 3: `server/tests/test_redeem_repo.py`**（`db_session` 夹具）
```python
from app.db.base import async_session
from app.services.redeem_repo import RedeemCodeRepo, gen_code

def test_gen_code_shape():
    c = gen_code()
    assert c.startswith("IMT-") and len(c) == 4 + 4 + 1 + 4 + 1 + 4  # IMT-XXXX-XXXX-XXXX

async def test_issue_idempotent_by_source_ref(db_session):
    async with async_session() as s:
        repo = RedeemCodeRepo(s)
        a = await repo.issue(email="u@x.com", source="creem", source_ref="ord_1")
    async with async_session() as s:
        repo = RedeemCodeRepo(s)
        b = await repo.issue(email="u@x.com", source="creem", source_ref="ord_1")
    assert a.code == b.code  # 同订单只一张

async def test_issue_distinct_orders(db_session):
    async with async_session() as s:
        repo = RedeemCodeRepo(s)
        a = await repo.issue(email="u@x.com", source="creem", source_ref="ord_1")
        b = await repo.issue(email="u@x.com", source="creem", source_ref="ord_2")
    assert a.code != b.code
```

- [ ] **Step 4:** `uv run pytest tests/test_redeem_repo.py -v` → 3 PASS。
- [ ] **Step 5: Commit** `feat(billing): 注册码模型 + 幂等签发仓库（按订单去重）`

---

### Task 3: 邮件接口 + webhook 端点 + 测试

- [ ] **Step 1: `server/app/services/email.py`**
```python
import logging
from typing import Protocol
log = logging.getLogger("email")

class EmailSender(Protocol):
    async def send(self, to: str, subject: str, body: str) -> None: ...

class LogEmailSender:
    """占位：码已落库，邮件失败不丢单；真实 Resend/阿里云驱动另计划。"""
    async def send(self, to: str, subject: str, body: str) -> None:
        log.info("EMAIL → %s | %s | %s", to, subject, body)
```

- [ ] **Step 2: `config.py` 加** `creem_webhook_secret: str = ""` 和 `creem_buyout_product_id: str = ""`（空 product_id ＝ 不校验商品，便于联调；生产必填）。

- [ ] **Step 3: `server/app/routers/billing.py`**
```python
import json
from fastapi import APIRouter, Request
from app.core.config import settings
from app.db.base import async_session
from app.services import creem
from app.services.email import LogEmailSender
from app.services.redeem_repo import RedeemCodeRepo

router = APIRouter()
_email = LogEmailSender()

@router.post("/v1/billing/creem/webhook")
async def creem_webhook(request: Request):
    raw = await request.body()
    sig = request.headers.get("creem-signature", "")
    if not creem.verify_signature(raw, sig, settings.creem_webhook_secret):
        return _resp(400, {"error": "bad signature"})
    try:
        payload = json.loads(raw)
    except ValueError:
        return _resp(400, {"error": "bad json"})
    parsed = creem.parse_checkout_completed(payload)
    if not parsed:
        return {"ok": True, "ignored": True}        # 非买断完成事件，幂等忽略、回 200 防重投
    if settings.creem_buyout_product_id and parsed["product_id"] != settings.creem_buyout_product_id:
        return {"ok": True, "ignored": True}        # 非买断商品
    async with async_session() as s:
        rc = await RedeemCodeRepo(s).issue(
            email=parsed["email"], source="creem", source_ref=parsed["order_id"])
    await _email.send(parsed["email"], "你的沉浸式翻译买断注册码",
                      f"感谢购买！注册码：{rc.code}（最多 {rc.max_devices} 台设备激活）。")
    return {"ok": True, "code_issued": True}

def _resp(status: int, body: dict):
    from fastapi.responses import JSONResponse
    return JSONResponse(status_code=status, content=body)
```
> 注：FastAPI 端点直接 `return dict` ＝ 200。错误用 `JSONResponse` 显式置 4xx（避免 `raise HTTPException` 也行，但 webhook 我们要可控 body）。

- [ ] **Step 4: `main.py` 挂载** `from app.routers import billing` + `app.include_router(billing.router)`。

- [ ] **Step 5: `server/tests/test_billing_webhook.py`**（httpx ASGITransport + 真实算签名；monkeypatch settings.secret）
```python
import hashlib, hmac, json
import httpx, pytest
from httpx import ASGITransport
from app.main import app
from app.core.config import settings
from app.db.base import async_session
from app.db.models import RedeemCode
from sqlalchemy import func, select

SECRET = "whsec_test"

@pytest.fixture(autouse=True)
def _secret(monkeypatch):
    monkeypatch.setattr(settings, "creem_webhook_secret", SECRET)
    monkeypatch.setattr(settings, "creem_buyout_product_id", "")  # 联调不校验商品

def _body(order_id="ord_1", email="u@x.com"):
    return json.dumps({"eventType": "checkout.completed", "object": {
        "order": {"id": order_id, "status": "paid", "amount": 999, "currency": "USD",
                  "product": {"id": "prod_buyout"}},
        "customer": {"email": email}}}).encode()

def _sig(raw): return hmac.new(SECRET.encode(), raw, hashlib.sha256).hexdigest()

async def _post(raw, sig):
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        return await c.post("/v1/billing/creem/webhook", content=raw,
                            headers={"creem-signature": sig, "content-type": "application/json"})

async def test_paid_issues_code(db_session):
    raw = _body()
    r = await _post(raw, _sig(raw))
    assert r.status_code == 200 and r.json()["code_issued"]
    async with async_session() as s:
        n = await s.scalar(select(func.count()).select_from(RedeemCode).where(RedeemCode.source_ref == "ord_1"))
    assert n == 1

async def test_replay_same_order_idempotent(db_session):
    raw = _body()
    await _post(raw, _sig(raw))
    await _post(raw, _sig(raw))      # 重投
    async with async_session() as s:
        n = await s.scalar(select(func.count()).select_from(RedeemCode).where(RedeemCode.source_ref == "ord_1"))
    assert n == 1                    # 仍只一张

async def test_bad_signature_rejected(db_session):
    raw = _body()
    r = await _post(raw, "deadbeef")
    assert r.status_code == 400
    async with async_session() as s:
        n = await s.scalar(select(func.count()).select_from(RedeemCode))
    assert n == 0

async def test_other_event_ignored(db_session):
    raw = json.dumps({"eventType": "subscription.active"}).encode()
    r = await _post(raw, _sig(raw))
    assert r.status_code == 200 and r.json().get("ignored")
    async with async_session() as s:
        n = await s.scalar(select(func.count()).select_from(RedeemCode))
    assert n == 0
```

- [ ] **Step 6:** `uv run pytest tests/test_billing_webhook.py -v` → 4 PASS。
- [ ] **Step 7: Commit** `feat(billing): Creem webhook 端点 → 验签→幂等签发注册码→发邮件（D-18）`

---

### Task 4: 迁移 + 全量 + 文档

- [ ] **Step 1: 迁移** `server/alembic/versions/d2e3f4a5b6c7_redeem_codes.py`（down=`c1d2e3f4a5b6`）：建 `redeem_codes`，列同模型；`code` 唯一、`source_ref` 唯一、`email` 索引。
- [ ] **Step 2:** `uv run alembic upgrade head && uv run pytest -q` → 迁移到 `d2e3f4a5b6c7`；全绿（+13 用例）。**conftest TRUNCATE 列表补 `redeem_codes`**（否则跨用例泄漏，同 credits 踩过的坑）。
- [ ] **Step 3: 文档** `server/CLAUDE.md`：数据模型加 `redeem_codes`；模块 services 加 `creem.py`/`redeem_repo.py`/`email.py`、routers 加 `billing.py`；API 表面加 `POST /v1/billing/creem/webhook`（验签→幂等签发注册码）。
- [ ] **Step 4: Commit** `feat(billing): redeem_codes 迁移 + 文档同步（D-18 Creem 收单）`

---

## Self-Review
**1. 加性安全：** 只加表/服务/端点 + 测试，不动翻译流/credits 扣费/免费层 → 零行为变化；未配 `creem_webhook_secret` 时所有 webhook 验签失败回 400（不会误发码）。
**2. 验签正确：** 读**原始字节** body 验 HMAC（非解析后重 dump）；`compare_digest` 防时序；空密钥/空签名直接 False。
**3. 幂等：** 注册码按 **Creem order id**（`source_ref` 唯一）去重，webhook 重投/并发只一张码；非买断完成事件回 200（防 Creem 持续重投）。
**4. 买断语义对齐：** 买断＝BYOK 终身 + 注册码×5（D-06），**不发 credits、不必建账号**；码落库即真相，邮件失败可后续重查补发。
**遗留（须用户/外部）：** ① Creem 账号 + webhook secret + 买断 product_id（用户办，填 `.env`）；② 激活端点（code+指纹→×5 绑定）+ 自助重查端点；③ 真实邮件驱动；④ 退款/争议 webhook → 吊销码；⑤ 大陆 YunGouOS webhook（充值→`grant`／买断→复用本表）。
