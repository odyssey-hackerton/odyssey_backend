"""Group up to four photo jobs and their caption into one post."""

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "posts",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.add_column(
        "jobs",
        sa.Column(
            "post_id", sa.Uuid(), sa.ForeignKey("posts.id", ondelete="CASCADE"), nullable=True
        ),
    )
    op.add_column("jobs", sa.Column("position", sa.Integer(), nullable=True))
    op.create_index("ix_jobs_post_id", "jobs", ["post_id"])


def downgrade() -> None:
    op.drop_index("ix_jobs_post_id", table_name="jobs")
    op.drop_column("jobs", "position")
    op.drop_column("jobs", "post_id")
    op.drop_table("posts")
