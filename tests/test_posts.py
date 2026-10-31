import hashlib
import json
import uuid
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError
from fastapi import HTTPException, UploadFile

from app.api import jobs as job_api
from app.api import posts
from app.core.config import Settings
from app.schemas.contract import JobStatus

PNG = b"\x89PNG\r\n\x1a\n" + b"photo-"


def upload(data: bytes, name: str = "a.png") -> UploadFile:
    return UploadFile(BytesIO(data), filename=name)


@pytest.mark.parametrize(
    ("statuses", "expected"),
    [
        (["AWAITING_USER", "AWAITING_USER"], "AWAITING_USER"),
        (["AWAITING_USER", "ANALYZING"], "ANALYZING"),
        (["DETECTING", "ANALYZING", "QUEUED"], "QUEUED"),
        (["DONE", "VERIFYING"], "VERIFYING"),
        (["DONE", "DONE"], "DONE"),
        (["DONE", "FAILED"], "FAILED"),
        (["AWAITING_USER", "FAILED"], "FAILED"),
        ([], "FAILED"),
    ],
)
def test_post_status_follows_the_slowest_item(statuses, expected):
    assert posts.aggregate_status(statuses) == expected


@pytest.fixture
def registered(monkeypatch):
    calls = []

    async def fake_register(session, redis, storage, settings, **kw):
        calls.append(kw)
        return uuid.uuid4()

    monkeypatch.setattr(job_api, "_register_job", fake_register)
    session = AsyncMock()
    session.add = MagicMock()
    return session, calls


async def test_one_job_per_photo_and_caption_rides_with_the_first(registered):
    session, calls = registered
    out = await posts.create_post(
        session,
        AsyncMock(),
        AsyncMock(),
        Settings(),
        files=[upload(PNG + b"1"), upload(PNG + b"2")],
        text="연락은 010-1234-5678",
    )
    assert [c["position"] for c in calls] == [0, 1]
    assert [c["text"] for c in calls] == ["연락은 010-1234-5678", None]
    assert all(c["post_id"] == out.post_id for c in calls)
    assert [i.input_type for i in out.items] == ["image_text", "image"]


async def test_caption_only_post_makes_one_text_job(registered):
    session, calls = registered
    out = await posts.create_post(
        session, AsyncMock(), AsyncMock(), Settings(), files=None, text="글만"
    )
    assert len(calls) == 1 and calls[0]["image"] is None and calls[0]["text"] == "글만"
    assert out.items[0].input_type == "text"


@pytest.mark.parametrize(
    ("files", "text", "code"),
    [
        ([upload(PNG)] * 5, None, 422),
        ([], "   ", 422),
        ([upload(PNG), upload(b"GIF89a....", "b.gif")], "x", 415),
    ],
)
async def test_invalid_post_creates_nothing(registered, files, text, code):
    session, calls = registered
    with pytest.raises(HTTPException) as e:
        await posts.create_post(
            session, AsyncMock(), AsyncMock(), Settings(), files=files, text=text
        )
    assert e.value.status_code == code
    assert calls == []
    session.add.assert_not_called()


def make_job(position: int, data: bytes | None, findings: int = 1):
    return SimpleNamespace(
        id=uuid.uuid4(),
        position=position,
        input_type=("image_text" if position == 0 else "image") if data else "text",
        status=JobStatus.AWAITING_USER,
        input_sha256=hashlib.sha256(data).hexdigest() if data else None,
        execution_id=uuid.uuid4(),
        result=SimpleNamespace(
            findings=[{"type": "address", "action": "mask"}] * findings,
        ),
    )


@pytest.fixture
def post_jobs(monkeypatch):
    jobs = [make_job(0, PNG + b"1"), make_job(1, PNG + b"2", findings=2)]
    monkeypatch.setattr(
        posts, "_get_post", AsyncMock(return_value=SimpleNamespace(id=uuid.uuid4(), jobs=jobs))
    )
    started = AsyncMock()
    monkeypatch.setattr(job_api, "_start_transform", started)
    session = AsyncMock()
    result = MagicMock()
    result.scalars.return_value.all.return_value = jobs
    session.execute.return_value = result
    redis = AsyncMock(get=AsyncMock(return_value="연락은 010-1234-5678"))
    return jobs, session, redis, started


async def test_transform_starts_every_item_with_its_own_choices(post_jobs):
    jobs, session, redis, started = post_jobs
    choices = [
        {"position": 0, "idx": 0, "action": "blur"},
        {"position": 1, "idx": 1, "action": "skip"},
    ]
    await posts.transform_post(
        uuid.uuid4(),
        session,
        redis,
        AsyncMock(),
        Settings(),
        choices=json.dumps(choices),
        files=[upload(PNG + b"1"), upload(PNG + b"2")],
    )
    assert started.await_count == 2
    first, second = (c.args for c in started.await_args_list)
    assert first[4] is jobs[0] and [c.action for c in first[5]] == ["blur"]
    assert first[7] == "연락은 010-1234-5678"
    assert second[4] is jobs[1] and [(c.idx, c.action) for c in second[5]] == [(1, "skip")]
    assert second[7] is None


