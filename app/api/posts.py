"""게시물 API: 사진 최대 4장 + 글을 한 번에 보호 편집한다.

AI 워커는 작업 하나에 사진 1장을 처리하므로, 게시물은 사진마다 작업을 하나씩 만들어 묶는다.
글은 0번 사진 작업에 함께 보내 사진과 같이 분석되게 한다. 워커와의 메시지 형식은 그대로다.
"""

import asyncio
import json
import uuid
from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, Path, Request, UploadFile, status
from pydantic import TypeAdapter, ValidationError
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from sse_starlette.sse import EventSourceResponse

from app.api import jobs as job_api
from app.api.deps import RedisDep, SessionDep, SettingsDep, StorageDep
from app.db.models import Job, Post
from app.queue.progress import get_progress
from app.schemas.contract import FINAL_STATUSES, JobStatus
from app.schemas.jobs import UserChoiceIn
from app.schemas.posts import (
    PostChoiceIn,
    PostCreated,
    PostItem,
    PostItemReport,
    PostItemStatus,
    PostReportOut,
    PostResultItem,
    PostResultOut,
    PostStatusOut,
)

router = APIRouter(prefix="/api/posts", tags=["posts"])

MAX_PHOTOS = 4
_err = job_api._err
NOT_FOUND = {404: _err("해당 게시물이 없음", "post not found")}
PostIdPath = Annotated[uuid.UUID, Path(description="게시물 등록 때 받은 `post_id`")]

# 진행 순서. 전체 상태는 가장 늦은 항목 기준이다.
ORDER = [
    JobStatus.QUEUED,
    JobStatus.DETECTING,
    JobStatus.ANALYZING,
    JobStatus.TRANSFORMING,
    JobStatus.VERIFYING,
]


def aggregate_status(statuses: list[str]) -> str:
    """항목 상태들을 게시물 전체 상태 하나로 줄인다."""
    if not statuses:
        return JobStatus.FAILED
    if JobStatus.FAILED in statuses:
        return JobStatus.FAILED
    if all(s == JobStatus.DONE for s in statuses):
        return JobStatus.DONE
    if all(s == JobStatus.AWAITING_USER for s in statuses):
        return JobStatus.AWAITING_USER
    moving = [s for s in statuses if s in ORDER]
    if moving:
        return min(moving, key=ORDER.index)
    # AWAITING_USER 와 DONE 이 섞인 경우 (정상 흐름에서는 생기지 않는다)
    return JobStatus.AWAITING_USER


async def _get_post(session: SessionDep, post_id: uuid.UUID, *, with_result: bool = False) -> Post:
    load = selectinload(Post.jobs)
    if with_result:
        load = load.selectinload(Job.result)
    post = (
        await session.execute(select(Post).where(Post.id == post_id).options(load))
    ).scalar_one_or_none()
    if post is None or not post.jobs:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "post not found")
    return post


def _item(job: Job) -> dict:
    return {"position": job.position or 0, "job_id": job.id, "input_type": job.input_type}


async def _status(post_id: uuid.UUID, jobs: list[Job], redis: RedisDep) -> PostStatusOut:
    items = []
    for job in jobs:
        out = job_api._status_out(job, await get_progress(redis, str(job.id)))
        items.append(
            PostItemStatus(
                **_item(job),
                status=out.status,
                iteration=out.iteration,
                message=out.message,
                error=out.error,
            )
        )
    return PostStatusOut(
        post_id=post_id, status=aggregate_status([i.status for i in items]), items=items
    )


