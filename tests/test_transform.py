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
