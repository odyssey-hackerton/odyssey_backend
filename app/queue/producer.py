from redis.asyncio import Redis

from app.schemas.contract import JobMessage


async def enqueue_job(redis: Redis, stream: str, message: JobMessage, maxlen: int) -> str:
    """jobs stream에 작업을 넣는다.

    오래된 메시지는 maxlen 기준으로 잘려 원문 텍스트가 계속 남지 않는다.
    """
    return await redis.xadd(
        stream,
        {"payload": message.model_dump_json()},
        maxlen=maxlen,
        approximate=True,
    )