@pytest.mark.parametrize(
    ("files", "choices", "code"),
    [
        ([upload(PNG + b"1")], [], 422),
        ([upload(PNG + b"1"), upload(PNG + b"X")], [], 409),
        (
            [upload(PNG + b"1"), upload(PNG + b"2")],
            [{"position": 5, "idx": 0, "action": "mask"}],
            422,
        ),
        (
            [upload(PNG + b"1"), upload(PNG + b"2")],
            [{"position": 1, "idx": 2, "action": "mask"}],
            422,
        ),
    ],
)
async def test_transform_checks_all_items_before_starting_any(post_jobs, files, choices, code):
    _, session, redis, started = post_jobs
    with pytest.raises(HTTPException) as e:
        await posts.transform_post(
            uuid.uuid4(),
            session,
            redis,
            AsyncMock(),
            Settings(),
            choices=json.dumps(choices),
            files=files,
        )
    assert e.value.status_code == code
    started.assert_not_awaited()


async def test_result_image_is_served_from_this_server(monkeypatch):
    job = SimpleNamespace(status=JobStatus.DONE, result_object_key="results/a/b.png")
    monkeypatch.setattr(job_api, "_get_job", AsyncMock(return_value=job))
    storage = AsyncMock(get=AsyncMock(return_value=b"png-bytes"))
    res = await job_api.get_result_image(uuid.uuid4(), AsyncMock(), storage)
    assert res.body == b"png-bytes"
    assert res.media_type == "image/png"
    assert res.headers["cache-control"] == "no-store"
    job.status = JobStatus.VERIFYING
    with pytest.raises(HTTPException) as e:
        await job_api.get_result_image(uuid.uuid4(), AsyncMock(), storage)
    assert e.value.status_code == 409


@pytest.mark.parametrize("count", [0, 1, 3, 4])
async def test_share_result_contains_processed_caption_and_every_photo(monkeypatch, count):
    jobs = [make_job(i, PNG if count else None) for i in range(count or 1)]
    for job in jobs:
        job.status = JobStatus.DONE
        job.result.result_text = "처리된 본문" if job.position == 0 else None
        job.result_object_key = f"results/{job.id}.png" if count else None
    post = SimpleNamespace(id=uuid.uuid4(), jobs=jobs)
    monkeypatch.setattr(posts, "_get_post", AsyncMock(return_value=post))

    result = await posts.get_post_result(post.id, AsyncMock())

    assert result.text == "처리된 본문"
    assert [item.position for item in result.items] == list(range(count or 1))
    assert [item.image_url for item in result.items] == [
        f"/api/jobs/{job.id}/image" if count else None for job in jobs
    ]


@pytest.mark.parametrize("missing", ["image", "text", "record"])
async def test_incomplete_result_cannot_silently_share_only_some_content(monkeypatch, missing):
    jobs = [make_job(0, None)] if missing == "text" else [make_job(i, PNG) for i in range(2)]
    for job in jobs:
        job.status = JobStatus.DONE
        job.result_object_key = f"results/{job.id}.png"
    if missing == "image":
        jobs[-1].result_object_key = None
    else:
        jobs[-1].result = None
    monkeypatch.setattr(posts, "_get_post", AsyncMock(return_value=SimpleNamespace(jobs=jobs)))

    with pytest.raises(HTTPException) as exc:
        await posts.get_post_result(uuid.uuid4(), AsyncMock())

    assert exc.value.status_code == 404


@pytest.mark.parametrize("state", [JobStatus.AWAITING_USER, JobStatus.VERIFYING, JobStatus.FAILED])
async def test_share_result_requires_every_item_to_be_done(monkeypatch, state):
    jobs = [make_job(i, PNG) for i in range(2)]
    jobs[0].status, jobs[1].status = JobStatus.DONE, state
    monkeypatch.setattr(posts, "_get_post", AsyncMock(return_value=SimpleNamespace(jobs=jobs)))
    with pytest.raises(HTTPException) as exc:
        await posts.get_post_result(uuid.uuid4(), AsyncMock())
    assert exc.value.status_code == 409


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (ClientError({"Error": {"Code": "NoSuchKey", "Message": "private key"}}, "GetObject"), 404),
        (
            ClientError(
                {"Error": {"Code": "AccessDenied", "Message": "private bucket"}}, "GetObject"
            ),
            503,
        ),
        (EndpointConnectionError(endpoint_url="https://private-bucket.invalid"), 503),
    ],
)
async def test_share_image_storage_errors_are_safe_and_actionable(monkeypatch, error, code):
    job = SimpleNamespace(status=JobStatus.DONE, result_object_key="results/a.png")
    monkeypatch.setattr(job_api, "_get_job", AsyncMock(return_value=job))
    storage = AsyncMock(get=AsyncMock(side_effect=error))

    with pytest.raises(HTTPException) as exc:
        await job_api.get_result_image(uuid.uuid4(), AsyncMock(), storage)

    assert exc.value.status_code == code
    assert "private" not in exc.value.detail
    storage.get.assert_awaited_once_with("results/a.png")
