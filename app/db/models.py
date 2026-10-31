import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text, Uuid, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class Post(Base):
    """게시물 1건. 사진(최대 4장)마다 작업을 하나씩 만들어 묶는다. 원본 글은 저장하지 않는다."""

    __tablename__ = "posts"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    jobs: Mapped[list["Job"]] = relationship(back_populates="post", order_by="Job.position")


class Job(Base):
    """작업 1건. 진행 중 세부 단계는 Redis에만 있고, DB에는 QUEUED / DONE / FAILED만 기록한다."""

    __tablename__ = "jobs"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    input_type: Mapped[str] = mapped_column(String(10))
    status: Mapped[str] = mapped_column(String(20), default="QUEUED", index=True)
    object_key: Mapped[str | None] = mapped_column(String(255))
    input_sha256: Mapped[str | None] = mapped_column(String(64))
    execution_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    result_object_key: Mapped[str | None] = mapped_column(String(255))
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # 게시물에 속한 작업이면 게시물 안의 순서 (0부터, 사진 순서와 같다)
    post_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("posts.id", ondelete="CASCADE"), index=True
    )
    position: Mapped[int | None] = mapped_column(Integer)

    result: Mapped["JobResult | None"] = relationship(back_populates="job", uselist=False)
    post: Mapped[Post | None] = relationship(back_populates="jobs")


class JobResult(Base):
    """워커 결과. AI 쪽 구조가 자주 바뀌므로 탐지 상세는 JSONB 그대로 저장한다."""

    __tablename__ = "job_results"

    job_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("jobs.id", ondelete="CASCADE"), primary_key=True
    )
    schema_version: Mapped[int] = mapped_column(Integer)
    risk_detected: Mapped[bool | None] = mapped_column(Boolean)
    risk_before: Mapped[float | None] = mapped_column(Float)
    risk_after: Mapped[float | None] = mapped_column(Float)
    iterations: Mapped[int] = mapped_column(Integer, default=0)
    result_text: Mapped[str | None] = mapped_column(Text)
    findings: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list)
    details: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    job: Mapped[Job] = relationship(back_populates="result")
