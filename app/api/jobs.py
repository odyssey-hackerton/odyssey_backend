import asyncio
import json
import logging
import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from sse_starlette.sse import EventSourceResponse

from app.api.deps import RedisDep, SessionDep, SettingsDep, StorageDep
from app.db.models import Job
from app.queue.producer import enqueue_job
from app.queue.progress import get_progress, set_progress
from app.schemas.contract import FINAL_STATUSES, JobMessage, JobOptions, JobStatus
from app.schemas.jobs import JobCreated, JobReportOut, JobResultOut, JobStatusOut
from app.services.uploads import detect_image_type
from app.storage.s3 import original_key

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/jobs", tags=["jobs"])

SSE_POLL_SECONDS = 0.5
SSE_MAX_SECONDS = 600


async def _get_job(session: SessionDep, job_id: uuid.UUID, with_result: bool = False) -> Job:
    stmt = select(Job).where(Job.id == job_id)
    if with_result:
        stmt = stmt.options(selectinload(Job.result))
    job = (await session.execute(stmt)).scalar_one_or_none()
    if job is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "job not found")
    return job


@router.post("", status_code=status.HTTP_202_ACCEPTED, response_model=JobCreated)
async def create_job(
    session: SessionDep,
    redis: RedisDep,
    storage: StorageDep,
    settings: SettingsDep,
    file: Annotated[UploadFile | None, File(description="이미지 (jpg, png, webp)")] = None,
    text: Annotated[str | None, Form(description="텍스트 (카톡 메시지 등)")] = None,
) -> JobCreated:
    """이미지 또는 텍스트 중 하나를 받아 작업을 등록하고 바로 job_id를 돌려준다."""
    if (file is None) == (not text):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "file 또는 text 중 하나만 보내세요"
        )

    job_id = uuid.uuid4()
    object_key: str | None = None

    if file is not None:
        data = await file.read(settings.max_upload_bytes + 1)
        if len(data) > settings.max_upload_bytes:
            raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "파일이 너무 큽니다")
        image_type = detect_image_type(data[:16])
        if image_type is None:
            raise HTTPException(
                status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "jpg, png, webp 이미지만 지원합니다"
            )
        object_key = original_key(str(job_id), image_type.ext)
        await storage.put(object_key, data, image_type.content_type)
        input_type = "image"
    else:
        if len(text) > settings.max_text_chars:
            raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "텍스트가 너무 깁니다")
        input_type = "text"

    job = Job(id=job_id, input_type=input_type, status=JobStatus.QUEUED, object_key=object_key)
    session.add(job)
    await session.commit()

    message = JobMessage(
        job_id=job_id,
        input_type=input_type,
        object_key=object_key,
        text=text if input_type == "text" else None,
        options=JobOptions(max_iterations=settings.max_iterations),
        created_at=datetime.now(UTC),
    )
    try:
        await set_progress(
            redis, str(job_id), JobStatus.QUEUED, ttl_seconds=settings.progress_ttl_seconds
        )
        await enqueue_job(redis, settings.jobs_stream, message, settings.stream_maxlen)
    except Exception:
        logger.exception("enqueue failed for job %s", job_id)
        job.status = JobStatus.FAILED
        job.error = "enqueue failed"
        await session.commit()
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "작업 등록에 실패했습니다"
        ) from None

    return JobCreated(job_id=job_id, status=JobStatus.QUEUED)


def _status_out(job: Job, progress: dict[str, str]) -> JobStatusOut:
    # DB가 최종 상태면 DB 기준, 아니면 워커가 갱신하는 Redis 진행 상태 기준
    if job.status in FINAL_STATUSES or not progress:
        current, iteration, message = job.status, 0, None
    else:
        current = progress.get("status", job.status)
        if current in FINAL_STATUSES:
            current = JobStatus.VERIFYING  # DB 저장 전이면 아직 끝나지 않은 것으로 본다
        iteration = int(progress.get("iteration") or 0)
        message = progress.get("message") or None
    return JobStatusOut(
        job_id=job.id,
        input_type=job.input_type,
        status=current,
        iteration=iteration,
        message=message,
        created_at=job.created_at,
        finished_at=job.finished_at,
        error=job.error,
    )


@router.get("/{job_id}", response_model=JobStatusOut)
async def get_job(job_id: uuid.UUID, session: SessionDep, redis: RedisDep) -> JobStatusOut:
    job = await _get_job(session, job_id)
    return _status_out(job, await get_progress(redis, str(job_id)))


@router.get("/{job_id}/events")
async def job_events(
    job_id: uuid.UUID, request: Request, session: SessionDep, redis: RedisDep
) -> EventSourceResponse:
    """진행 단계를 SSE로 보낸다.

    상태가 바뀔 때마다 `progress` 이벤트, 끝나면 `done` 이벤트를 보내고 종료한다.
    """
    await _get_job(session, job_id)
    session_factory = request.app.state.session_factory

    async def stream():
        last = None
        loop = asyncio.get_running_loop()
        deadline = loop.time() + SSE_MAX_SECONDS
        while loop.time() < deadline:
            if await request.is_disconnected():
                return
            async with session_factory() as s:
                job = await s.get(Job, job_id)
            out = _status_out(job, await get_progress(redis, str(job_id)))
            snapshot = (out.status, out.iteration, out.message)
            if snapshot != last:
                last = snapshot
                event = "done" if out.status in FINAL_STATUSES else "progress"
                yield {"event": event, "data": out.model_dump_json()}
                if event == "done":
                    return
            await asyncio.sleep(SSE_POLL_SECONDS)
        yield {"event": "timeout", "data": json.dumps({"job_id": str(job_id)})}

    return EventSourceResponse(stream(), ping=15)


@router.get("/{job_id}/result", response_model=JobResultOut)
async def get_result(
    job_id: uuid.UUID, session: SessionDep, storage: StorageDep, settings: SettingsDep
) -> JobResultOut:
    """보호 처리된 결과. 이미지는 S3 presigned URL(짧은 만료)로만 내려준다."""
    job = await _get_job(session, job_id, with_result=True)
    if job.status != JobStatus.DONE:
        raise HTTPException(status.HTTP_409_CONFLICT, f"job is {job.status}")
    if job.input_type == "text":
        return JobResultOut(type="text", text=job.result.result_text if job.result else None)
    if not job.result_object_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "result image not found")
    url = storage.presign_get(job.result_object_key, settings.presign_expires_seconds)
    return JobResultOut(type="image", url=url, expires_in=settings.presign_expires_seconds)


@router.get("/{job_id}/report", response_model=JobReportOut)
async def get_report(job_id: uuid.UUID, session: SessionDep) -> JobReportOut:
    job = await _get_job(session, job_id, with_result=True)
    if job.status != JobStatus.DONE or job.result is None:
        raise HTTPException(status.HTTP_409_CONFLICT, f"job is {job.status}")
    r = job.result
    return JobReportOut(
        job_id=job.id,
        risk_detected=r.risk_detected,
        risk_before=r.risk_before,
        risk_after=r.risk_after,
        iterations=r.iterations,
        findings=r.findings,
        details=r.details,
    )
