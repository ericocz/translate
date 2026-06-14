"""drop translation_cache (D-11：服务端不再持有缓存)

Revision ID: b9d2c1f4e7a3
Revises: c0dcd9df17ec
Create Date: 2026-06-14

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b9d2c1f4e7a3'
down_revision: Union[str, Sequence[str], None] = 'c0dcd9df17ec'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_table('translation_cache')


def downgrade() -> None:
    op.create_table(
        'translation_cache',
        sa.Column('key', sa.String(length=80), nullable=False),
        sa.Column('translated', sa.Text(), nullable=False),
        sa.Column('input_tokens', sa.Integer(), nullable=False),
        sa.Column('output_tokens', sa.Integer(), nullable=False),
        sa.Column('hits', sa.BigInteger(), nullable=False),
        sa.Column('last_access', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('key'),
    )
