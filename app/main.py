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


app = FastAPI(title="Odyssey API", version="0.1.0", lifespan=lifespan)

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
