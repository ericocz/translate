# Credits 扣费接入翻译流 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** 把 credits 账本接进 `/v1/translate`：**付费模式**用户（有 `credit_accounts` 行）按实耗扣 credits + 余额≤0 软拦截、跳梯度限流；**免费模式**用户（无账户）行为零变化。无人充值前无账户 → **休眠**（与 D-13 同模式：建好待激活）。

**决策（本计划落定，可调）：**
- **卖价费率**＝成本价透传：`in 1 / out 2 micro-¥/token`（＝DeepSeek ¥1/¥2 per M，整数精确），常数化便于日后加毛利。命中/未命中分档计价是后续细化（需 `UsageEvent` 带缓存命中拆分）。
- **免费↔付费模型**＝按 `credit_accounts` 是否存在判定。付费用户：余额门控 + 扣费、不受梯度限流；免费用户：现状（梯度限流）不变。D-04「全员 credits-only」是未来一次性切换，不在此。

**Architecture:** 端点新增 `get_credits` 依赖；登录用户先取账户判 `is_credit_user`；付费且余额≤0 → 发 `quota`「额度不足」；`UsageEvent` 时付费用户 `deduct(cost_micro(in,out))`。扣费纯函数 `pricing.cost_micro` 单测；端点用 `FakeCredits` 保持无 DB。

**Decision source:** 蓝图 D-02/D-03（按 Token 实耗扣减、命中本地不计费、须注册）+ [[credits-ledger-foundation]]。

---

## File Structure
- `server/app/services/pricing.py` — **新增** `cost_micro` + 费率常数。
- `server/app/services/credit_repo.py` — 加 `get_account`。
- `server/app/routers/translate.py` — `get_credits` 依赖 + 付费分支（门控 + 扣费）。
- `server/tests/test_pricing.py` — **新增**（纯）。
- `server/tests/test_credit_repo.py` — 加 `get_account` 用例。
- `server/tests/test_translate_endpoint.py` — `FakeCredits` + 扣费/拦截用例。
- `server/CLAUDE.md` — 关键流程/API 同步。

---

### Task 1: 费率纯函数 + get_account

- [ ] **Step 1:** 新建 `server/app/services/pricing.py`：
```python
# 额度扣费费率（D-02/D-03）：micro-¥（1e-6 元）/token。
# 当前＝成本价透传：DeepSeek V4 Flash ¥1/M 输入、¥2/M 输出 → 1 / 2 micro-¥/token（整数精确）。
# 要加毛利就调大这两个常数。命中/未命中分档计价是后续细化（需 UsageEvent 带缓存命中拆分）。
MICRO_YUAN_PER_INPUT_TOKEN = 1
MICRO_YUAN_PER_OUTPUT_TOKEN = 2


def cost_micro(input_tokens: int, output_tokens: int) -> int:
    """本次翻译应扣的额度（micro-¥）。"""
    return input_tokens * MICRO_YUAN_PER_INPUT_TOKEN + output_tokens * MICRO_YUAN_PER_OUTPUT_TOKEN
```

- [ ] **Step 2:** `credit_repo.py` 加方法：
```python
    async def get_account(self, user_id: int) -> CreditAccount | None:
        return await self._s.scalar(select(CreditAccount).where(CreditAccount.user_id == user_id))
```

- [ ] **Step 3:** 测试 `server/tests/test_pricing.py`：
```python
from app.services.pricing import cost_micro


def test_cost_micro_passthrough():
    assert cost_micro(1_000_000, 0) == 1_000_000   # ¥1 / 1M 输入
    assert cost_micro(0, 1_000_000) == 2_000_000   # ¥2 / 1M 输出
    assert cost_micro(40, 12) == 40 + 24
    assert cost_micro(0, 0) == 0
```
`test_credit_repo.py` 追加：
```python
from app.db.models import CreditAccount  # 顶部已可加


async def test_get_account_none_then_present(db_session):
    async with async_session() as s:
        repo = CreditRepo(s)
        assert await repo.get_account(9) is None
        await repo.grant(9, 1_000_000, "grant")
    async with async_session() as s:
        acct = await CreditRepo(s).get_account(9)
        assert acct is not None and acct.balance_micro == 1_000_000
```

- [ ] **Step 4:** `cd server && uv run pytest tests/test_pricing.py tests/test_credit_repo.py -v` → 全 PASS。

- [ ] **Step 5:** Commit `feat(credits): 扣费费率 cost_micro + CreditRepo.get_account`

---

### Task 2: 端点接入扣费 + 门控

- [ ] **Step 1:** `translate.py` import 加：
```python
from app.services.credit_repo import CreditRepo
from app.services.pricing import cost_micro
```
依赖加（get_tier 后）：
```python
async def get_credits() -> AsyncIterator[CreditRepo]:
    async with async_session() as s:
        yield CreditRepo(s)
```
端点签名加 `credits=Depends(get_credits),`。

