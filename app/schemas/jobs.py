"""HTTP API 요청·응답 스키마. 필드 설명과 예시는 Swagger(/docs)에 그대로 표시된다."""

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field

from app.schemas.contract import InputType

JOB_ID_EXAMPLE = "3f2b9c1e-8a4d-4c7b-9e21-5d6f0a1b2c3d"

STATUS_DESCRIPTION = (
    "작업 상태. `QUEUED`(대기) → `DETECTING`(① 탐지) → `ANALYZING`(② 위험 분석) → "
    "`AWAITING_USER`(사용자 선택 대기) → `TRANSFORMING`(③ 변환) → "
    "`VERIFYING`(② 재검증, 최대 3회 반복) → `DONE`(완료) 또는 `FAILED`(실패)"
)


class ErrorOut(BaseModel):
    """오류 응답. 모든 4xx·5xx 오류는 이 형식이다."""

    detail: str = Field(description="오류 내용 (사용자에게 그대로 보여줘도 되는 문장)")


class JobCreated(BaseModel):
    """작업 등록 결과. 처리는 백그라운드에서 진행되므로 바로 돌아온다."""

    job_id: UUID = Field(
        description="작업 ID. 이후 진행 상황·결과·리포트 조회에 사용한다.",
        examples=[JOB_ID_EXAMPLE],
    )
    status: str = Field(description="등록 직후 상태. 항상 `QUEUED`", examples=["QUEUED"])


class JobStatusOut(BaseModel):
    """작업 진행 상황."""

    job_id: UUID = Field(description="작업 ID", examples=[JOB_ID_EXAMPLE])
    input_type: InputType = Field(
        description="입력 종류. `image`(사진만), `text`(글만), `image_text`(사진 + 글)",
        examples=["image_text"],
    )
    status: str = Field(description=STATUS_DESCRIPTION, examples=["ANALYZING"])
    iteration: int = Field(
        default=0,
        description="재검증 반복 횟수 (`VERIFYING`·`DONE` 단계에서 1 이상)",
        examples=[1],
    )
    message: str | None = Field(
        default=None,
        description="워커가 남긴 진행 메시지. 없으면 null",
        examples=["주소 텍스트 탐지 중"],
    )
    created_at: datetime = Field(
        description="작업 등록 시각 (UTC)", examples=["2026-10-31T05:12:30.123456Z"]
    )
    finished_at: datetime | None = Field(
        default=None,
        description="작업 종료 시각 (UTC). 끝나지 않았으면 null",
        examples=[None],
    )
    error: str | None = Field(
        default=None,
        description="실패 이유. `FAILED`일 때만 값이 있다.",
        examples=[None],
    )


class JobResultOut(BaseModel):
    """보호 처리된 결과물. 입력 종류에 따라 채워지는 필드가 다르다.

    - `image`: `url`, `expires_in`
    - `text`: `text`
    - `image_text`: `url`, `expires_in`, `text` 모두
    """

    type: InputType = Field(description="결과 종류 (입력 종류와 같다)", examples=["image_text"])
    url: str | None = Field(
        default=None,
        description=(
            "처리된 이미지의 S3 presigned URL. 만료 전까지만 받을 수 있으므로 "
            "저장하지 말고 필요할 때마다 이 API를 다시 호출한다."
        ),
        examples=[
            "https://odyssey-hackarton-images.s3.ap-northeast-2.amazonaws.com/results/3f2b….jpg?X-Amz-…"
        ],
    )
    expires_in: int | None = Field(
        default=None, description="`url` 만료까지 남은 시간(초)", examples=[300]
    )
    text: str | None = Field(
        default=None,
        description="개인정보를 가린 글",
        examples=["오늘 [주소]에서 만나요. 연락은 010-****-****"],
    )


