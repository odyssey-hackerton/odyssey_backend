import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import health, jobs
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

## 흐름
1. `POST /api/jobs`로 사진, 글, 또는 사진 + 글을 올린다 → `job_id`를 바로 받는다.
2. `GET /api/jobs/{job_id}/events`(SSE)로 진행 단계를 받는다.
   `QUEUED` → `DETECTING`(① 탐지) → `ANALYZING`(② 위험 분석) → `TRANSFORMING`(③ 변환)
   → `VERIFYING`(② 재검증, 최대 3회) → `DONE` / `FAILED`
3. `DONE`이 되면 `GET /api/jobs/{job_id}/result`로 결과물을,
   `GET /api/jobs/{job_id}/report`로 탐지·처리 내역을 받는다.

## 오류 형식
모든 오류는 `{"detail": "오류 내용"}` 형식입니다. 단, 경로의 `job_id`가 UUID 형식이 아니면
FastAPI 기본 검증 오류(422, `detail`이 배열)가 돌아옵니다.

## 주소
- 서버: `http://10.1.1.27` (VPN 연결 필요, HTTP만 사용)
- 문서: `/docs`(Swagger), `/redoc`
"""

OPENAPI_TAGS = [
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
app.include_router(jobs.router)
