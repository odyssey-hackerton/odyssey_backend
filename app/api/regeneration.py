"""편집 화면의 이미지재생성. Gemini 호출은 API 서버가 그대로 맡는다.

생성한 패치는 Redis `generation:{id}` 에 보관(TTL = progress_ttl_seconds)하고 ID 를 응답으로
알려 준다 (`bbox` 요청은 헤더 `X-Generation-Id`, `boxes` 요청은 본문 `generation_ids`).
사용자가 적용하면 변환 요청(`choices[].generation_id`)으로 전달되고, AI 워커(에이전트3)가
최종 렌더에서 같은 픽셀을 합성한다.
게시물·분석 작업과는 독립적이다.
"""

import asyncio
import base64
import secrets
from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, Response, UploadFile
from fastapi.responses import JSONResponse
from redis.asyncio import Redis
from redis.exceptions import RedisError

from app.api.deps import RedisDep, SettingsDep
from app.api.jobs import _read_image
from app.core.config import Settings
from app.schemas.contract import generation_key
from app.services.regeneration import (
    generate_patch,
    generate_patches,
    prepare_image,
    prepare_regions,
)

router = APIRouter(prefix="/api/images", tags=["images"])


@router.get("/regenerate", summary="배경 생성 사용 가능 여부")
async def generation_status(
    settings: SettingsDep,
) -> dict:
    """이미지 생성 키 설정 여부를 반환한다. 호출 횟수는 프론트에서만 관리한다."""
    return {
        "enabled": bool(settings.gemini_api_key and settings.gemini_api_key.get_secret_value()),
    }


async def _keep_patches(redis: Redis, settings: Settings, patches: list[bytes]) -> list[str]:
    """워커가 적용 시 합성할 수 있도록 패치만 보관한다. 입력 사진은 저장하지 않는다."""
    ids = [secrets.token_hex(16) for _ in patches]
    try:
        async with redis.pipeline(transaction=True) as pipe:
            for generation_id, patch in zip(ids, patches, strict=True):
                pipe.setex(
                    generation_key(generation_id),
                    settings.progress_ttl_seconds,
                    base64.b64encode(patch).decode(),
                )
            await pipe.execute()
    except RedisError:
        raise HTTPException(
            503, "생성 결과를 보관하지 못했어요. 이번 호출도 횟수에 포함돼요."
        ) from None
    return ids


@router.post(
    "/regenerate",
    summary="전처리 사진의 영역 배경 생성 (한 영역 또는 여러 영역 한 번에)",
    responses={
        200: {
            "description": (
                "bbox 요청은 영역 PNG(헤더 X-Generation-Id), "
                "boxes 요청은 영역 순서대로 PNG(base64) 목록과 generation_ids"
            ),
            "content": {
                "image/png": {},
                "application/json": {
                    "example": {"patches": ["iVBORw0KGgo..."], "generation_ids": ["3f2b…"]}
                },
            },
        },
        422: {"description": "bbox·boxes 누락·중복, 좌표 오류"},
        502: {"description": "AI 이미지 생성 실패"},
        503: {"description": "서버에 이미지 생성 키 없음 / 결과 보관 실패"},
    },
)
async def regenerate(
    settings: SettingsDep,
    redis: RedisDep,
    file: Annotated[UploadFile, File(description="보호 전처리를 마친 사진")],
    bbox: Annotated[
        str | None,
        Form(max_length=200, description="영역 하나 [x1,y1,x2,y2] (픽셀). 응답은 PNG"),
    ] = None,
    boxes: Annotated[
        str | None,
        Form(
            max_length=4000,
            description="여러 영역 [[x1,y1,x2,y2], ...] (최대 20개). 한 번의 AI 호출로 생성",
        ),
    ] = None,
) -> Response:
    """호출자가 보호 전처리를 마친 사진과 그 사진의 픽셀 좌표를 받아 생성한 배경을 반환한다.

    - `bbox`: 영역 하나. 응답은 그 영역 PNG, 헤더 `X-Generation-Id`.
    - `boxes`: 여러 영역. AI를 한 번만 호출하고
      `{"patches": [base64 PNG, ...], "generation_ids": [...]}`를 영역 순서대로 반환.
    - 둘 중 하나만 보낸다.

    게시물·분석 작업과 독립적이며 전처리 완료 여부를 서버에서 판별하지 않는다.
    자동 재시도하지 않으며 입력 이미지·호출 횟수는 서버에 저장하지 않는다. 결과 패치만
    Redis 에 보관해 적용 시 워커(에이전트3)가 `generation_id` 로 같은 픽셀을 합성한다.
    사진마다 최대 3번(처음 1번 + 다시 생성 2번) 제한은 프론트 UI에서 관리한다.
    """
    if (bbox is None) == (boxes is None):
        raise HTTPException(422, "bbox 또는 boxes 중 하나만 보내 주세요.")
    if not settings.gemini_api_key or not settings.gemini_api_key.get_secret_value():
        raise HTTPException(503, "서버에 AI 이미지 생성 키가 설정되지 않았어요.")
    data, _ = await _read_image(file, settings)
    headers = {"Cache-Control": "no-store"}
    if bbox is not None:
        prepared, box, size = await asyncio.to_thread(prepare_image, data, bbox)
        patch = await asyncio.to_thread(generate_patch, prepared, box, size, settings)
        [generation_id] = await _keep_patches(redis, settings, [patch])
        return Response(
            patch, media_type="image/png", headers={**headers, "X-Generation-Id": generation_id}
        )
    prepared, regions, size = await asyncio.to_thread(prepare_regions, data, boxes)
    patches = await asyncio.to_thread(generate_patches, prepared, regions, size, settings)
    ids = await _keep_patches(redis, settings, patches)
    return JSONResponse(
        {"patches": [base64.b64encode(p).decode() for p in patches], "generation_ids": ids},
        headers=headers,
    )
