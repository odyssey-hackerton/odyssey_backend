import hashlib
import json
import uuid
from datetime import UTC, datetime
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException, UploadFile
from pydantic import ValidationError

from app.api import jobs
from app.core.config import Settings
from app.schemas.contract import JobStatus
from app.schemas.jobs import TransformRequest

IMAGE = b"\x89PNG\r\n\x1a\n" + b"test image"


def test_stale_awaiting_progress_does_not_finish_new_transform():
    record = SimpleNamespace(
        id=uuid.uuid4(),
        input_type="image",
        status=JobStatus.QUEUED,
        created_at=datetime.now(UTC),
        finished_at=None,
        error=None,
    )
    progress = {"status": "AWAITING_USER"}
    assert jobs._status_out(record, progress).status == JobStatus.QUEUED
    record.status = JobStatus.AWAITING_USER
    assert jobs._status_out(record, progress).status == JobStatus.AWAITING_USER


def upload(data=IMAGE):
    return UploadFile(BytesIO(data), filename="original.png")


@pytest.fixture
def context(monkeypatch):
    job = SimpleNamespace(
        id=uuid.uuid4(),
        execution_id=uuid.uuid4(),
        input_sha256=hashlib.sha256(IMAGE).hexdigest(),
        status=JobStatus.AWAITING_USER,
        input_type="image_text",
        object_key="originals/test.png",
        result=SimpleNamespace(
            findings=[
                {"type": "phone_number", "source": "text", "spans": [[0, 13]], "action": "mask"}
            ]
        ),
    )
    monkeypatch.setattr(jobs, "_get_job", AsyncMock(return_value=job))
    monkeypatch.setattr(jobs, "set_progress", AsyncMock())
    enqueue = AsyncMock()
    monkeypatch.setattr(jobs, "enqueue_job", enqueue)
    return job, AsyncMock(), AsyncMock(get=AsyncMock(return_value="010-0000-0000")), enqueue


async def test_transform_preserves_text_and_original_findings(context):
    job, session, redis, enqueue = context
    await jobs.submit_transform(
        job.id,
        session,
        redis,
        Settings(),
        AsyncMock(),
        choices=json.dumps([{"idx": 0, "action": "mask"}]),
        file=upload(),
    )
    message = enqueue.call_args.args[2]
    assert message.text == "010-0000-0000"
    assert message.initial_findings[0].model_dump()["spans"] == [[0, 13]]
    assert job.status == JobStatus.QUEUED


@pytest.mark.parametrize("indices", [[1], [0, 0]])
async def test_invalid_selection_not_enqueued(context, indices):
    job, session, redis, enqueue = context
    with pytest.raises(HTTPException) as error:
        await jobs.submit_transform(
            job.id,
            session,
            redis,
            Settings(),
            AsyncMock(),
            choices=json.dumps([{"idx": idx, "action": "mask"} for idx in indices]),
            file=upload(),
        )
    assert error.value.status_code == 422
    enqueue.assert_not_called()


async def test_expired_caption_requires_reupload(context):
    job, session, redis, enqueue = context
    redis.get.return_value = None
    with pytest.raises(HTTPException) as error:
        await jobs.submit_transform(
            job.id, session, redis, Settings(), AsyncMock(), choices="[]", file=upload()
        )
    assert error.value.status_code == 409
    enqueue.assert_not_called()
    session.commit.assert_not_called()


@pytest.mark.parametrize("choice", [{"idx": -1, "action": "mask"}, {"idx": 0, "action": "invent"}])
def test_invalid_actions_and_negative_indices_rejected(choice):
    with pytest.raises(ValidationError):
        TransformRequest(choices=[choice])


@pytest.mark.parametrize("file", [None, b"different"])
async def test_missing_or_different_original_not_enqueued(context, file):
    job, session, redis, enqueue = context
    storage = AsyncMock()
    with pytest.raises(HTTPException) as error:
        await jobs.submit_transform(
            job.id,
            session,
            redis,
            Settings(),
            storage,
            choices="[]",
            file=upload(IMAGE + file) if file else None,
        )
    assert error.value.status_code == 409
    storage.put.assert_not_called()
    enqueue.assert_not_called()
    session.commit.assert_not_called()


