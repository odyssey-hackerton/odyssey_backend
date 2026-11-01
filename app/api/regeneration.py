"""Only image generation crosses the server; other edits remain in the browser."""

import asyncio
import base64
from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, Response, UploadFile
from fastapi.responses import JSONResponse

from app.api.deps import SettingsDep
from app.api.jobs import _read_image
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


@router.post(
    "/regenerate",
    summary="전처리 사진의 영역 배경 생성 (한 영역 또는 여러 영역 한 번에)",
    responses={
        200: {
            "description": "bbox 요청은 영역 PNG, boxes 요청은 영역 순서대로 PNG(base64) 목록",
            "content": {
                "image/png": {},
                "application/json": {"example": {"patches": ["iVBORw0KGgo..."]}},
            },
        },
        422: {"description": "bbox·boxes 누락·중복, 좌표 오류"},
        502: {"description": "AI 이미지 생성 실패"},
        503: {"description": "서버에 이미지 생성 키 없음"},
    },
)
async def regenerate(
    settings: SettingsDep,
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

    - `bbox`: 영역 하나. 응답은 그 영역 PNG.
    - `boxes`: 여러 영역. AI를 한 번만 호출하고
      `{"patches": [base64 PNG, ...]}`를 영역 순서대로 반환.
    - 둘 중 하나만 보낸다.

    게시물·분석 작업과 독립적이며 전처리 완료 여부를 서버에서 판별하지 않는다.
    자동 재시도하지 않으며 이미지·결과·호출 횟수를 서버에 저장하지 않는다.
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
        return Response(patch, media_type="image/png", headers=headers)
    prepared, regions, size = await asyncio.to_thread(prepare_regions, data, boxes)
    patches = await asyncio.to_thread(generate_patches, prepared, regions, size, settings)
    return JSONResponse(
        {"patches": [base64.b64encode(p).decode() for p in patches]}, headers=headers
    )
