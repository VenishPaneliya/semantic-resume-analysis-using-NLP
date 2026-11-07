"""job openings and applications (leaderboards, standing)

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-08 10:00:00
"""
from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None

JSONType = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    op.create_table(
        "job_openings",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("posted_by", sa.String(length=36), nullable=True),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("company", sa.String(length=200), nullable=False),
        sa.Column("location", sa.String(length=200), nullable=True),
        sa.Column("work_arrangement", sa.String(length=16), nullable=True),
        sa.Column("employment_type", sa.String(length=16), nullable=True),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("extracted", JSONType, nullable=False),
        sa.Column("role_id", sa.String(length=64), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("is_demo", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["posted_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_job_openings_posted_by"), "job_openings", ["posted_by"], unique=False)
    op.create_index(op.f("ix_job_openings_status"), "job_openings", ["status"], unique=False)
    op.create_table(
        "opening_applications",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("opening_id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("version_id", sa.String(length=36), nullable=False),
        sa.Column("score", sa.Float(), nullable=False),
        sa.Column("result", JSONType, nullable=False),
        sa.Column("matcher_version", sa.String(length=32), nullable=False),
        sa.Column("stage", sa.String(length=16), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["opening_id"], ["job_openings.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["version_id"], ["resume_versions.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("opening_id", "user_id"),
    )
    op.create_index(op.f("ix_opening_applications_opening_id"), "opening_applications", ["opening_id"], unique=False)
    op.create_index(op.f("ix_opening_applications_user_id"), "opening_applications", ["user_id"], unique=False)
    op.create_index(op.f("ix_opening_applications_version_id"), "opening_applications", ["version_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_opening_applications_version_id"), table_name="opening_applications")
    op.drop_index(op.f("ix_opening_applications_user_id"), table_name="opening_applications")
    op.drop_index(op.f("ix_opening_applications_opening_id"), table_name="opening_applications")
    op.drop_table("opening_applications")
    op.drop_index(op.f("ix_job_openings_status"), table_name="job_openings")
    op.drop_index(op.f("ix_job_openings_posted_by"), table_name="job_openings")
    op.drop_table("job_openings")
