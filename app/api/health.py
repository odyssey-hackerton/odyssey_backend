from typing import Annotated

from fastapi import APIRouter, Query, Response
from sqlalchemy import text

from app.api.deps import RedisDep, SessionDep, StorageDep
from app.schemas.jobs import HealthOut

router = APIRouter(tags=["health"])


@router.get(
    "/health",
    response_model=HealthOut,
    summary="서버 상태 확인",
    responses={
        503: {
            "model": HealthOut,
            "description": "하나 이상의 항목이 실패함",
            "content": {
                "application/json": {
                    "example": {"status": "degraded", "checks": {"db": True, "redis": False}}
                }
            },
        }
    },
)
async def health(
    response: Response,
    session: SessionDep,
    redis: RedisDep,
    storage: StorageDep,
    deep: Annotated[
        bool, Query(description="`true`면 S3 버킷 접근까지 확인한다 (조금 느림)")
    ] = False,
) -> HealthOut:
    """DB(PostgreSQL)와 Redis 연결을 확인한다. `?deep=true`면 S3 버킷 접근까지 확인한다.

    배포 직후 확인이나 모니터링에 쓴다. 하나라도 실패하면 HTTP 503을 돌려준다.
    Nginx를 거칠 때는 `/api/health`로도 같은 응답을 받는다.
    """
    checks: dict[str, bool] = {}
    try:
        await session.execute(text("SELECT 1"))
        checks["db"] = True
    except Exception:
        checks["db"] = False
    try:
        checks["redis"] = bool(await redis.ping())
    except Exception:
        checks["redis"] = False
    if deep:
        checks["s3"] = await storage.ping()

    ok = all(checks.values())
    if not ok:
        response.status_code = 503
    return HealthOut(status="ok" if ok else "degraded", checks=checks)
