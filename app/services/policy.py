"""에이전트3 보호 정책 검사 (odyssey_ai/stages/protect.py 의 check_choice 와 같은 규칙).

워커(에이전트3)가 Phase 1 에서 findings 항목마다 `policy` 를 붙여 보낸다. 사용자가 /transform 으로
보낸 편집이 그 정책보다 약하면 큐에 넣기 전에 422 로 거절해 화면에 바로 알린다. 워커도 같은 검사를
다시 한다.
규칙을 바꿀 때는 두 레포를 함께 고친다.

policy = {
  level: "locked" | "high" | "medium" | "low",
  allowed_actions: [...],      # 이 영역에 적용할 수 있는 action
  anchor_bbox: [x1,y1,x2,y2],  # 최초 탐지 좌표
  allow_shrink / allow_delete / allow_partial: bool
}
"""

import math
from typing import Any

from fastapi import HTTPException

# 프론트 flow.ts ALLOWED_ACTIONS + 이미지재생성(사진 아래 패널, 모든 유형에서 사용 가능)
UI_ACTIONS: dict[str, list[str]] = {
    "text": ["mask", "blur", "partialMask", "remove", "regenerate"],
    "object": ["mask", "blur", "mosaic", "regenerate"],
    "location": ["mask", "regenerate"],
}
IMAGE_ACTIONS = {"mask", "blur", "mosaic", "partialMask", "remove", "regenerate", "skip"}
TEXT_ACTIONS = {"mask", "remove", "skip"}


def _box(value: Any) -> list[float] | None:
    if not isinstance(value, list) or len(value) != 4:
        return None
    try:
        box = [float(v) for v in value]
    except (TypeError, ValueError):
        return None
    if any(not math.isfinite(v) for v in box):
        return None
    return box


def check_choice(
    finding: dict[str, Any],
    action: str,
    bbox: Any = None,
    mask_box: Any = None,
    generation_id: str | None = None,
    image_size: tuple[int, int] | None = None,
) -> None:
    """위반이면 사용자에게 보여 줄 메시지로 HTTPException(422)."""
    title = finding.get("title") or finding.get("type", "")
    policy = finding.get("policy") or {}
    is_text = finding.get("source") == "text"
    is_file = finding.get("source") == "exif"

    def reject(message: str) -> None:
        raise HTTPException(422, message)

    if is_text or is_file:
        if action not in TEXT_ACTIONS:
            reject(f"'{title}'에는 {action} 처리를 쓸 수 없어요.")
        return
    if action not in IMAGE_ACTIONS:
        reject(f"'{title}'에는 {action} 처리를 쓸 수 없어요.")

    level = policy.get("level", "medium")
    allowed = set(policy.get("allowed_actions") or UI_ACTIONS.get(finding.get("category", ""), []))
    if action == "skip":
        if not policy.get("allow_delete", True):
            reject(f"'{title}'은(는) 위험도가 높아 그대로 둘 수 없어요. 가림을 유지해 주세요.")
    elif allowed and action not in allowed:
        if level == "locked":
            reject(f"'{title}'은(는) 전체 가림만 할 수 있어요.")
        if action == "partialMask" and not policy.get("allow_partial", True):
            reject(f"'{title}'은(는) 위험도가 높아 부분마스킹을 쓸 수 없어요.")
        reject(f"'{title}'에는 {action} 처리를 쓸 수 없어요.")

    if action == "partialMask":
        part = _box(mask_box)
        if part is None or not (0 <= part[0] < part[2] <= 1 and 0 <= part[1] < part[3] <= 1):
            reject(f"'{title}'의 부분마스킹 범위를 사진에서 지정해 주세요.")
    if action == "regenerate" and not generation_id:
        reject(f"'{title}'의 이미지를 먼저 생성하거나 다른 편집 방식을 선택해 주세요.")

    if bbox is None or action == "skip":
        return
    box = _box(bbox)
    if box is None or not (box[0] < box[2] and box[1] < box[3]):
        reject(f"'{title}'의 영역 좌표가 올바르지 않아요.")
    if image_size is not None:
        w, h = image_size
        if not (0 <= box[0] and 0 <= box[1] and box[2] <= w and box[3] <= h):
            reject(f"'{title}'의 영역이 사진 범위를 벗어났어요.")
    anchor = _box(policy.get("anchor_bbox")) or _box(finding.get("bbox"))
    if anchor and not policy.get("allow_shrink", True):
        tolerance = 0.5  # 화면 좌표 반올림
        if (
            box[0] > anchor[0] + tolerance
            or box[1] > anchor[1] + tolerance
            or box[2] < anchor[2] - tolerance
            or box[3] < anchor[3] - tolerance
        ):
            reject(f"'{title}'은(는) 위험도가 높아 처음 찾은 영역보다 작게 줄일 수 없어요.")
