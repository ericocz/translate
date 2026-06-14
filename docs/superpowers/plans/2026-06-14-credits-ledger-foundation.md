# Credits 账本地基（D-02/D-03 基座）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`).

**Goal:** 预付额度（credits）的**账本核心**：每用户余额 + 流水（发放/扣减），幂等发放（webhook 重投不重复入账），整数 **micro-¥（1e-6 元）** 记账不用浮点。**纯后端、加性**——只加表 + 服务 + 测试，**不接入翻译流、不动现有免费层/限流**（零线上行为变化）。

**Architecture:** 充值/买断/赠送/扣减都最终落到这层。`CreditAccount`（余额）+ `CreditTxn`（流水，`idempotency_key` 唯一防重复发放）。`CreditRepo` 暴露 `grant`（幂等，靠唯一约束在并发下也只入一次）/`deduct`/`get_balance`，账户余额用 PG `on_conflict ... balance + delta RETURNING` 原子更新（与 `DailyUsageRepo` 同范式）。后续切片才把 `deduct` 接进 `/v1/translate`（须先定**卖价费率 ¥/token** 与 **D-04 免费层下线时机**——本计划不碰）。

**Tech Stack:** SQLAlchemy 2.0 async + asyncpg + Alembic（手写迁移，down_revision=当前 head `b9d2c1f4e7a3`）；pytest（用 `db_session` 夹具打真实 dev 库）。

**Decision source:** 蓝图 V2 D-02/D-03 + §统一 credits 账本（webhook→发放函数 + 幂等键 + 验签）+ 充值档 1/5/10/20/100 元 + 赠送¥2 + 按 Token 实耗扣减。

**未定/不在本计划（需用户拍板，后续切片）：** ① 扣费**卖价费率**（¥/token）；② **D-04 免费层下线切换时机**；③ 支付商账号/Key + webhook（Stripe HK / YunGouOS）；④ 赠送¥2 防薅三件套（指纹）。

---

## File Structure
- `server/app/db/models.py` — 加 `CreditAccount` + `CreditTxn`。
- `server/app/services/credit_repo.py` — **新增** `CreditRepo`。
- `server/alembic/versions/c1d2e3f4a5b6_credit_ledger.py` — **新增**建两表。
- `server/tests/test_credit_repo.py` — **新增**。
- `server/CLAUDE.md` — 数据模型 + 模块同步。

---

### Task 1: 模型 + 仓库 + 测试（先红）

- [ ] **Step 1: 加模型** `server/app/db/models.py` 末尾追加：

```python
class CreditAccount(Base):
    """用户预付额度余额。整数 micro-¥（1e-6 元）记账，不用浮点。"""

    __tablename__ = "credit_accounts"

    user_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    balance_micro: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class CreditTxn(Base):
    """额度流水：发放(grant/gift) / 扣减(deduct) / 退款(refund)。
    idempotency_key 唯一 → webhook 重投/并发只入账一次（DB 约束兜底）。"""

    __tablename__ = "credit_txns"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(BigInteger, nullable=False, index=True)
    delta_micro: Mapped[int] = mapped_column(BigInteger, nullable=False)  # +发放 / -扣减
    kind: Mapped[str] = mapped_column(String(16), nullable=False)  # grant|gift|deduct|refund
    balance_after: Mapped[int] = mapped_column(BigInteger, nullable=False)
    idempotency_key: Mapped[str | None] = mapped_column(String(128), unique=True, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
```

- [ ] **Step 2: 写仓库** `server/app/services/credit_repo.py`：

```python
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import CreditAccount, CreditTxn


class CreditRepo:
    """预付额度账本：发放（幂等）/ 扣减 / 查余额。余额以整数 micro-¥ 原子更新。
    注：deduct 不防透支（可短暂为负）——是否拦截在余额≤0 由调用方门控（接入翻译流的后续切片做）。"""

    def __init__(self, session: AsyncSession) -> None:
        self._s = session

    async def get_balance(self, user_id: int) -> int:
        row = await self._s.scalar(select(CreditAccount).where(CreditAccount.user_id == user_id))
        return int(row.balance_micro if row else 0)

    async def grant(
        self, user_id: int, amount_micro: int, kind: str = "grant", idempotency_key: str | None = None
    ) -> int:
        """发放额度（充值/赠送/买断）。带 idempotency_key 时重复/并发只入账一次。返回新余额。"""
        try:
            return await self._apply(user_id, amount_micro, kind, idempotency_key)
        except IntegrityError:
            await self._s.rollback()  # idempotency_key 唯一冲突＝已入账过
            return await self.get_balance(user_id)

    async def deduct(self, user_id: int, amount_micro: int, kind: str = "deduct") -> int:
        """扣减额度（实耗）。返回新余额。"""
        return await self._apply(user_id, -amount_micro, kind, None)

    async def _apply(self, user_id: int, delta: int, kind: str, idempotency_key: str | None) -> int:
        stmt = (
            insert(CreditAccount)
            .values(user_id=user_id, balance_micro=delta)
            .on_conflict_do_update(
                index_elements=["user_id"],
                set_={"balance_micro": CreditAccount.balance_micro + delta},
            )
            .returning(CreditAccount.balance_micro)
        )
        new_balance = int(await self._s.scalar(stmt))
        self._s.add(
            CreditTxn(
                user_id=user_id, delta_micro=delta, kind=kind,
                balance_after=new_balance, idempotency_key=idempotency_key,
            )
        )
        await self._s.commit()
        return new_balance
```

- [ ] **Step 3: 写测试** `server/tests/test_credit_repo.py`（用 `db_session` 夹具，模式同 `test_auth_endpoints`）：

