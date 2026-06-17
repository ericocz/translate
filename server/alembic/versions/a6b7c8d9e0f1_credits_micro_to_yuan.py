"""credits: 改为账本派生余额（方案 B）+ 元高精度

额度账本重构（方案 B）：余额不再存运行值，改由 `credit_txns` 流水加总得出。
- 删表 `credit_accounts`（余额/存在性都从流水派生）。
- `credit_txns.delta_micro`(BigInteger micro-¥) → `delta` NUMERIC(18,10)（元，高精度，
  承载按 token 三档计价的亚分级成本：输入未命中 ¥1/M、输入命中 ¥0.02/M、输出 ¥2/M，×1.3）。
  存量按 /1_000_000 换算（micro 6 位小数 ≤ 10，无损）。
- 删 `credit_txns.balance_after`（可由流水派生，不再维护）。

Revision ID: a6b7c8d9e0f1
Revises: f4a5b6c7d8e9
"""
from alembic import op
import sqlalchemy as sa

revision = "a6b7c8d9e0f1"
down_revision = "f4a5b6c7d8e9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_column("credit_txns", "balance_after")
    op.alter_column(
        "credit_txns", "delta_micro",
        new_column_name="delta",
        type_=sa.Numeric(18, 10),
        existing_nullable=False,
        postgresql_using="delta_micro / 1000000.0",
    )
    op.drop_table("credit_accounts")


def downgrade() -> None:
    # best-effort 回退（dev 便利，不追求 balance_after 历史精确）。
    op.create_table(
        "credit_accounts",
        sa.Column("owner", sa.String(length=80), primary_key=True),
        sa.Column("balance_micro", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.alter_column(
        "credit_txns", "delta",
        new_column_name="delta_micro",
        type_=sa.BigInteger(),
        existing_nullable=False,
        postgresql_using="round(delta * 1000000)",
    )
    op.add_column(
        "credit_txns",
        sa.Column("balance_after", sa.BigInteger(), nullable=False, server_default="0"),
    )
    # 由流水回填各 owner 余额。
    op.execute(
        "INSERT INTO credit_accounts (owner, balance_micro) "
        "SELECT owner, COALESCE(SUM(delta_micro), 0) FROM credit_txns GROUP BY owner"
    )
    op.alter_column("credit_txns", "balance_after", server_default=None)
    op.alter_column("credit_accounts", "balance_micro", server_default=None)
