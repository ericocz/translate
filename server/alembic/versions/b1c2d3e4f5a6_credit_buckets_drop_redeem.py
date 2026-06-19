"""credit_txns 多币种分桶 + 取消买断（drop redeem 表）

商业化调整（2026-06-19）：取消买断，Creem 改为 $9.9 充值美元额度。
- credit_txns 加 `bucket` 列（gift_cny|recharge_cny|recharge_usd）：
  扣费按固定优先级只动单一桶、用该桶币种三档价计，不做汇率换算。
  历史回填：kind='gift' → gift_cny，其余 → recharge_cny（历史均人民币）。
- drop redeem_activations / redeem_codes 表（买断注册码整套下线，BYOK 随之移除）。

Revision ID: b1c2d3e4f5a6
Revises: a6b7c8d9e0f1
"""
from alembic import op
import sqlalchemy as sa

revision = "b1c2d3e4f5a6"
down_revision = "a6b7c8d9e0f1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "credit_txns",
        sa.Column("bucket", sa.String(length=16), nullable=False, server_default="recharge_cny"),
    )
    # 历史行回填：赠送进 gift_cny，其余（充值/扣费/调额）历史均人民币 → recharge_cny（默认已是）。
    op.execute("UPDATE credit_txns SET bucket = 'gift_cny' WHERE kind = 'gift'")

    # 买断注册码整套下线：先删 activation（FK 依赖 redeem_codes），再删 codes。
    op.drop_table("redeem_activations")
    op.drop_table("redeem_codes")


def downgrade() -> None:
    op.create_table(
        "redeem_codes",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("code", sa.String(length=32), nullable=False, unique=True),
        sa.Column("email", sa.String(length=255), nullable=False, index=True),
        sa.Column("product", sa.String(length=32), nullable=False, server_default="buyout"),
        sa.Column("source", sa.String(length=16), nullable=False),
        sa.Column("source_ref", sa.String(length=128), nullable=False, unique=True),
        sa.Column("max_devices", sa.Integer(), nullable=False, server_default="5"),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="active"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_table(
        "redeem_activations",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column(
            "code_id",
            sa.BigInteger(),
            sa.ForeignKey("redeem_codes.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("device_id", sa.String(length=64), nullable=False),
        sa.Column("activated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("code_id", "device_id", name="uq_redeem_activation_code_device"),
    )
    op.drop_column("credit_txns", "bucket")
