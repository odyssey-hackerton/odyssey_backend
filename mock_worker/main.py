"""개발용 가짜 AI 워커.

실제 AI 워커(odyssey_ai) 없이도 업로드 → 진행 표시 → 결과 조회 흐름 전체를 개발·시연하기 위한 것.
계약 v1 그대로 jobs를 소비하고, 단계별 진행 상태를 갱신한 뒤, results로 결과를 보낸다.

환경변수
- MOCK_STEP_SECONDS: 단계별 대기 시간 (기본 1초)
- MOCK_FAIL_RATE: 실패 시나리오 비율 0~1 (기본 0)
"""

import asyncio
import io
import logging
import os
import random
import re
import socket
from datetime import UTC, datetime

from PIL import Image, ImageFilter
from redis.asyncio import Redis

from app.core.config import get_settings
from app.core.logging import setup_logging
from app.queue.consumer import ensure_group
from app.queue.progress import set_progress
from app.queue.redis_client import create_redis
from app.schemas.contract import JobMessage, JobStatus, ResultMessage
from app.storage.s3 import Storage, result_key

logger = logging.getLogger("mock_worker")

WORKER_GROUP = "workers"
STEP_SECONDS = float(os.getenv("MOCK_STEP_SECONDS", "1"))
FAIL_RATE = float(os.getenv("MOCK_FAIL_RATE", "0"))

PHONE_RE = re.compile(r"01[016789]-?\d{3,4}-?\d{4}")
EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")


def blur_image(data: bytes) -> bytes:
    img = Image.open(io.BytesIO(data)).convert("RGB")
    out = io.BytesIO()
    # 새로 저장하면 EXIF가 붙지 않는다.
    img.filter(ImageFilter.GaussianBlur(radius=12)).save(out, format="JPEG", quality=85)
    return out.getvalue()


def mask_text(text: str) -> tuple[str, list[dict]]:
    findings = [
        {"type": "phone_number", "source": "text", "score": 0.99, "action": "mask"}
        for _ in PHONE_RE.findall(text)
    ]
    findings += [
        {"type": "email", "source": "text", "score": 0.99, "action": "mask"}
        for _ in EMAIL_RE.findall(text)
    ]
    masked = EMAIL_RE.sub("[이메일]", PHONE_RE.sub("010-****-****", text))
    return masked, findings


async def process(redis: Redis, storage: Storage, msg: JobMessage) -> ResultMessage:
    job_id = str(msg.job_id)
    ttl = get_settings().progress_ttl_seconds
    for status in (JobStatus.DETECTING, JobStatus.ANALYZING, JobStatus.TRANSFORMING):
        await set_progress(redis, job_id, status, message="mock", ttl_seconds=ttl)
        await asyncio.sleep(STEP_SECONDS)
    await set_progress(redis, job_id, JobStatus.VERIFYING, iteration=1, ttl_seconds=ttl)
    await asyncio.sleep(STEP_SECONDS)

    if random.random() < FAIL_RATE:
        return ResultMessage(job_id=msg.job_id, status="FAILED", error="mock failure")

    if msg.input_type == "image":
        original = await storage.get(msg.object_key)
        key = result_key(job_id, "jpg")
        await storage.put(key, await asyncio.to_thread(blur_image, original), "image/jpeg")
        return ResultMessage(
            job_id=msg.job_id,
            status="DONE",
            risk_detected=True,
            risk_before=0.82,
            risk_after=0.12,
            iterations=1,
            result_object_key=key,
            findings=[
                {
                    "type": "address",
                    "source": "ocr",
                    "bbox": [40, 60, 320, 110],
                    "score": 0.91,
                    "action": "blur",
                },
                {"type": "gps", "source": "exif", "action": "remove"},
            ],
            details={"mock": True},
        )

    masked, findings = mask_text(msg.text or "")
    return ResultMessage(
        job_id=msg.job_id,
        status="DONE",
        risk_detected=bool(findings),
        risk_before=0.7 if findings else 0.05,
        risk_after=0.05,
        iterations=1 if findings else 0,
        result_text=masked,
        findings=findings,
        details={"mock": True},
    )


async def main() -> None:
    settings = get_settings()
    setup_logging(settings.log_level)
    redis = create_redis(settings.redis_url)
    storage = Storage(settings)
    consumer = f"mock-{socket.gethostname()}-{os.getpid()}"
    await ensure_group(redis, settings.jobs_stream, WORKER_GROUP)
    logger.info("mock worker started (%s)", consumer)

    while True:
        resp = await redis.xreadgroup(
            WORKER_GROUP, consumer, {settings.jobs_stream: ">"}, count=1, block=5000
        )
        for _, entries in resp or []:
            for msg_id, fields in entries:
                try:
                    msg = JobMessage.model_validate_json(fields["payload"])
                    result = await process(redis, storage, msg)
                except Exception as e:
                    logger.exception("mock job failed")
                    job_id = JobMessage.model_validate_json(fields["payload"]).job_id
                    result = ResultMessage(job_id=job_id, status="FAILED", error=str(e))
                await redis.xadd(
                    settings.results_stream,
                    {"payload": result.model_dump_json()},
                    maxlen=settings.stream_maxlen,
                    approximate=True,
                )
                await redis.xack(settings.jobs_stream, WORKER_GROUP, msg_id)
                logger.info(
                    "job %s -> %s at %s",
                    result.job_id,
                    result.status,
                    datetime.now(UTC).isoformat(),
                )


if __name__ == "__main__":
    asyncio.run(main())