@router.post(
    "",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=PostCreated,
    summary="게시물 등록 (사진 최대 4장 + 글)",
    response_description="등록됨. 사진마다 분석이 백그라운드에서 진행된다.",
    responses={
        413: _err("사진이 10MB를 넘거나 글이 5,000자를 넘음", "파일이 너무 큽니다"),
        415: _err("jpg·png·webp가 아닌 파일", "jpg, png, webp 이미지만 지원합니다"),
        422: _err(
            "사진과 글이 모두 없거나 사진이 4장을 넘음", "사진은 최대 4장까지 올릴 수 있습니다"
        ),
        503: _err("저장소나 큐 등록 실패. 잠시 후 다시 시도", "작업 등록에 실패했습니다"),
    },
)
async def create_post(
    session: SessionDep,
    redis: RedisDep,
    storage: StorageDep,
    settings: SettingsDep,
    files: Annotated[
        list[UploadFile] | None,
        File(description="사진 0~4장 (jpg, png, webp, 한 장 10MB). 올린 순서가 `position`이 된다."),
    ] = None,
    text: Annotated[
        str | None,
        Form(
            description="함께 올릴 글 (최대 5,000자). 0번 사진과 함께 분석한다.",
            examples=["좋은 날, 카페에서 ☕ 예약 문의는 010-1234-5678"],
        ),
    ] = None,
) -> PostCreated:
    """사진과 글을 `multipart/form-data`로 받아 게시물을 만들고 바로 `post_id`를 돌려준다.

    - 사진마다 작업을 하나씩 만든다. 글은 0번 사진 작업에 붙어 사진과 함께 분석된다.
    - 사진 없이 글만 보내면 글 작업 하나가 만들어진다.
    - 모든 사진을 먼저 검사하므로, 한 장이라도 형식·크기가 맞지 않으면 아무 작업도 만들지 않는다.

    다음 순서로 호출한다: `GET /api/posts/{post_id}/events`(SSE)로 `awaiting_user`를 기다림 →
    `/report`로 단서 확인 → `POST /transform` → 다시 SSE로 `done` → `/result`와 `/report`.

    ```bash
    curl -X POST https://10.1.1.27/api/posts \\
         -F files=@photo1.jpg -F files=@photo2.jpg -F "text=본문 내용"
    ```
    """
    files = files or []
    if text is not None and not text.strip():
        text = None
    if not files and text is None:
        raise HTTPException(422, "사진이나 글 중 하나 이상 보내세요")
    if len(files) > MAX_PHOTOS:
        raise HTTPException(422, f"사진은 최대 {MAX_PHOTOS}장까지 올릴 수 있습니다")
    if text is not None and len(text) > settings.max_text_chars:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "텍스트가 너무 깁니다")

    images = [await job_api._read_image(f, settings) for f in files]

    post = Post(id=uuid.uuid4())
    session.add(post)
    await session.commit()

    items: list[PostItem] = []
    plan = [(i, img) for i, img in enumerate(images)] or [(0, None)]
    for position, image in plan:
        job_id = await job_api._register_job(
            session,
            redis,
            storage,
            settings,
            image=image,
            text=text if position == 0 else None,
            post_id=post.id,
            position=position,
        )
        items.append(
            PostItem(
                position=position,
                job_id=job_id,
                input_type=job_api.input_type_of(
                    has_image=image is not None, has_text=position == 0 and text is not None
                ),
            )
        )
    return PostCreated(post_id=post.id, status=JobStatus.QUEUED, items=items)


@router.get(
    "/{post_id}",
    response_model=PostStatusOut,
    summary="게시물 진행 상황 조회",
    responses=NOT_FOUND,
)
async def get_post(post_id: PostIdPath, session: SessionDep, redis: RedisDep) -> PostStatusOut:
    """게시물 전체와 항목별 진행 상황을 한 번 조회한다.

    SSE를 쓸 수 없을 때 1~2초 간격으로 부른다.
    """
    post = await _get_post(session, post_id)
    return await _status(post.id, post.jobs, redis)


SSE_EXAMPLE = """event: progress
data: {"post_id": "9a1c…", "status": "DETECTING", "items": [...]}

event: awaiting_user
data: {"post_id": "9a1c…", "status": "AWAITING_USER", "items": [...]}
"""


