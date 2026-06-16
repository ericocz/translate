"""owner-ize credit accounts + drop freemium tables (anon_usage, quota_tier)

credit_accounts/credit_txns 主键从 user_id(int) 泛化为 owner(str)：
登录用户 'u:{user_id}'、未注册设备 'd:{device_id}'（领赠送用）。**保数据 alter**
（现有 user_id 行迁成 'u:{id}'，不丢余额）。同时下线 freemium：drop anon_usage / quota_tier。

Revision ID: e3f4a5b6c7d8
Revises: d2e3f4a5b6c7
Create Date: 2026-06-16
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e3f4a5b6c7d8'
down_revision: Union[str, Sequence[str], None] = 'd2e3f4a5b6c7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- credit_accounts: user_id(int) → owner(str)，保数据 ---
    op.add_column('credit_accounts', sa.Column('owner', sa.String(length=80), nullable=True))
    op.execute("UPDATE credit_accounts SET owner = 'u:' || user_id")
    op.drop_constraint('credit_accounts_pkey', 'credit_accounts', type_='primary')
    op.alter_column('credit_accounts', 'owner', nullable=False)
    op.create_primary_key('credit_accounts_pkey', 'credit_accounts', ['owner'])
    op.drop_column('credit_accounts', 'user_id')

    # --- credit_txns: user_id(int) → owner(str)，保数据 ---
    op.add_column('credit_txns', sa.Column('owner', sa.String(length=80), nullable=True))
    op.execute("UPDATE credit_txns SET owner = 'u:' || user_id")
    op.alter_column('credit_txns', 'owner', nullable=False)
    op.drop_index('ix_credit_txns_user_id', table_name='credit_txns')
    op.create_index('ix_credit_txns_owner', 'credit_txns', ['owner'])
    op.drop_column('credit_txns', 'user_id')

    # --- 下线 freemium ---
    op.drop_table('anon_usage')
    op.drop_table('quota_tier')


def downgrade() -> None:
    # 重建 freemium 表
    op.create_table(
        'anon_usage',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('device_id', sa.String(length=64), nullable=False),
        sa.Column('local_date', sa.String(length=10), nullable=False),
        sa.Column('page_key', sa.String(length=32), nullable=False),
        sa.Column('ip', sa.String(length=64), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('device_id', 'local_date', 'page_key', name='uq_anon_device_date_page'),
    )
    op.create_table(
        'quota_tier',
        sa.Column('user_id', sa.BigInteger(), nullable=False),
        sa.Column('tier', sa.Integer(), nullable=False),
        sa.Column('strikes', sa.Integer(), nullable=False),
        sa.Column('clean_days', sa.Integer(), nullable=False),
        sa.Column('last_day', sa.String(length=10), nullable=True),
        sa.Column('notice', sa.String(length=255), nullable=True),
        sa.PrimaryKeyConstraint('user_id'),
    )

    # credit_txns: owner → user_id（仅 'u:%' 可逆；'d:%' 设备账户旧 schema 无处放 → 删）
    op.add_column('credit_txns', sa.Column('user_id', sa.BigInteger(), nullable=True))
    op.execute("DELETE FROM credit_txns WHERE owner NOT LIKE 'u:%'")
    op.execute("UPDATE credit_txns SET user_id = CAST(substring(owner from 3) AS BIGINT)")
    op.alter_column('credit_txns', 'user_id', nullable=False)
    op.drop_index('ix_credit_txns_owner', table_name='credit_txns')
    op.create_index('ix_credit_txns_user_id', 'credit_txns', ['user_id'])
    op.drop_column('credit_txns', 'owner')

    # credit_accounts: owner → user_id（同上，设备账户删）
    op.add_column('credit_accounts', sa.Column('user_id', sa.BigInteger(), nullable=True))
    op.execute("DELETE FROM credit_accounts WHERE owner NOT LIKE 'u:%'")
    op.execute("UPDATE credit_accounts SET user_id = CAST(substring(owner from 3) AS BIGINT)")
    op.drop_constraint('credit_accounts_pkey', 'credit_accounts', type_='primary')
    op.alter_column('credit_accounts', 'user_id', nullable=False)
    op.create_primary_key('credit_accounts_pkey', 'credit_accounts', ['user_id'])
    op.drop_column('credit_accounts', 'owner')
