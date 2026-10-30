from fastapi import APIRouter, Response
from sqlalchemy import text

from app.api.deps import RedisDep, SessionDep, StorageDep

router = APIRouter(tags=["health"])


@router.get("/health")
async def health(
    response: Response,
    session: SessionDep,
    redis: RedisDep,
    storage: StorageDep,
    deep: bool = False,
) -> dict:
    """기본은 DB·Redis만 확인. `?deep=true`면 S3 버킷 접근까지 확인한다."""
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
    return {"status": "ok" if ok else "degraded", "checks": checks}