```python
from app.db.base import async_session
from app.db.models import CreditTxn
from app.services.credit_repo import CreditRepo
from sqlalchemy import func, select


async def _mk_user(repo_session) -> int:
    # credit 表只存 user_id（无外键约束到 users），直接用任意 id 即可。
    return 1


async def test_grant_accumulates(db_session):
    async with async_session() as s:
        repo = CreditRepo(s)
        assert await repo.get_balance(1) == 0
        assert await repo.grant(1, 5_000_000, "grant") == 5_000_000  # ¥5
        assert await repo.grant(1, 1_000_000, "grant") == 6_000_000  # +¥1
        assert await repo.get_balance(1) == 6_000_000


async def test_grant_idempotent(db_session):
    async with async_session() as s:
        repo = CreditRepo(s)
        assert await repo.grant(2, 5_000_000, "grant", idempotency_key="wh-1") == 5_000_000
        # 同 key 重投：不重复入账
        assert await repo.grant(2, 5_000_000, "grant", idempotency_key="wh-1") == 5_000_000
        assert await repo.get_balance(2) == 5_000_000
    async with async_session() as s:
        cnt = await s.scalar(select(func.count()).select_from(CreditTxn).where(CreditTxn.user_id == 2))
        assert cnt == 1


async def test_deduct_reduces(db_session):
    async with async_session() as s:
        repo = CreditRepo(s)
        await repo.grant(3, 2_000_000, "gift")
        assert await repo.deduct(3, 500_000) == 1_500_000
        assert await repo.get_balance(3) == 1_500_000


async def test_txn_log_has_balance_after(db_session):
    async with async_session() as s:
        repo = CreditRepo(s)
        await repo.grant(4, 1_000_000, "grant")
        await repo.deduct(4, 300_000)
    async with async_session() as s:
        rows = (await s.scalars(select(CreditTxn).where(CreditTxn.user_id == 4).order_by(CreditTxn.id))).all()
        assert [r.balance_after for r in rows] == [1_000_000, 700_000]
        assert [r.kind for r in rows] == ["grant", "deduct"]
```

- [ ] **Step 4: 跑测试**

Run: `cd server && uv run pytest tests/test_credit_repo.py -v`
Expected: 4 PASS（`db_session` 建表 → 跑 → TRUNCATE）。

- [ ] **Step 5: Commit**
```bash
cd server && git add app/db/models.py app/services/credit_repo.py tests/test_credit_repo.py
git commit -m "feat(credits): credits 账本模型 + 幂等发放/扣减仓库（钱包地基）"
```

---

### Task 2: 迁移 + 全量 + 文档

- [ ] **Step 1: 写迁移** `server/alembic/versions/c1d2e3f4a5b6_credit_ledger.py`：

```python
"""credit ledger: credit_accounts + credit_txns（钱包地基）

Revision ID: c1d2e3f4a5b6
Revises: b9d2c1f4e7a3
Create Date: 2026-06-14
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c1d2e3f4a5b6'
down_revision: Union[str, Sequence[str], None] = 'b9d2c1f4e7a3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'credit_accounts',
        sa.Column('user_id', sa.BigInteger(), nullable=False),
        sa.Column('balance_micro', sa.BigInteger(), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('user_id'),
    )
    op.create_table(
        'credit_txns',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('user_id', sa.BigInteger(), nullable=False),
        sa.Column('delta_micro', sa.BigInteger(), nullable=False),
        sa.Column('kind', sa.String(length=16), nullable=False),
        sa.Column('balance_after', sa.BigInteger(), nullable=False),
        sa.Column('idempotency_key', sa.String(length=128), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('idempotency_key', name='uq_credit_txn_idem'),
    )
    op.create_index('ix_credit_txns_user_id', 'credit_txns', ['user_id'])


def downgrade() -> None:
    op.drop_index('ix_credit_txns_user_id', table_name='credit_txns')
    op.drop_table('credit_txns')
    op.drop_table('credit_accounts')
```

- [ ] **Step 2: 应用迁移 + 全量测试**

Run: `cd server && uv run alembic upgrade head && uv run pytest -q`
Expected: 迁移到 `c1d2e3f4a5b6`；全绿（含 4 个新用例）。

- [ ] **Step 3: 文档同步** `server/CLAUDE.md` 数据模型段加 `credit_accounts` / `credit_txns`（预付额度余额 + 流水，整数 micro-¥，幂等发放）；模块段 services 加 `credit_repo.py`。

- [ ] **Step 4: Commit**
```bash
cd server && git add alembic/versions/c1d2e3f4a5b6_credit_ledger.py CLAUDE.md
git commit -m "feat(credits): 建表迁移 + 数据模型/模块文档同步（钱包地基）"
```

---

## Self-Review
**1. 加性安全：** 只加表 + 服务 + 测试，不接翻译流、不动免费层/限流 → 零线上行为变化。
**2. 幂等正确：** `idempotency_key` 唯一约束 + `IntegrityError` 回滚兜底 → webhook 重投/并发只入账一次；余额 `balance + delta RETURNING` 原子（无读改写竞态）。
**3. 整数记账：** micro-¥（1e-6 元）整数，避免浮点；档位 ¥1=1_000_000、赠送¥2=2_000_000。
**遗留（后续切片，须用户拍板）：** 卖价费率 ¥/token、D-04 免费层下线时机、支付 webhook（Stripe/YunGouOS）+ 验签、赠送¥2 防薅指纹、`deduct` 透支门控接入 `/v1/translate`。
