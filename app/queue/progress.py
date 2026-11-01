"""작업 진행 상태: Redis Hash `job:{job_id}` (계약 v1).

워커가 단계마다 갱신하고 API는 읽기만 한다. 단, 최종 상태(DONE/FAILED)는
API가 결과를 DB에 저장한 뒤에도 한 번 더 기록해 둔다.
"""

from datetime import UTC, datetime

from redis.asyncio import Redis


def text_cache_key(job_id: str) -> str:
    """원본 글 임시 보관 키. 변환(Phase 2) 때 다시 쓰고, 작업이 끝나면 지운다.

    DB에는 저장하지 않는다.
    """
    return f"text:{job_id}"


def progress_key(job_id: str) -> str:
    return f"job:{job_id}"


async def set_progress(
    redis: Redis,
    job_id: str,
    status: str,
    *,
    iteration: int = 0,
    message: str | None = None,
    ttl_seconds: int = 24 * 3600,
) -> None:
    key = progress_key(job_id)
    mapping = {
        "status": status,
        "iteration": str(iteration),
        "message": message or "",
        "updated_at": datetime.now(UTC).isoformat(),
    }
    async with redis.pipeline(transaction=True) as pipe:
        pipe.hset(key, mapping=mapping)
        pipe.expire(key, ttl_seconds)
        await pipe.execute()


async def get_progress(redis: Redis, job_id: str) -> dict[str, str]:
    return await redis.hgetall(progress_key(job_id))
