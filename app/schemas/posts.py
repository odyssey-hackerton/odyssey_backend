"""게시물(post) API 스키마. 게시물 = 사진 최대 4장 + 글. 사진마다 작업(job)이 하나씩 붙는다."""

from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field

from app.schemas.contract import InputType
from app.schemas.jobs import JOB_ID_EXAMPLE, STATUS_DESCRIPTION, UserChoiceIn

POST_ID_EXAMPLE = "9a1c4e2b-7d3f-4b6a-8e10-2c5d7f9b1a34"
POSITION_DESCRIPTION = (
    "게시물 안의 순서 (0부터, 올린 사진 순서와 같다). 글은 0번 항목과 함께 분석한다."
)


class PostItem(BaseModel):
    """게시물에 속한 작업 1건."""

    position: int = Field(description=POSITION_DESCRIPTION, examples=[0])
    job_id: UUID = Field(description="이 항목의 작업 ID", examples=[JOB_ID_EXAMPLE])
    input_type: InputType = Field(
        description="`image`(사진만), `text`(글만), `image_text`(사진 + 글)",
        examples=["image_text"],
    )


class PostCreated(BaseModel):
    """게시물 등록 결과. 분석은 백그라운드에서 진행된다."""

    post_id: UUID = Field(description="게시물 ID", examples=[POST_ID_EXAMPLE])
    status: str = Field(description="등록 직후 상태. 항상 `QUEUED`", examples=["QUEUED"])
    items: list[PostItem] = Field(description="사진 순서대로 만든 작업 목록")


class PostItemStatus(PostItem):
    """항목별 진행 상황."""

    status: str = Field(description=STATUS_DESCRIPTION, examples=["ANALYZING"])
    iteration: int = Field(default=0, description="재검증 반복 횟수", examples=[0])
    message: str | None = Field(
        default=None, description="워커가 남긴 진행 메시지", examples=[None]
    )
    error: str | None = Field(default=None, description="실패 이유", examples=[None])


class PostStatusOut(BaseModel):
    """게시물 전체 진행 상황. 가장 늦은 항목 기준이다."""

    post_id: UUID = Field(description="게시물 ID", examples=[POST_ID_EXAMPLE])
    status: str = Field(
        description=(
            "전체 상태. 하나라도 `FAILED`면 `FAILED`, 모두 `AWAITING_USER`면 `AWAITING_USER`, "
            "모두 `DONE`이면 `DONE`, 그 밖에는 가장 늦은 항목의 단계"
        ),
        examples=["AWAITING_USER"],
    )
    items: list[PostItemStatus] = Field(description="항목별 진행 상황 (순서대로)")


class PostItemReport(PostItem):
    """항목별 분석·재검증 결과."""

    status: str = Field(
        description="항목 상태 (`AWAITING_USER` 또는 `DONE`)", examples=["AWAITING_USER"]
    )
    risk_detected: bool | None = Field(description="개인정보 위험 발견 여부", examples=[True])
    risk_before: float | None = Field(description="처리 전 위험도 (0~1)", examples=[0.82])
    risk_after: float | None = Field(
        description="처리 후 위험도 (0~1, 분석 단계에서는 null)", examples=[None]
    )
    iterations: int = Field(description="재검증 반복 횟수", examples=[0])
    findings: list[dict[str, Any]] = Field(
        description=(
            "탐지 항목. 분석 단계(`AWAITING_USER`)에서는 사용자에게 보여 줄 단서 목록이고, "
            "`DONE` 뒤에는 재검증에서 다시 찾은 단서 목록이다. 사진 영역은 `bbox`, 글 단서는 "
            "`source: text`와 `spans`(글자 위치)를 가진다. 변환 요청의 `idx`는 이 배열의 인덱스다. "
            "에이전트3이 붙이는 `category`(`text`|`object`|`location`, 편집 도구 분류), "
            "`action`(추천), `policy`(허용 처리·축소/삭제 가능 여부)도 포함된다."
        ),
        examples=[
            [
                {
                    "type": "landmark",
                    "source": "vlm",
                    "title": "간판 · 위치 단서",
                    "risk_level": "medium",
                    "bbox": [40, 60, 320, 110],
                    "action": "mask",
                },
                {"type": "phone_number", "source": "text", "spans": [[6, 19]], "action": "mask"},
            ]
        ],
    )
    details: dict[str, Any] = Field(description="AI 워커가 남긴 부가 정보", examples=[{}])


class PostReportOut(BaseModel):
    """게시물 리포트. 모든 항목이 `AWAITING_USER` 또는 `DONE`일 때 조회할 수 있다."""

    post_id: UUID = Field(description="게시물 ID", examples=[POST_ID_EXAMPLE])
    status: str = Field(description="전체 상태", examples=["AWAITING_USER"])
    risk_before: float | None = Field(
        description="처리 전 위험도 (항목 중 가장 높은 값)", examples=[0.82]
    )
    risk_after: float | None = Field(
        description="처리 후 위험도 (항목 중 가장 높은 값)", examples=[0.12]
    )
    items: list[PostItemReport] = Field(description="항목별 리포트 (순서대로)")


class PostChoiceIn(UserChoiceIn):
    """항목 하나의 탐지 항목 하나에 대한 처리 방법 (영역·부분마스킹·생성 패치 포함)."""

    position: int = Field(ge=0, description=POSITION_DESCRIPTION, examples=[0])


class PostResultItem(PostItem):
    """항목별 결과 사진."""

    image_url: str | None = Field(
        description=(
            "결과 사진 주소 (같은 서버의 `/api/jobs/{job_id}/image`). 사진이 없는 항목은 null"
        ),
        examples=[f"/api/jobs/{JOB_ID_EXAMPLE}/image"],
    )


class PostResultOut(BaseModel):
    """보호 처리된 게시물. 모든 항목이 `DONE`일 때 조회할 수 있다."""

    post_id: UUID = Field(description="게시물 ID", examples=[POST_ID_EXAMPLE])
    text: str | None = Field(
        description="처리된 글. 글을 고치지 않기로 했으면 원래 글, 글이 없으면 null",
        examples=["오늘 [가림]에서 만나요"],
    )
    items: list[PostResultItem] = Field(description="항목별 결과 (순서대로)")
