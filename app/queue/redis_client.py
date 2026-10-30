from redis.asyncio import Redis

# XREADGROUP BLOCK(5초)보다 길어야 대기 중에 타임아웃이 나지 않는다.
SOCKET_TIMEOUT_SECONDS = 30


def create_redis(url: str) -> Redis:
    return Redis.from_url(
        url,
        decode_responses=True,
        socket_timeout=SOCKET_TIMEOUT_SECONDS,
        socket_connect_timeout=5,
        health_check_interval=30,
    )
