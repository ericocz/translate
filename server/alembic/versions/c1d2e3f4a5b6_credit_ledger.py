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
