import json
import uuid

from app.schemas.contract import ResultMessage


def test_result_ignores_unknown_fields_and_keeps_finding_extras():
    """AI 쪽이 필드를 추가하거나 새 탐지 유형을 써도 API가 깨지지 않아야 한다."""
    payload = {
        "schema_version": 1,
        "job_id": str(uuid.uuid4()),
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
    msg = ResultMessage.model_validate({"job_id": str(uuid.uuid4()), "status": "FAILED"})
    assert msg.findings == []
    assert msg.error is None