class JobReportOut(BaseModel):
    """처리 리포트. 어떤 개인정보가 어디서 발견되어 어떻게 처리됐는지 보여준다."""

    job_id: UUID = Field(description="작업 ID", examples=[JOB_ID_EXAMPLE])
    risk_detected: bool | None = Field(
        description="개인정보 위험이 발견됐는지 여부", examples=[True]
    )
    risk_before: float | None = Field(
        description="처리 전 위험도 (0~1, 높을수록 위험)", examples=[0.82]
    )
    risk_after: float | None = Field(
        description="처리 후 위험도 (0~1, 높을수록 위험)", examples=[0.12]
    )
    iterations: int = Field(description="② 재검증 반복 횟수 (최대 3)", examples=[1])
    findings: list[dict[str, Any]] = Field(
        description=(
            "탐지 항목 목록. 공통 필드: `type`(종류, 예: address·phone_number·face·gps), "
            "`source`(어디서 찾았는지, 예: ocr·exif·vlm·text), `bbox`(이미지 좌표 "
            "[x1, y1, x2, y2], 이미지 항목만), `score`(신뢰도 0~1), `action`(처리 방법, "
            "예: blur·mask·remove). AI 모델에 따라 다른 필드가 더 붙을 수 있다."
        ),
        examples=[
            [
                {
                    "type": "address",
                    "source": "ocr",
                    "bbox": [40, 60, 320, 110],
                    "score": 0.91,
                    "action": "blur",
                },
                {"type": "gps", "source": "exif", "action": "remove"},
                {"type": "phone_number", "source": "text", "score": 0.99, "action": "mask"},
            ]
        ],
    )
    details: dict[str, Any] = Field(
        description="AI 워커가 남긴 부가 정보 (모델 이름, 단계별 기록 등). 형식은 자유다.",
        examples=[{"model": "paddleocr+vlm", "loops": [{"risk": 0.82}, {"risk": 0.12}]}],
    )


EditAction = Literal["mask", "blur", "mosaic", "partialMask", "remove", "regenerate", "skip"]
ACTION_DESCRIPTION = (
    "`mask`(가림) | `blur`(블러) | `mosaic`(모자이크) | "
    "`partialMask`(부분마스킹, `mask_box` 필요) | `remove`(텍스트제거·인페인팅) | "
    "`regenerate`(이미지재생성, `generation_id` 필요) | "
    "`skip`(그대로 두기 / × 삭제). 글 단서는 `mask` `remove` `skip` 만. "
    "에이전트3 정책(리포트 findings 의 `policy`)보다 약한 선택은 422 로 거절된다."
)


class UserChoiceIn(BaseModel):
    """사용자가 선택한 탐지 항목 처리 방법. 편집 화면의 상태를 그대로 보낸다."""

    idx: int = Field(ge=0, description="findings 리스트 인덱스")
    action: EditAction = Field(description=ACTION_DESCRIPTION, examples=["blur"])
    bbox: list[float] | None = Field(
        default=None,
        min_length=4,
        max_length=4,
        description="모서리로 크기를 조절한 영역 [x1, y1, x2, y2] (픽셀). 없으면 최초 탐지 영역",
        examples=[[30, 50, 330, 120]],
    )
    mask_box: list[float] | None = Field(
        default=None,
        min_length=4,
        max_length=4,
        description="`partialMask`: 영역 안의 상대 좌표 [x1, y1, x2, y2] (0~1)",
        examples=[[0.25, 0, 0.75, 1]],
    )
    generation_id: str | None = Field(
        default=None,
        max_length=64,
        pattern=r"^[0-9a-f]+$",
        description="`regenerate`: `POST /api/images/regenerate` 응답 헤더 `X-Generation-Id` 값",
    )


class TransformRequest(BaseModel):
    """변환 요청. `AWAITING_USER` 상태인 작업에 사용자 선택을 전달한다."""

    choices: list[UserChoiceIn] = Field(
        description="findings 항목별 처리 방법. 목록에 없는 항목은 AI 추천 action을 그대로 쓴다.",
        examples=[[{"idx": 0, "action": "blur"}, {"idx": 1, "action": "skip"}]],
    )


class HealthOut(BaseModel):
    """서버 상태."""

    status: Literal["ok", "degraded"] = Field(
        description="모든 확인 항목이 정상이면 `ok`, 하나라도 실패하면 `degraded`(HTTP 503)",
        examples=["ok"],
    )
    checks: dict[str, bool] = Field(
        description="항목별 확인 결과. `db`, `redis`, (`deep=true`일 때) `s3`",
        examples=[{"db": True, "redis": True, "s3": True}],
    )
