import asyncio
import json
import logging
import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import (
    APIRouter,
    File,
    Form,
    HTTPException,
    Path,
    Request,
    Response,
    UploadFile,
    status,
)
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from sse_starlette.sse import EventSourceResponse

from app.api.deps import RedisDep, SessionDep, SettingsDep, StorageDep
from app.db.models import Job
from app.queue.producer import enqueue_job
from app.queue.progress import get_progress, set_progress
from app.schemas.contract import FINAL_STATUSES, InputType, JobMessage, JobOptions, JobStatus
from app.schemas.jobs import ErrorOut, JobCreated, JobReportOut, JobResultOut, JobStatusOut
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


def input_type_of(*, has_image: bool, has_text: bool) -> InputType:
    if has_image and has_text:
        return "image_text"
    return "image" if has_image else "text"


def _err(description: str, example: str) -> dict:
    return {
        "model": ErrorOut,
        "description": description,
        "content": {"application/json": {"example": {"detail": example}}},
    }


NOT_FOUND = {404: _err("해당 작업이 없음", "job not found")}


class SSEResponse(Response):
    """Swagger에 응답 형식을 text/event-stream 으로 표시하기 위한 클래스."""

    media_type = "text/event-stream"


@router.post(
    "",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=JobCreated,
    summary="작업 등록 (사진·글 업로드)",
    response_description="등록됨. 처리는 백그라운드에서 진행된다.",
    responses={
        413: _err("파일이 10MB를 넘거나 글이 5,000자를 넘음", "파일이 너무 큽니다"),
        415: _err("jpg·png·webp가 아닌 파일", "jpg, png, webp 이미지만 지원합니다"),
        422: _err("`file`과 `text`가 둘 다 없음", "file 또는 text 중 하나 이상 보내세요"),
        503: _err("큐(Redis) 등록 실패. 잠시 후 다시 시도", "작업 등록에 실패했습니다"),
    },
)
async def create_job(
    session: SessionDep,
    redis: RedisDep,
    storage: StorageDep,
    settings: SettingsDep,
    file: Annotated[
        UploadFile | None,
        File(description="사진 (jpg, png, webp, 최대 10MB). 파일 내용으로 형식을 판별한다."),
    ] = None,
    text: Annotated[
        str | None,
        Form(
            description="글 (최대 5,000자). 사진과 같이 보내면 사진의 설명·본문으로 함께 분석한다.",
            examples=["오늘 서울 마포구 ○○로 12에서 만나요. 연락은 010-1234-5678"],
        ),
    ] = None,
) -> JobCreated:
    """사진, 글, 또는 **사진 + 글**을 `multipart/form-data`로 받아 작업을 등록한다.

    처리를 기다리지 않고 `job_id`를 바로 돌려준다.

    | 보낸 필드 | `input_type` | 결과 |
    |---|---|---|
    | `file` | `image` | 처리된 이미지 |
    | `text` | `text` | 가린 글 |
    | `file` + `text` | `image_text` | 처리된 이미지 + 가린 글 |

    사진과 글을 같이 보내면 AI가 둘을 한 작업에서 함께 분석한다 (예: SNS 게시물의 사진과 본문).
    원본 사진은 S3에 저장되고, 원본 글은 DB에 저장하지 않고 큐로만 AI 워커에 전달된다.

    등록 후에는 `GET /api/jobs/{job_id}/events`(SSE)로 진행 상황을 받고,
    `DONE`이 되면 `/result`와 `/report`를 조회한다.

    ```bash
    curl -X POST http://10.1.1.27/api/jobs -F file=@photo.jpg -F "text=본문 내용"
    ```
    """
    if text is not None and not text.strip():
        text = None
    if file is None and text is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "file 또는 text 중 하나 이상 보내세요"
        )
    if text is not None and len(text) > settings.max_text_chars:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "텍스트가 너무 깁니다")

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

    input_type = input_type_of(has_image=file is not None, has_text=text is not None)
    job = Job(id=job_id, input_type=input_type, status=JobStatus.QUEUED, object_key=object_key)
    session.add(job)
    await session.commit()

    message = JobMessage(
        job_id=job_id,
        input_type=input_type,
        object_key=object_key,
        text=text,
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


JobIdPath = Annotated[uuid.UUID, Path(description="작업 등록 때 받은 `job_id`")]


@router.get(
    "/{job_id}",
    response_model=JobStatusOut,
    summary="진행 상황 조회",
    responses=NOT_FOUND,
)
async def get_job(job_id: JobIdPath, session: SessionDep, redis: RedisDep) -> JobStatusOut:
    """현재 진행 상황을 한 번 조회한다.

    SSE(`/events`)를 쓸 수 없는 환경에서 1~2초 간격으로 호출하는 용도다.
    `status`가 `DONE` 또는 `FAILED`가 되면 끝난 것이다.
    """
    job = await _get_job(session, job_id)
    return _status_out(job, await get_progress(redis, str(job_id)))


SSE_EXAMPLE = """event: progress
data: {"job_id": "3f2b…", "input_type": "image_text", "status": "DETECTING", "iteration": 0, ...}

event: progress
data: {"job_id": "3f2b…", "input_type": "image_text", "status": "VERIFYING", "iteration": 1, ...}

event: done
data: {"job_id": "3f2b…", "input_type": "image_text", "status": "DONE", "iteration": 1, ...}
"""


@router.get(
    "/{job_id}/events",
    summary="진행 상황 실시간 수신 (SSE)",
    response_class=SSEResponse,
    responses={
        200: {
            "description": "Server-Sent Events 스트림",
            "content": {"text/event-stream": {"example": SSE_EXAMPLE}},
        },
        **NOT_FOUND,
    },
)
async def job_events(
    job_id: JobIdPath, request: Request, session: SessionDep, redis: RedisDep
) -> EventSourceResponse:
    """진행 단계를 Server-Sent Events로 보낸다. 브라우저에서는 `EventSource`로 받는다.

    | 이벤트 | 언제 | `data` |
    |---|---|---|
    | `progress` | 상태·반복 횟수·메시지가 바뀔 때마다 | `JobStatusOut` JSON |
    | `done` | `DONE` 또는 `FAILED`가 되면 한 번 보내고 연결 종료 | `JobStatusOut` JSON |
    | `timeout` | 10분이 지나도 끝나지 않으면 보내고 연결 종료 | `{"job_id": "..."}` |

    연결 직후 현재 상태를 한 번 보내므로, 이미 끝난 작업에 연결하면 바로 `done`을 받는다.
    15초마다 keep-alive 주석(`: ping`)이 온다. Swagger의 "Try it out"에서는 스트림이
    끝날 때까지 응답이 보이지 않을 수 있으니 curl로 확인한다.

    ```bash
    curl -N http://10.1.1.27/api/jobs/{job_id}/events
    ```
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


NOT_DONE = {409: _err("아직 끝나지 않았거나 실패한 작업", "job is ANALYZING")}


@router.get(
    "/{job_id}/result",
    response_model=JobResultOut,
    summary="결과물 조회",
    responses={
        404: _err("작업이 없거나 결과 이미지가 없음", "job not found"),
        **NOT_DONE,
    },
)
async def get_result(
    job_id: JobIdPath, session: SessionDep, storage: StorageDep, settings: SettingsDep
) -> JobResultOut:
    """보호 처리된 결과물. `DONE`인 작업만 조회할 수 있다.

    - 이미지는 S3 presigned URL로만 준다. 만료(기본 300초)가 짧으므로 URL을 저장하지 말고
      화면에 보여줄 때마다 이 API를 다시 호출한다.
    - `image_text` 작업은 `url`과 `text`를 함께 준다.
    """
    job = await _get_job(session, job_id, with_result=True)
    if job.status != JobStatus.DONE:
        raise HTTPException(status.HTTP_409_CONFLICT, f"job is {job.status}")
    input_type = job.input_type
    out = JobResultOut(type=input_type)
    if input_type in ("text", "image_text"):
        out.text = job.result.result_text if job.result else None
    if input_type in ("image", "image_text"):
        if not job.result_object_key:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "result image not found")
        out.url = storage.presign_get(job.result_object_key, settings.presign_expires_seconds)
        out.expires_in = settings.presign_expires_seconds
    return out


@router.get(
    "/{job_id}/report",
    response_model=JobReportOut,
    summary="처리 리포트 조회",
    responses={**NOT_FOUND, **NOT_DONE},
)
async def get_report(job_id: JobIdPath, session: SessionDep) -> JobReportOut:
    """무엇이 위험했고 어떻게 처리했는지 보여주는 리포트. `DONE`인 작업만 조회할 수 있다.

    `findings`의 `bbox`로 원본·결과 이미지 위에 탐지 위치를 표시할 수 있다.
    """
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
