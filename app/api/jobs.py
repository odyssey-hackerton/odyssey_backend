import asyncio
import hashlib
import json
import logging
import uuid
from datetime import UTC, datetime
from typing import Annotated

from botocore.exceptions import BotoCoreError, ClientError
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
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from sse_starlette.sse import EventSourceResponse

from app.api.deps import RedisDep, SessionDep, SettingsDep, StorageDep
from app.core.config import Settings
from app.db.models import Job
from app.queue.producer import enqueue_job
from app.queue.progress import get_progress, set_progress, text_cache_key
from app.schemas.contract import (
    FINAL_STATUSES,
    TERMINAL_STATUSES,
    Finding,
    InputType,
    JobMessage,
    JobOptions,
    JobStatus,
    UserChoice,
    generation_key,
)
from app.schemas.jobs import (
    ErrorOut,
    JobCreated,
    JobReportOut,
    JobResultOut,
    JobStatusOut,
    TransformRequest,
    UserChoiceIn,
)
from app.services.policy import check_choice
from app.services.uploads import ImageType, detect_image_type, image_size
from app.storage.s3 import original_key

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/jobs", tags=["jobs"])


SSE_POLL_SECONDS = 0.5
SSE_MAX_SECONDS = 600


async def _get_job(
    session: SessionDep, job_id: uuid.UUID, with_result: bool = False, *, for_update: bool = False
) -> Job:
    stmt = select(Job).where(Job.id == job_id)
    if with_result:
        stmt = stmt.options(selectinload(Job.result))
    if for_update:
        stmt = stmt.with_for_update(of=Job)
    job = (await session.execute(stmt)).scalar_one_or_none()
    if job is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "job not found")
    return job


async def _read_image(file: UploadFile, settings: Settings) -> tuple[bytes, ImageType]:
    try:
        data = await file.read(settings.max_upload_bytes + 1)
    finally:
        await file.close()
    if len(data) > settings.max_upload_bytes:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "파일이 너무 큽니다")
    image_type = detect_image_type(data[:16])
    if image_type is None:
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "jpg, png, webp 이미지만 지원합니다"
        )
    return data, image_type


async def _discard_upload(storage: StorageDep, key: str | None) -> None:
    if key:
        try:
            await storage.delete(key)
        except Exception:
            # shortcut: DB/큐까지 실패한 업로드의 정리는 S3 1일 수명 주기가 최후 방어선이다.
            logger.error("temporary upload cleanup failed", exc_info=False)


async def _register_job(
    session: SessionDep,
    redis: RedisDep,
    storage: StorageDep,
    settings: Settings,
    *,
    image: tuple[bytes, ImageType] | None,
    text: str | None,
    post_id: uuid.UUID | None = None,
    position: int | None = None,
) -> uuid.UUID:
    """검증이 끝난 입력으로 작업 1건을 만든다: S3 원본 저장 → DB 기록 → 큐 등록.

    중간에 실패하면 올린 원본을 지우고 작업을 FAILED로 남긴다.
    """
    job_id = uuid.uuid4()
    execution_id = uuid.uuid4()
    object_key: str | None = None
    input_sha256: str | None = None

    if image is not None:
        data, image_type = image
        input_sha256 = hashlib.sha256(data).hexdigest()
        object_key = original_key(f"{job_id}/{execution_id}", image_type.ext)
        try:
            await storage.put(object_key, data, image_type.content_type)
        except Exception:
            await _discard_upload(storage, object_key)
            raise HTTPException(503, "사진 저장에 실패했습니다") from None

    input_type = input_type_of(has_image=image is not None, has_text=text is not None)
    job = Job(
        id=job_id,
        input_type=input_type,
        status=JobStatus.QUEUED,
        object_key=object_key,
        input_sha256=input_sha256,
        execution_id=execution_id,
        post_id=post_id,
        position=position,
    )
    session.add(job)
    try:
        await session.commit()
    except Exception:
        await _discard_upload(storage, object_key)
        raise

    message = JobMessage(
        job_id=job_id,
        execution_id=execution_id,
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
        # 원본 글을 Redis에 임시 보관 (Phase 2 변환 시 재사용, DB에는 저장하지 않음)
        if text is not None:
            await redis.setex(text_cache_key(str(job_id)), settings.progress_ttl_seconds, text)
        await enqueue_job(redis, settings.jobs_stream, message, settings.stream_maxlen)
    except Exception:
        await _discard_upload(storage, object_key)
        logger.exception("enqueue failed for job %s", job_id)
        job.status = JobStatus.FAILED
        job.error = "enqueue failed"
        await session.commit()
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "작업 등록에 실패했습니다"
        ) from None
    return job_id


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
    curl -X POST https://10.1.1.27/api/jobs -F file=@photo.jpg -F "text=본문 내용"
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

    image = await _read_image(file, settings) if file is not None else None
    job_id = await _register_job(session, redis, storage, settings, image=image, text=text)
    return JobCreated(job_id=job_id, status=JobStatus.QUEUED)