async def test_reupload_has_new_execution_and_key(context):
    job, session, redis, enqueue = context
    previous_execution = job.execution_id
    storage = AsyncMock()
    await jobs.submit_transform(
        job.id, session, redis, Settings(), storage, choices="[]", file=upload()
    )
    msg = enqueue.call_args.args[2]
    assert msg.execution_id != previous_execution
    assert msg.execution_id == job.execution_id
    assert str(msg.execution_id) in msg.object_key
    assert storage.put.call_args.args[1] == IMAGE
    assert msg.initial_findings is not None


async def test_enqueue_failure_deletes_reupload_and_restores_execution(context):
    job, session, redis, enqueue = context
    previous_execution = job.execution_id
    enqueue.side_effect = RuntimeError("queue unavailable")
    storage = AsyncMock()
    with pytest.raises(HTTPException) as error:
        await jobs.submit_transform(
            job.id, session, redis, Settings(), storage, choices="[]", file=upload()
        )
    assert error.value.status_code == 503
    storage.delete.assert_awaited_once_with(storage.put.call_args.args[0])
    assert job.execution_id == previous_execution
    assert job.status == JobStatus.AWAITING_USER


async def test_text_only_transform_needs_no_file(context):
    job, session, redis, enqueue = context
    job.input_type = "text"
    storage = AsyncMock()
    await jobs.submit_transform(job.id, session, redis, Settings(), storage, choices="[]")
    assert enqueue.call_args.args[2].object_key is None
    storage.put.assert_not_called()


async def test_multipart_http_request_reaches_transform(context):
    import httpx
    from fastapi import FastAPI

    from app.api.deps import get_redis, get_session, get_settings, get_storage

    job, session, redis, enqueue = context
    storage = AsyncMock()
    app = FastAPI()
    app.include_router(jobs.router)
    app.dependency_overrides[get_session] = lambda: session
    app.dependency_overrides[get_redis] = lambda: redis
    app.dependency_overrides[get_storage] = lambda: storage
    app.dependency_overrides[get_settings] = Settings
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(
            f"/api/jobs/{job.id}/transform",
            files={"file": ("original.png", IMAGE, "image/png")},
            data={"choices": '[{"idx":0,"action":"mask"}]'},
        )
        old_request = await client.post(
            f"/api/jobs/{job.id}/transform",
            json={"choices": []},
        )
    assert old_request.status_code == 422
    assert response.status_code == 202, response.text
    assert enqueue.call_args.args[2].user_choices[0].action == "mask"


async def test_upload_records_fingerprint_and_execution(monkeypatch):
    session, redis, storage = AsyncMock(), AsyncMock(), AsyncMock()
    session.add = MagicMock()
    enqueue = AsyncMock()
    monkeypatch.setattr(jobs, "enqueue_job", enqueue)
    monkeypatch.setattr(jobs, "set_progress", AsyncMock())
    created = await jobs.create_job(session, redis, storage, Settings(), file=upload())
    record = session.add.call_args.args[0]
    message = enqueue.call_args.args[2]
    assert record.input_sha256 == hashlib.sha256(IMAGE).hexdigest()
    assert record.execution_id == message.execution_id
    assert record.id == created.job_id
    assert record.object_key == message.object_key == storage.put.call_args.args[0]


@pytest.mark.parametrize("failure", ["db", "queue"])
async def test_upload_registration_failure_discards_original(monkeypatch, failure):
    session, redis, storage = AsyncMock(), AsyncMock(), AsyncMock()
    session.add = MagicMock()
    enqueue = AsyncMock()
    monkeypatch.setattr(jobs, "enqueue_job", enqueue)
    monkeypatch.setattr(jobs, "set_progress", AsyncMock())
    if failure == "db":
        session.commit.side_effect = RuntimeError("database unavailable")
    else:
        enqueue.side_effect = RuntimeError("queue unavailable")
    with pytest.raises((RuntimeError, HTTPException)):
        await jobs.create_job(session, redis, storage, Settings(), file=upload())
    storage.delete.assert_awaited_once_with(storage.put.call_args.args[0])