- [ ] **Step 2:** 把 tier-block 段替换为付费/免费分支：
```python
    # 登录用户分两类：① 有 credits 账户＝付费模式（余额门控 + 实耗扣费，跳梯度限流）；
    # ② 无账户＝免费模式（梯度限流，现状不变）。无人充值前无账户 → 行为零变化（休眠）。
    account = await credits.get_account(user_id) if user_id is not None else None
    is_credit_user = account is not None
    tier_block_msg = None
    credit_block_msg = None
    if is_credit_user:
        if account.balance_micro <= 0:
            credit_block_msg = "额度不足，请充值后继续"
    elif user_id is not None:
        tev = await tier.evaluate(user_id, local_date)
        if not tev.allowed:
            tier_block_msg = tev.notice
```

- [ ] **Step 3:** `gen()` 加余额门控（tier_block 段后）：
```python
        if credit_block_msg is not None:
            yield _sse("quota", {"message": credit_block_msg})
            return
```
UsageEvent 段加扣费：
```python
            elif isinstance(ev, UsageEvent):
                if user_id is not None:
                    await daily.add(user_id, local_date, ev.input_tokens, ev.output_tokens, pages=1)
                # 付费模式：按实耗扣 credits（micro-¥）。免费用户无账户、不扣。
                if is_credit_user:
                    await credits.deduct(user_id, cost_micro(ev.input_tokens, ev.output_tokens))
```

- [ ] **Step 4:** `test_translate_endpoint.py`：`override` 夹具加 `app.dependency_overrides[get_credits] = lambda: FakeCreditsNone()`；加：
```python
from types import SimpleNamespace

class FakeCreditsNone:
    async def get_account(self, user_id): return None
    async def deduct(self, user_id, amount, kind="deduct"): return 0

class FakeCredits:
    def __init__(self, balance): self.balance = balance; self.deducted = []
    async def get_account(self, user_id): return SimpleNamespace(user_id=user_id, balance_micro=self.balance)
    async def deduct(self, user_id, amount, kind="deduct"):
        self.deducted.append(amount); self.balance -= amount; return self.balance
```
（`get_credits` 从 `app.routers.translate` import）两个用例：
```python
async def test_credit_user_deducts(override):
    fake = FakeCredits(balance=10_000_000)
    app.dependency_overrides[get_credits] = lambda: fake
    app.dependency_overrides[current_user_optional] = lambda: 5
    try:
        async with _client_for(override) as c:  # 见文件既有 client 构造
            resp = await c.post("/v1/translate",
                json={"blocks": [{"id": "b1", "source": "Hi"}]},
                headers={"Authorization": "Bearer x"})
        kinds = [e for e, _ in parse_sse(resp.text)]
        assert "block" in kinds and "done" in kinds
        assert fake.deducted and fake.deducted[0] > 0
    finally:
        app.dependency_overrides.pop(get_credits, None)
        app.dependency_overrides.pop(current_user_optional, None)


async def test_credit_user_zero_balance_blocked(override):
    app.dependency_overrides[get_credits] = lambda: FakeCredits(balance=0)
    app.dependency_overrides[current_user_optional] = lambda: 6
    try:
        async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post("/v1/translate",
                json={"blocks": [{"id": "b1", "source": "Hi"}]},
                headers={"Authorization": "Bearer x"})
        kinds = [e for e, _ in parse_sse(resp.text)]
        assert "quota" in kinds and "block" not in kinds
    finally:
        app.dependency_overrides.pop(get_credits, None)
        app.dependency_overrides.pop(current_user_optional, None)
```
（用文件里既有的 httpx client 构造方式即可，不必引 `_client_for`。）

- [ ] **Step 5:** `cd server && uv run pytest` → 全绿（含新用例；既有登录用例因 `FakeCreditsNone` 走免费路径不变）。

- [ ] **Step 6:** 文档同步 `server/CLAUDE.md` 关键流程「翻译」加付费分支；API 表面 translate 注明余额门控/扣费。

- [ ] **Step 7:** Commit `feat(translate): 付费用户余额门控 + 实耗扣 credits（休眠至首次充值）`

---

## Self-Review
**1. 休眠安全：** 无 `credit_accounts` 行＝免费路径，行为零变化；无人充值前无账户 → 线上无影响。
**2. 分支正确：** 付费用户跳梯度限流走余额门控；免费用户保留梯度限流；匿名走页配额（均不变）。
**3. 整数费率：** `cost_micro` 整数；常数化便于加毛利。
**遗留：** 命中/未命中分档计价（需 UsageEvent 带 cache-hit 拆分）；D-04 全员 credits-only 一次性切换；支付 webhook→grant（须账号/Key）；赠送¥2 防薅指纹；`/v1/usage` 暴露 credits 余额给 popup。
