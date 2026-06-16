"""redeem_activations: 买断码激活绑定设备

一行 = 一个买断 code 在一台设备上激活；唯一 (code_id, device_id) 保证同设备重复激活幂等，
每 code 至多 redeem_codes.max_devices 行。

Revision ID: f4a5b6c7d8e9
Revises: e3f4a5b6c7d8
Create Date: 2026-06-16
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f4a5b6c7d8e9'
down_revision: Union[str, Sequence[str], None] = 'e3f4a5b6c7d8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'redeem_activations',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('code_id', sa.BigInteger(), nullable=False),
        sa.Column('device_id', sa.String(length=64), nullable=False),
        sa.Column('activated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.ForeignKeyConstraint(['code_id'], ['redeem_codes.id'], ondelete='CASCADE'),
        sa.UniqueConstraint('code_id', 'device_id', name='uq_redeem_activation_code_device'),
    )
    op.create_index('ix_redeem_activations_code_id', 'redeem_activations', ['code_id'])


def downgrade() -> None:
    op.drop_index('ix_redeem_activations_code_id', table_name='redeem_activations')
    op.drop_table('redeem_activations')