# ---------------------------------------------------------------- 에이전트3 정책 (choices 확장)
def policy_job(monkeypatch, findings):
    job = SimpleNamespace(
        id=uuid.uuid4(),
        execution_id=uuid.uuid4(),
        input_sha256=hashlib.sha256(REAL_PNG).hexdigest(),
        status=JobStatus.AWAITING_USER,
        input_type="image",
        object_key="originals/test.png",
        result=SimpleNamespace(findings=findings),
    )
    monkeypatch.setattr(jobs, "_get_job", AsyncMock(return_value=job))
    monkeypatch.setattr(jobs, "set_progress", AsyncMock())
    enqueue = AsyncMock()
    monkeypatch.setattr(jobs, "enqueue_job", enqueue)
    return job, enqueue


def real_png():
    from io import BytesIO as _B

    from PIL import Image

    out = _B()
    Image.new("RGB", (100, 80), "white").save(out, format="PNG")
    return out.getvalue()


REAL_PNG = real_png()
FACE = {
    "type": "face",
    "source": "vlm",
    "title": "얼굴",
    "category": "object",
    "bbox": [20, 20, 60, 40],
    "action": "mask",
    "policy": {
        "level": "high",
        "allowed_actions": ["mask", "blur", "mosaic"],
        "anchor_bbox": [20, 20, 60, 40],
        "allow_shrink": False,
        "allow_delete": False,
        "allow_partial": False,
    },
}
SIGN = {
    "type": "store_name",
    "source": "vlm",
    "title": "간판",
    "category": "location",
    "bbox": [70, 50, 90, 70],
    "action": "mask",
    "policy": {
        "level": "medium",
        "allowed_actions": ["mask", "regenerate"],
        "anchor_bbox": [70, 50, 90, 70],
        "allow_shrink": True,
        "allow_delete": True,
        "allow_partial": True,
    },
}


@pytest.mark.parametrize(
    ("choices", "message"),
    [
        ('[{"idx":0,"action":"skip"}]', "그대로 둘 수 없어요"),
        ('[{"idx":0,"action":"mask","bbox":[25,22,60,40]}]', "작게 줄일 수 없어요"),
        ('[{"idx":0,"action":"partialMask","mask_box":[0,0,0.5,1]}]', "쓸 수 없어요"),
        ('[{"idx":0,"action":"mask","bbox":[0,0,500,40]}]', "사진 범위"),
        ('[{"idx":1,"action":"regenerate","bbox":[70,50,90,70]}]', "먼저 생성"),
        ('[{"idx":1,"action":"regenerate","generation_id":"dead"}]', "만료"),
        ('[{"idx":1,"action":"blur"}]', "쓸 수 없어요"),
    ],
)
async def test_edits_weaker_than_agent3_policy_are_rejected_before_enqueue(
    monkeypatch, choices, message
):
    job, enqueue = policy_job(monkeypatch, [FACE, SIGN])
    redis = AsyncMock(get=AsyncMock(return_value=None), exists=AsyncMock(return_value=0))
    with pytest.raises(HTTPException) as error:
        await jobs.submit_transform(
            job.id,
            AsyncMock(),
            redis,
            Settings(),
            AsyncMock(),
            choices=choices,
            file=upload(REAL_PNG),
        )
    assert error.value.status_code == 422 and message in error.value.detail
    enqueue.assert_not_called()


async def test_allowed_edits_carry_geometry_and_generation_into_the_queue(monkeypatch):
    job, enqueue = policy_job(monkeypatch, [FACE, SIGN])
    redis = AsyncMock(get=AsyncMock(return_value=None), exists=AsyncMock(return_value=1))
    choices = (
        '[{"idx":0,"action":"blur","bbox":[10,10,70,50]},'
        '{"idx":1,"action":"regenerate","bbox":[65,45,95,75],"generation_id":"ab12"}]'
    )
    await jobs.submit_transform(
        job.id, AsyncMock(), redis, Settings(), AsyncMock(), choices=choices, file=upload(REAL_PNG)
    )
    message = enqueue.call_args.args[2]
    first, second = message.user_choices
    assert (first.action, first.bbox) == ("blur", [10, 10, 70, 50])
    assert (second.action, second.generation_id, second.bbox) == (
        "regenerate",
        "ab12",
        [65, 45, 95, 75],
    )
    assert message.initial_findings[0].model_dump()["policy"]["level"] == "high"
    redis.exists.assert_awaited_once_with("generation:ab12")