def _status_out(job: Job, progress: dict[str, str]) -> JobStatusOut:
    # DB가 종료 상태(DONE/FAILED/AWAITING_USER)면 DB 기준, 아니면 Redis 진행 상태 기준
    if job.status in TERMINAL_STATUSES or not progress:
        current, iteration, message = job.status, 0, None
    else:
        current = progress.get("status", job.status)
        if current in FINAL_STATUSES:
            current = JobStatus.VERIFYING  # DB 저장 전이면 아직 끝나지 않은 것으로 본다
        elif current == JobStatus.AWAITING_USER:
            current = job.status  # 이전 분석의 늦은 Redis 갱신이 새 편집의 SSE를 닫지 않게 한다.
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
    curl -N https://10.1.1.27/api/jobs/{job_id}/events
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
                if out.status in FINAL_STATUSES:
                    yield {"event": "done", "data": out.model_dump_json()}
                    return
                elif out.status == JobStatus.AWAITING_USER:
                    yield {"event": "awaiting_user", "data": out.model_dump_json()}
                    return
                else:
                    yield {"event": "progress", "data": out.model_dump_json()}
            await asyncio.sleep(SSE_POLL_SECONDS)
        yield {"event": "timeout", "data": json.dumps({"job_id": str(job_id)})}

    return EventSourceResponse(stream(), ping=15)


async def _check_transform(
    redis: RedisDep,
    job: Job,
    choices: list[UserChoiceIn],
    image: tuple[bytes, ImageType] | None,
) -> str | None:
    """변환을 시작해도 되는지 확인하고, 함께 보낼 원본 글을 돌려준다. 아무것도 바꾸지 않는다."""
    if job.status != JobStatus.AWAITING_USER:
        raise HTTPException(status.HTTP_409_CONFLICT, f"job is {job.status}")
    if job.result is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "analysis result is missing")
    indices = [choice.idx for choice in choices]
    if len(set(indices)) != len(indices) or any(i >= len(job.result.findings) for i in indices):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid finding indices")
    # 에이전트3 정책보다 약한 편집(고위험 항목 축소·삭제·부분마스킹 등)은 큐에 넣지 않는다.
    size = await asyncio.to_thread(image_size, image[0]) if image is not None else None
    for choice in choices:
        check_choice(
            job.result.findings[choice.idx],
            choice.action,
            bbox=choice.bbox,
            mask_box=choice.mask_box,
            generation_id=choice.generation_id,
            image_size=size,
        )
        if choice.action == "regenerate" and not await redis.exists(
            generation_key(choice.generation_id or "")
        ):
            raise HTTPException(
                422, "생성한 이미지가 만료됐어요. 다시 생성하거나 다른 방식을 골라 주세요"
            )

    has_image = job.input_type in ("image", "image_text")
    if has_image and (image is None or not job.input_sha256):
        raise HTTPException(409, "분석한 원본 사진이 필요합니다. 사진을 다시 선택해 주세요")
    if not has_image and image is not None:
        raise HTTPException(422, "텍스트 작업에는 사진을 추가할 수 없습니다")

    # Redis에 임시 보관한 원본 텍스트 복원
    has_text = job.input_type in ("text", "image_text")
    text = await redis.get(text_cache_key(str(job.id))) if has_text else None
    if has_text and text is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "원본 글이 만료되었습니다. 다시 업로드해 주세요"
        )
    if image is not None and hashlib.sha256(image[0]).hexdigest() != job.input_sha256:
        raise HTTPException(409, "처음 분석한 사진과 다릅니다. 같은 원본 파일을 선택해 주세요")
    return text


async def _start_transform(
    session: SessionDep,
    redis: RedisDep,
    storage: StorageDep,
    settings: Settings,
    job: Job,
    choices: list[UserChoiceIn],
    image: tuple[bytes, ImageType] | None,
    text: str | None,
) -> None:
    """확인이 끝난 변환 요청을 큐에 넣는다. 실패하면 원본을 지우고 AWAITING_USER로 되돌린다."""
    job_id = job.id
    initial_findings = [Finding.model_validate(f) for f in job.result.findings]
    execution_id = uuid.uuid4()
    object_key = None
    if image is not None:
        data, image_type = image
        object_key = original_key(f"{job_id}/{execution_id}", image_type.ext)
        try:
            await storage.put(object_key, data, image_type.content_type)
        except Exception:
            await _discard_upload(storage, object_key)
            raise HTTPException(503, "사진 저장에 실패했습니다") from None

    user_choices = [UserChoice(**c.model_dump()) for c in choices]
    message = JobMessage(
        job_id=job_id,
        execution_id=execution_id,
        input_type=job.input_type,
        object_key=object_key,
        text=text,
        options=JobOptions(max_iterations=settings.max_iterations),
        created_at=datetime.now(UTC),
        user_choices=user_choices,
        initial_findings=initial_findings,
    )

    previous_execution = job.execution_id
    job.status = JobStatus.QUEUED
    job.execution_id = execution_id
    job.object_key = object_key
    try:
        await session.commit()
    except Exception:
        await _discard_upload(storage, object_key)
        raise

    try:
        await set_progress(
            redis, str(job_id), JobStatus.QUEUED, ttl_seconds=settings.progress_ttl_seconds
        )
        await enqueue_job(redis, settings.jobs_stream, message, settings.stream_maxlen)
    except Exception:
        await _discard_upload(storage, object_key)
        logger.exception("enqueue transform failed for job %s", job_id)
        job.status = JobStatus.AWAITING_USER
        job.execution_id = previous_execution
        job.object_key = None
        await session.commit()
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "작업 등록에 실패했습니다"
        ) from None


