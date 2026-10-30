"""Swagger 문서가 빠짐없이 채워져 있는지 확인한다."""

from app.main import app

METHODS = {"get", "post", "put", "patch", "delete"}


def _operations():
    for path, item in app.openapi()["paths"].items():
        for method, op in item.items():
            if method in METHODS:
                yield f"{method.upper()} {path}", op


def test_every_operation_has_summary_and_description():
    missing = [
        name for name, op in _operations() if not op.get("summary") or not op.get("description")
    ]
    assert missing == []


def test_every_schema_field_has_description():
    schemas = app.openapi()["components"]["schemas"]
    ours = {
        k: v
        for k, v in schemas.items()
        if not k.startswith(("HTTPValidationError", "ValidationError", "Body_"))
    }
    missing = [
        f"{name}.{field}"
        for name, schema in ours.items()
        for field, prop in schema.get("properties", {}).items()
        if not prop.get("description")
    ]
    assert missing == []


def test_upload_documents_both_fields_and_error_codes():
    op = app.openapi()["paths"]["/api/jobs"]["post"]
    assert {"413", "415", "422", "503"} <= set(op["responses"])


def test_sse_endpoint_is_event_stream():
    op = app.openapi()["paths"]["/api/jobs/{job_id}/events"]["get"]
    assert "text/event-stream" in op["responses"]["200"]["content"]
