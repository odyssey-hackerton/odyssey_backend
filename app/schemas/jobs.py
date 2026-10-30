from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel


class JobCreated(BaseModel):
    job_id: UUID
    status: str


class JobStatusOut(BaseModel):
    job_id: UUID
    input_type: str
    status: str
    iteration: int = 0
    message: str | None = None
    created_at: datetime
    finished_at: datetime | None = None
    error: str | None = None


class JobResultOut(BaseModel):
    type: Literal["image", "text"]
    url: str | None = None
    expires_in: int | None = None
    text: str | None = None


class JobReportOut(BaseModel):
    job_id: UUID
    risk_detected: bool | None
    risk_before: float | None
    risk_after: float | None
    iterations: int
    findings: list[dict[str, Any]]
    details: dict[str, Any]