@router.get(
    "/{post_id}/events",
    summary="게시물 진행 상황 실시간 수신 (SSE)",
    response_class=job_api.SSEResponse,
    responses={
        200: {
            "description": "Server-Sent Events 스트림",
            "content": {"text/event-stream": {"example": SSE_EXAMPLE}},
        },
        **NOT_FOUND,
    },
)
async def post_events(
    post_id: PostIdPath, request: Request, session: SessionDep, redis: RedisDep
) -> EventSourceResponse:
    """게시물 전체 진행 상황을 Server-Sent Events로 보낸다. `data`는 `PostStatusOut` JSON이다.

    | 이벤트 | 언제 |
    |---|---|
    | `progress` | 전체 상태나 항목 상태가 바뀔 때마다 |
    | `awaiting_user` | 모든 항목의 분석이 끝나 사용자 선택을 기다릴 때 (연결 종료) |
    | `done` | 모두 `DONE`이거나 하나라도 `FAILED`일 때 (연결 종료) |
    | `timeout` | 10분이 지나도 끝나지 않을 때 (연결 종료) |
    """
    await _get_post(session, post_id)
    session_factory = request.app.state.session_factory

    async def stream():
        last = None
        loop = asyncio.get_running_loop()
        deadline = loop.time() + job_api.SSE_MAX_SECONDS
        while loop.time() < deadline:
            if await request.is_disconnected():
                return
            async with session_factory() as s:
                jobs = (
                    (
                        await s.execute(
                            select(Job).where(Job.post_id == post_id).order_by(Job.position)
                        )
                    )
                    .scalars()
                    .all()
                )
            out = await _status(post_id, list(jobs), redis)
            snapshot = out.model_dump_json()
            if snapshot != last:
                last = snapshot
                if out.status in FINAL_STATUSES:
                    yield {"event": "done", "data": snapshot}
                    return
                if out.status == JobStatus.AWAITING_USER:
                    yield {"event": "awaiting_user", "data": snapshot}
                    return
                yield {"event": "progress", "data": snapshot}
            await asyncio.sleep(job_api.SSE_POLL_SECONDS)
        yield {"event": "timeout", "data": json.dumps({"post_id": str(post_id)})}

    return EventSourceResponse(stream(), ping=15)


NOT_READY = {409: _err("아직 분석이 끝나지 않았거나 실패한 게시물", "post is ANALYZING")}


def _max(values: list[float | None]) -> float | None:
    present = [v for v in values if v is not None]
    return max(present) if present else None


@router.get(
    "/{post_id}/report",
    response_model=PostReportOut,
    summary="게시물 리포트 조회",
    responses={**NOT_FOUND, **NOT_READY},
)
async def get_post_report(post_id: PostIdPath, session: SessionDep) -> PostReportOut:
    """모든 항목이 `AWAITING_USER`(분석 끝) 또는 `DONE`(편집·재검증 끝)일 때 단서를 돌려준다.

    분석 단계에서는 `findings`로 화면에 단서를 표시하고, 변환 요청의 `idx`로 쓴다.
    """
    post = await _get_post(session, post_id, with_result=True)
    ready = (JobStatus.AWAITING_USER, JobStatus.DONE)
    if any(j.status not in ready or j.result is None for j in post.jobs):
        current = aggregate_status([j.status for j in post.jobs])
        raise HTTPException(status.HTTP_409_CONFLICT, f"post is {current}")
    items = [
        PostItemReport(
            **_item(j),
            status=j.status,
            risk_detected=j.result.risk_detected,
            risk_before=j.result.risk_before,
            risk_after=j.result.risk_after,
            iterations=j.result.iterations,
            findings=j.result.findings,
            details=j.result.details,
        )
        for j in post.jobs
    ]
    return PostReportOut(
        post_id=post.id,
        status=aggregate_status([j.status for j in post.jobs]),
        risk_before=_max([i.risk_before for i in items]),
        risk_after=_max([i.risk_after for i in items]),
        items=items,
    )


