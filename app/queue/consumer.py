"""results stream 소비자. FastAPI 프로세스 안에서 백그라운드 태스크로 돈다.

- consumer group을 써서 API를 여러 개 띄워도 결과를 한 번씩만 처리한다.
- 같은 job_id 결과가 두 번 와도 upsert라 안전하다.
- 다른 API 프로세스가 죽어 남긴 미처리 메시지는 XAUTOCLAIM으로 가져온다.
"""

import asyncio
import logging
import os
import socket
from datetime import UTC, datetime

from pydantic import ValidationError
from redis.asyncio import Redis
from redis.exceptions import ResponseError
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.core.config import Settings
from app.db.models import Job, JobResult
from app.queue.progress import set_progress
from app.schemas.contract import ResultMessage

logger = logging.getLogger(__name__)

CLAIM_IDLE_MS = 60_000


async def ensure_group(redis: Redis, stream: str, group: str) -> None:
    try:
        await redis.xgroup_create(stream, group, id="0", mkstream=True)
    except ResponseError as e:
        if "BUSYGROUP" not in str(e):
            raise


async def save_result(
    session_factory: async_sessionmaker, redis: Redis, settings: Settings, msg: ResultMessage
) -> None:
    job_id = msg.job_id
    values = {
        "job_id": job_id,
        "schema_version": msg.schema_version,
        "risk_detected": msg.risk_detected,
        "risk_before": msg.risk_before,
        "risk_after": msg.risk_after,
        "iterations": msg.iterations,
        "result_text": msg.result_text,
        "findings": [f.model_dump(mode="json", exclude_none=True) for f in msg.findings],
        "details": msg.details,
    }
    async with session_factory() as session:
        job = await session.get(Job, job_id)
        if job is None:
            logger.warning("result for unknown job %s ignored", job_id)
            return
        stmt = insert(JobResult).values(**values)
        stmt = stmt.on_conflict_do_update(
            index_elements=[JobResult.job_id],
            set_={k: stmt.excluded[k] for k in values if k != "job_id"},
        )
        await session.execute(stmt)
        job.status = msg.status
        job.result_object_key = msg.result_object_key
        job.error = msg.error
        # AWAITING_USER는 아직 처리 중이므로 finished_at을 기록하지 않는다
        if msg.status != "AWAITING_USER":
            job.finished_at = datetime.now(UTC)
        await session.commit()

    # DB 저장이 끝난 뒤 최종 상태를 기록해야 SSE가 끝났을 때 결과 조회가 가능하다.
    await set_progress(
        redis,
        str(job_id),
        msg.status,
        iteration=msg.iterations,
        ttl_seconds=settings.progress_ttl_seconds,
    )
    logger.info("job %s saved as %s", job_id, msg.status)


async def _handle(
    redis: Redis,
    session_factory: async_sessionmaker,
    settings: Settings,
    msg_id: str,
    fields: dict[str, str],
    consumer: str,
) -> None:
    stream, group = settings.results_stream, settings.results_group
    try:
        msg = ResultMessage.model_validate_json(fields.get("payload", ""))
    except ValidationError:
        # 형식이 깨진 메시지는 재시도해도 소용없으므로 기록만 하고 넘긴다.
        logger.exception("invalid result message %s dropped", msg_id)
        await redis.xack(stream, group, msg_id)
        return
    try:
        await save_result(session_factory, redis, settings, msg)
    except Exception:
        # ack하지 않으면 pending에 남아 다음 XAUTOCLAIM 때 다시 처리된다.
        logger.exception("failed to save result %s (consumer %s), will retry", msg_id, consumer)
        return
    await redis.xack(stream, group, msg_id)


async def run_results_consumer(
    redis: Redis, session_factory: async_sessionmaker, settings: Settings
) -> None:
    stream, group = settings.results_stream, settings.results_group
    consumer = f"api-{socket.gethostname()}-{os.getpid()}"
    await ensure_group(redis, stream, group)
    logger.info("results consumer started (%s)", consumer)

    # 1) 이 consumer 이름으로 남아 있던 미처리 메시지부터 처리
    pending = await redis.xreadgroup(group, consumer, {stream: "0"}, count=100)
    for _, entries in pending or []:
        for msg_id, fields in entries:
            await _handle(redis, session_factory, settings, msg_id, fields, consumer)

    # 2) 새 메시지 대기
    while True:
        try:
            resp = await redis.xreadgroup(group, consumer, {stream: ">"}, count=10, block=5000)
            if resp:
                for _, entries in resp:
                    for msg_id, fields in entries:
                        await _handle(redis, session_factory, settings, msg_id, fields, consumer)
                continue

            # 한가할 때: 오래 처리되지 않은 다른 consumer의 메시지를 가져온다.
            claimed = await redis.xautoclaim(
                stream, group, consumer, min_idle_time=CLAIM_IDLE_MS, start_id="0-0", count=10
            )
            for msg_id, fields in claimed[1]:
                if fields:
                    await _handle(redis, session_factory, settings, msg_id, fields, consumer)
        except asyncio.CancelledError:
            logger.info("results consumer stopped")
            raise
        except Exception:
            logger.exception("results consumer error, retrying in 2s")
            await asyncio.sleep(2)