AWAITING = {409: _err("AWAITING_USER 상태가 아닌 작업", "job is not AWAITING_USER")}
NOT_DONE = {409: _err("아직 끝나지 않았거나 실패한 작업", "job is ANALYZING")}


@router.post(
    "/{job_id}/transform",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=JobCreated,
    summary="변환 시작 (사용자 선택 제출)",
    response_description="변환 큐에 등록됨. SSE로 다시 진행 상황을 받는다.",
    responses={
        **NOT_FOUND,
        **AWAITING,
        503: _err("큐 등록 실패", "작업 등록에 실패했습니다"),
    },
)
async def submit_transform(
    job_id: JobIdPath,
    session: SessionDep,
    redis: RedisDep,
    settings: SettingsDep,
    storage: StorageDep,
    choices: Annotated[str, Form(description='JSON 배열: [{"idx": 0, "action": "mask"}]')],
    file: Annotated[UploadFile | None, File(description="최초 분석과 동일한 원본 파일")] = None,
) -> JobCreated:
    """탐지·분석(`AWAITING_USER`) 결과를 확인한 뒤 항목별 처리 방법을 골라 변환을 시작한다.

    `multipart/form-data`로 최초 분석과 동일한 원본 파일 및 JSON 배열 `choices`를 보낸다.
    `/report`로 받은 `findings` 리스트의 인덱스(`idx`)와 처리 방법(`action`)을 사용한다.
    목록에 없는 항목은 AI가 추천한 action을 그대로 사용한다.

    ```bash
    curl -X POST https://10.1.1.27/api/jobs/{job_id}/transform \\
         -F file=@photo.jpg \\
         -F 'choices=[{"idx": 0, "action": "blur"}]'
    ```
    """
    try:
        body = TransformRequest.model_validate({"choices": json.loads(choices)})
    except (ValueError, ValidationError):
        raise HTTPException(422, "choices는 유효한 선택 목록이어야 합니다") from None
    job = await _get_job(session, job_id, with_result=True, for_update=True)
    image = await _read_image(file, settings) if file is not None else None
    text = await _check_transform(redis, job, body.choices, image)
    await _start_transform(session, redis, storage, settings, job, body.choices, image, text)
    return JobCreated(job_id=job_id, status=JobStatus.QUEUED)


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
    if job.status not in (JobStatus.DONE, JobStatus.AWAITING_USER) or job.result is None:
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


IMAGE_TYPES = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}


@router.get(
    "/{job_id}/image",
    summary="결과 사진 내려받기",
    response_class=Response,
    responses={
        200: {
            "description": "보호 처리된 사진 파일",
            "content": {"image/png": {}, "image/jpeg": {}, "image/webp": {}},
        },
        404: _err("작업이 없거나 결과 사진이 없음", "result image not found"),
        503: _err("결과 저장소에 연결할 수 없음", "결과 사진을 가져오지 못했습니다"),
        **NOT_DONE,
    },
)
async def get_result_image(job_id: JobIdPath, session: SessionDep, storage: StorageDep) -> Response:
    """`DONE`인 작업의 결과 사진을 이 서버를 거쳐 그대로 내려준다.

    presigned URL과 달리 같은 주소에서 받으므로 브라우저가 파일로 받아 공유·다운로드할 때
    S3 CORS 설정이 필요 없다. 브라우저에 캐시하지 않는다.
    """
    job = await _get_job(session, job_id)
    if job.status != JobStatus.DONE:
        raise HTTPException(status.HTTP_409_CONFLICT, f"job is {job.status}")
    if not job.result_object_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "result image not found")
    try:
        data = await storage.get(job.result_object_key)
    except ClientError as exc:
        if exc.response["Error"]["Code"] in ("NoSuchKey", "404"):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "result image not found") from None
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "결과 사진을 가져오지 못했습니다"
        ) from None
    except BotoCoreError:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "결과 사진을 가져오지 못했습니다"
        ) from None
    ext = job.result_object_key.rsplit(".", 1)[-1].lower()
    return Response(
        content=data,
        media_type=IMAGE_TYPES.get(ext, "application/octet-stream"),
        headers={"Cache-Control": "no-store"},
    )