@router.post(
    "/{post_id}/transform",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=PostCreated,
    summary="보호 적용 (사용자 선택 제출)",
    response_description="변환 큐에 등록됨. SSE로 다시 진행 상황을 받는다.",
    responses={
        **NOT_FOUND,
        409: _err(
            "분석이 끝나지 않았거나, 원본 사진이 다르거나, 원본 글이 만료됨",
            "처음 분석한 사진과 다릅니다. 같은 원본 파일을 선택해 주세요",
        ),
        422: _err(
            "선택 형식이 잘못됐거나 사진 수가 맞지 않음", "사진 2장을 순서대로 다시 보내 주세요"
        ),
        503: _err("저장소나 큐 등록 실패", "작업 등록에 실패했습니다"),
    },
)
async def transform_post(
    post_id: PostIdPath,
    session: SessionDep,
    redis: RedisDep,
    storage: StorageDep,
    settings: SettingsDep,
    choices: Annotated[
        str,
        Form(
            description=(
                'JSON 배열: `[{"position": 0, "idx": 0, "action": "blur"}]`. '
                "보내지 않은 단서는 AI가 추천한 처리를 쓴다. "
                "글을 고치지 않으려면 글 단서를 `skip`으로 보낸다."
            )
        ),
    ],
    files: Annotated[
        list[UploadFile] | None,
        File(description="처음 분석한 원본 사진들. 등록할 때와 같은 순서로 다시 보낸다."),
    ] = None,
) -> PostCreated:
    """분석 결과를 보고 고른 처리 방법으로 ③ 변환과 ② 재검증을 시작한다.

    서버는 분석 직후 원본을 지우므로, 화면이 가진 원본 사진을 등록할 때와 같은 순서로 다시 보낸다.
    서버는 처음 파일과 같은지(SHA-256) 확인한다. 모든 항목을 먼저 확인한 뒤에 변환을 시작하므로,
    하나라도 맞지 않으면 아무 항목도 시작하지 않는다.

    ```bash
    curl -X POST https://10.1.1.27/api/posts/{post_id}/transform \\
         -F files=@photo1.jpg -F files=@photo2.jpg \\
         -F 'choices=[{"position": 0, "idx": 0, "action": "blur"}]'
    ```
    """
    try:
        parsed = TypeAdapter(list[PostChoiceIn]).validate_python(json.loads(choices))
    except (ValueError, ValidationError):
        raise HTTPException(422, "choices는 유효한 선택 목록이어야 합니다") from None

    post = await _get_post(session, post_id)
    jobs = list(
        (
            await session.execute(
                select(Job)
                .where(Job.post_id == post_id)
                .order_by(Job.position)
                .options(selectinload(Job.result))
                .with_for_update(of=Job)
                .execution_options(populate_existing=True)
            )
        )
        .scalars()
        .all()
    )
    image_jobs = [j for j in jobs if j.input_type in ("image", "image_text")]
    files = files or []
    if len(files) != len(image_jobs):
        raise HTTPException(422, f"사진 {len(image_jobs)}장을 순서대로 다시 보내 주세요")
    if any(c.position not in {j.position for j in jobs} for c in parsed):
        raise HTTPException(422, "없는 항목(position)이 있습니다")

    images = {
        j.position: await job_api._read_image(f, settings)
        for j, f in zip(image_jobs, files, strict=True)
    }

    # 1) 모두 확인 → 2) 모두 시작. 확인 단계에서는 아무것도 바꾸지 않는다.
    plan = []
    for job in jobs:
        mine = [
            UserChoiceIn(idx=c.idx, action=c.action) for c in parsed if c.position == job.position
        ]
        image = images.get(job.position)
        text = await job_api._check_transform(redis, job, mine, image)
        plan.append((job, mine, image, text))
    for job, mine, image, text in plan:
        await job_api._start_transform(session, redis, storage, settings, job, mine, image, text)

    return PostCreated(
        post_id=post.id, status=JobStatus.QUEUED, items=[PostItem(**_item(j)) for j in jobs]
    )


@router.get(
    "/{post_id}/result",
    response_model=PostResultOut,
    summary="보호된 게시물 조회",
    responses={
        404: _err("게시물이 없거나 처리 결과가 누락됨", "post result not found"),
        409: _err("아직 끝나지 않은 게시물", "post is VERIFYING"),
    },
)
async def get_post_result(post_id: PostIdPath, session: SessionDep) -> PostResultOut:
    """모든 항목이 `DONE`이면 결과 사진 주소와 처리된 글을 돌려준다.

    사진은 같은 서버 주소(`/api/jobs/{job_id}/image`)로 주므로 브라우저에서 바로 내려받아
    공유·다운로드할 수 있다 (S3 CORS 설정이 필요 없다).
    """
    post = await _get_post(session, post_id, with_result=True)
    current = aggregate_status([j.status for j in post.jobs])
    if current != JobStatus.DONE:
        raise HTTPException(status.HTTP_409_CONFLICT, f"post is {current}")
    if any(
        j.result is None or (j.input_type in ("image", "image_text") and not j.result_object_key)
        for j in post.jobs
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "post result not found")
    text_job = next((j for j in post.jobs if j.input_type in ("text", "image_text")), None)
    return PostResultOut(
        post_id=post.id,
        text=text_job.result.result_text if text_job and text_job.result else None,
        items=[
            PostResultItem(
                **_item(j),
                image_url=f"/api/jobs/{j.id}/image" if j.result_object_key else None,
            )
            for j in post.jobs
        ],
    )
