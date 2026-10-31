import json
import uuid

from app.schemas.contract import ResultMessage


def test_backend_and_worker_contracts_match():
    import ast
    from pathlib import Path

    root = Path(__file__).resolve().parents[2]
    if not (root / "odyssey_ai/worker/contract.py").is_file():
        import pytest

        pytest.skip("AI 레포를 함께 체크아웃했을 때 두 계약을 비교한다")
    trees = []
    for name in ["odyssey_backend/app/schemas/contract.py", "odyssey_ai/worker/contract.py"]:
        tree = ast.parse((root / name).read_text())
        tree.body = tree.body[1:]  # 모듈 설명만 다르다.
        trees.append(ast.dump(tree))
    assert trees[0] == trees[1]


def test_result_ignores_unknown_fields_and_keeps_finding_extras():
    """AI 쪽이 필드를 추가하거나 새 탐지 유형을 써도 API가 깨지지 않아야 한다."""
    payload = {
        "schema_version": 2,
        "job_id": str(uuid.uuid4()),
        "execution_id": str(uuid.uuid4()),
        "status": "DONE",
        "brand_new_top_level_field": {"anything": 1},
        "findings": [
            {"type": "school_uniform", "source": "vlm", "score": 0.7, "reasoning": "교복 로고"}
        ],
        "details": {"model": "experimental-v3"},
    }
    msg = ResultMessage.model_validate_json(json.dumps(payload))

    assert msg.status == "DONE"
    dumped = msg.findings[0].model_dump(exclude_none=True)
    assert dumped["type"] == "school_uniform"
    assert dumped["reasoning"] == "교복 로고"
    assert msg.details == {"model": "experimental-v3"}


def test_result_minimal_failed_message():
    msg = ResultMessage.model_validate(
        {"job_id": str(uuid.uuid4()), "execution_id": str(uuid.uuid4()), "status": "FAILED"}
    )
    assert msg.findings == []
    assert msg.error is None


def test_job_message_image_text_carries_both_inputs():
    """사진 + 글 작업은 object_key 와 text 를 한 메시지에 함께 담는다."""
    from datetime import UTC, datetime

    from app.schemas.contract import JobMessage

    msg = JobMessage(
        job_id=uuid.uuid4(),
        execution_id=uuid.uuid4(),
        input_type="image_text",
        object_key="originals/x.jpg",
        text="010-1234-5678",
        created_at=datetime.now(UTC),
    )
    decoded = JobMessage.model_validate_json(msg.model_dump_json())
    assert decoded.input_type == "image_text"
    assert decoded.object_key == "originals/x.jpg"
    assert decoded.text == "010-1234-5678"


def test_input_type_of():
    from app.api.jobs import input_type_of

    assert input_type_of(has_image=True, has_text=False) == "image"
    assert input_type_of(has_image=False, has_text=True) == "text"
    assert input_type_of(has_image=True, has_text=True) == "image_text"
