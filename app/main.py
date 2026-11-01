import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import health, jobs, posts, regeneration
from app.core.config import get_settings
from app.core.logging import setup_logging
from app.db.session import create_engine, create_session_factory
from app.queue.consumer import run_results_consumer
from app.queue.redis_client import create_redis
from app.storage.s3 import Storage

settings = get_settings()
setup_logging(settings.log_level)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    engine = create_engine(settings.database_url)
    redis = create_redis(settings.redis_url)
    storage = Storage(settings)

    app.state.session_factory = create_session_factory(engine)
    app.state.redis = redis
    app.state.storage = storage

    consumer = asyncio.create_task(
        run_results_consumer(redis, app.state.session_factory, settings),
        name="results-consumer",
    )
    try:
        yield
    finally:
        consumer.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await consumer
        await redis.aclose()
        await engine.dispose()


DESCRIPTION = """
사진·글 속 개인정보를 AI가 찾아 가려 주는 서비스의 API입니다.

## 흐름 (웹 화면 기준: 게시물 API)
1. `POST /api/posts`로 사진(최대 4장)과 글을 올린다 → `post_id`를 바로 받는다.
   사진마다 작업이 하나씩 만들어지고, 글은 0번 사진과 함께 분석된다.
2. `GET /api/posts/{post_id}/events`(SSE)로 진행 단계를 받는다.
   `QUEUED` → `DETECTING`(① 탐지) → `ANALYZING`(② 위험 분석) → `AWAITING_USER`(사용자 선택 대기)
3. `GET /api/posts/{post_id}/report`로 단서를 보고, 처리 방법을 골라
   `POST /api/posts/{post_id}/transform`에 원본 사진과 함께 보낸다.
4. 다시 SSE로 `TRANSFORMING`(③ 변환) → `VERIFYING`(② 재검증) → `DONE` / `FAILED`를 받는다.
5. `GET /api/posts/{post_id}/result`로 결과 사진·글을, `/report`로 재검증에서 남은 단서를 받는다.

사진 1장 단위로 다루려면 같은 흐름의 `/api/jobs` API를 쓴다.

## 오류 형식
모든 오류는 `{"detail": "오류 내용"}` 형식입니다. 단, 경로의 `job_id`가 UUID 형식이 아니면
FastAPI 기본 검증 오류(422, `detail`이 배열)가 돌아옵니다.

## 주소
- 서버: `https://10.1.1.27` (VPN 연결 필요, mkcert 인증서. 접속 PC에 루트 CA 설치)
- 문서: `/docs`(Swagger), `/redoc`
"""

OPENAPI_TAGS = [
    {
        "name": "posts",
        "description": (
            "게시물(사진 최대 4장 + 글) 보호 편집. 웹 화면은 이 API를 쓴다. "
            "사진마다 작업(jobs)을 하나씩 만들어 묶는다."
        ),
    },
    {
        "name": "jobs",
        "description": "개인정보 보호 작업. 업로드 → 진행 상황 → 결과·리포트 순서로 호출한다.",
    },
    {"name": "health", "description": "서버 상태 확인 (배포·모니터링용)"},
]

app = FastAPI(
    title="Odyssey API",
    version="0.1.0",
    summary="AI 개인정보 보호 서비스 API",
    description=DESCRIPTION,
    openapi_tags=OPENAPI_TAGS,
    lifespan=lifespan,
)

if settings.cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )

app.include_router(health.router)
# Nginx 뒤에서도 확인할 수 있게 /api/health 로도 연다.
app.include_router(health.router, prefix="/api", include_in_schema=False)
app.include_router(posts.router)
app.include_router(regeneration.router)
app.include_router(jobs.router)
