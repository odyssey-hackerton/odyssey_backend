"""Bind each execution to its temporary image and original file fingerprint."""

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("jobs", sa.Column("input_sha256", sa.String(64), nullable=True))
    op.add_column("jobs", sa.Column("execution_id", sa.Uuid(), nullable=True))


def downgrade() -> None:
    op.drop_column("jobs", "execution_id")
    op.drop_column("jobs", "input_sha256")
