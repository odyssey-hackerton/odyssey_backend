"""Only image generation crosses the server; other edits remain in the browser."""

import asyncio
from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, Response, UploadFile

from app.api.deps import SettingsDep
from app.api.jobs import _read_image
from app.services.regeneration import generate_patch, prepare_image

router = APIRouter(prefix="/api/images", tags=["images"])


@router.get("/regenerate", summary="배경 생성 사용 가능 여부")
async def generation_status(
    settings: SettingsDep,
) -> dict:
    """이미지 생성 키 설정 여부를 반환한다. 호출 횟수는 프론트에서만 관리한다."""
    return {
        "enabled": bool(settings.gemini_api_key and settings.gemini_api_key.get_secret_value()),
    }


@router.post("/regenerate", summary="전처리 사진의 선택 영역 배경 생성")
async def regenerate(
    settings: SettingsDep,
    file: Annotated[UploadFile, File()],
    bbox: Annotated[str, Form(max_length=200)],
) -> Response:
    """호출자가 보호 전처리를 마친 사진과 그 사진의 픽셀 좌표를 받아 영역 PNG를 반환한다.

    게시물·분석 작업과 독립적이며 전처리 완료 여부를 서버에서 판별하지 않는다.
    자동 재시도하지 않으며 이미지·결과·호출 횟수를 서버에 저장하지 않는다.
    최초 생성 1회와 재생성 2회 제한은 프론트 UI에서 관리한다.
    """
    if not settings.gemini_api_key or not settings.gemini_api_key.get_secret_value():
        raise HTTPException(503, "서버에 Gemini 이미지 생성 키가 설정되지 않았어요.")
    data, _ = await _read_image(file, settings)
    prepared, box, size = await asyncio.to_thread(prepare_image, data, bbox)
    patch = await asyncio.to_thread(generate_patch, prepared, box, size, settings)
    return Response(patch, media_type="image/png", headers={"Cache-Control": "no-store"})
