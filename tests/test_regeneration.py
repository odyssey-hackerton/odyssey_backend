import base64
import json
from io import BytesIO
from unittest.mock import MagicMock
from urllib.error import URLError

import pytest
from fastapi import HTTPException, UploadFile
from PIL import Image

from app.api import regeneration as api
from app.core.config import Settings
from app.services import regeneration as service


def png(size=(100, 80), color="red"):
    buffer = BytesIO()
    Image.new("RGB", size, color).save(buffer, format="PNG")
    return buffer.getvalue()


def test_prepare_removes_target_pixels_and_metadata():
    data, box, size = service.prepare_image(png(), "[10.1,20,30.2,40]")
    assert box == (10, 20, 31, 40) and size == (100, 80)
    image = Image.open(BytesIO(data))
    assert image.getpixel((10, 20)) == (255, 255, 255)
    assert image.getpixel((30, 39)) == (255, 255, 255)
    assert image.getpixel((31, 39)) == (255, 0, 0)
    assert not image.getexif()


@pytest.mark.parametrize(
    "bbox",
    [
        "null",
        "{}",
        "[1,2,3]",
        "[1,2,3,4,5]",
        "[true,2,3,4]",
        '["1",2,3,4]',
        "[NaN,2,3,4]",
        "[Infinity,2,3,4]",
        "[20,20,10,30]",
        "[-1,0,10,10]",
        "[0,0,101,80]",
    ],
)
def test_invalid_regions_are_rejected(bbox):
    with pytest.raises(HTTPException) as error:
        service.prepare_image(png(), bbox)
    assert error.value.status_code == 422


def test_invalid_image_and_large_dimensions_are_rejected(monkeypatch):
    with pytest.raises(HTTPException):
        service.prepare_image(b"not an image", "[0,0,10,10]")
    monkeypatch.setattr(service, "MAX_PIXELS", 10)
    with pytest.raises(HTTPException) as error:
        service.prepare_image(png(), "[0,0,10,10]")
    assert error.value.status_code == 413


def test_provider_response_is_cropped_to_selected_area(monkeypatch):
    response = MagicMock()
    response.__enter__.return_value.read.return_value = json.dumps(
        {
            "candidates": [
                {
                    "content": {
                        "parts": [
                            {"text": "generated"},
                            {
                                "inlineData": {
                                    "mimeType": "image/png",
                                    "data": base64.b64encode(png(color="blue")).decode(),
                                }
                            },
                        ]
                    }
                }
            ]
        }
    ).encode()
    send = MagicMock(return_value=response)
    monkeypatch.setattr(service, "urlopen", send)
    output = service.generate_patch(
        png(), (10, 20, 30, 40), (100, 80), Settings(gemini_api_key="fake")
    )
    image = Image.open(BytesIO(output))
    assert image.size == (20, 20) and image.getpixel((0, 0)) == (0, 0, 255)
    payload = json.loads(send.call_args.args[0].data)
    assert payload["generationConfig"]["candidateCount"] == 1
    assert send.call_count == 1


@pytest.mark.parametrize("response", [b"not JSON", b"{}", b'{"candidates":null}'])
def test_bad_provider_response_does_not_return_fake_success(monkeypatch, response):
    sender = MagicMock()
    sender.__enter__.return_value.read.return_value = response
    monkeypatch.setattr(service, "urlopen", MagicMock(return_value=sender))
    with pytest.raises(HTTPException) as error:
        service.generate_patch(png(), (10, 20, 30, 40), (100, 80), Settings(gemini_api_key="fake"))
    assert error.value.status_code == 502


def test_network_failure_is_not_retried_or_leaked(monkeypatch):
    send = MagicMock(side_effect=URLError("secret provider failure"))
    monkeypatch.setattr(service, "urlopen", send)
    with pytest.raises(HTTPException) as error:
        service.generate_patch(png(), (10, 20, 30, 40), (100, 80), Settings(gemini_api_key="fake"))
    assert error.value.status_code == 502
    assert "secret" not in error.value.detail
    assert send.call_count == 1


@pytest.fixture
def api_setup(monkeypatch):
    generate = MagicMock(return_value=png((20, 20)))
    monkeypatch.setattr(api, "generate_patch", generate)
    return generate


class FakeRedis:
    """generation:{id} 보관만 흉내 낸다 (pipeline setex)."""

    def __init__(self, fail=False):
        self.values: dict[str, tuple[int, str]] = {}
        self.fail = fail

    def pipeline(self, transaction=True):
        redis = self

        class Pipe:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *a):
                return False

            def setex(self, key, ttl, value):
                redis.values[key] = (ttl, value)

            async def execute(self):
                if redis.fail:
                    from redis.exceptions import ConnectionError as RedisConnectionError

                    raise RedisConnectionError("down")

        return Pipe()


async def call(redis=None, **kwargs):
    return await api.regenerate(
        Settings(gemini_api_key="fake"),
        redis or FakeRedis(),
        UploadFile(BytesIO(png()), filename="a.png"),
        **kwargs,
    )


async def test_generation_returns_patch_and_keeps_it_for_the_worker(api_setup):
    """패치는 generation:{id} 에만 보관한다 (워커가 적용 시 합성). 입력 사진은 저장하지 않는다."""
    generate = api_setup
    redis = FakeRedis()
    response = await call(redis, bbox="[10,20,30,40]")
    assert response.media_type == "image/png" and response.headers["cache-control"] == "no-store"
    generate.assert_called_once()
    generation_id = response.headers["x-generation-id"]
    [(key, (ttl, value))] = redis.values.items()  # 입력 사진·호출 횟수는 저장하지 않는다
    assert key == f"generation:{generation_id}" and ttl == Settings().progress_ttl_seconds
    assert base64.b64decode(value) == response.body


async def test_patch_store_failure_is_reported(api_setup):
    with pytest.raises(HTTPException) as error:
        await call(FakeRedis(fail=True), bbox="[10,20,30,40]")
    assert error.value.status_code == 503


async def test_invalid_input_does_not_call_provider(api_setup):
    generate = api_setup
    with pytest.raises(HTTPException):
        await call(bbox="[10,20,300,40]")
    generate.assert_not_called()


async def test_provider_failure_is_returned_without_retry(api_setup):
    generate = api_setup
    generate.side_effect = HTTPException(502, "failed")
    with pytest.raises(HTTPException) as error:
        await call(bbox="[10,20,30,40]")
    assert error.value.status_code == 502
    generate.assert_called_once()


@pytest.mark.parametrize(("key", "enabled"), [("", False), ("fake", True)])
async def test_status_reports_availability_without_usage(key, enabled):
    assert await api.generation_status(Settings(gemini_api_key=key)) == {
        "enabled": enabled,
    }


async def test_standalone_endpoint_needs_no_post_or_database(api_setup):
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient

    from app.api.deps import get_redis
    from app.core.config import get_settings

    app = FastAPI()
    app.include_router(api.router)
    app.dependency_overrides[get_settings] = lambda: Settings(gemini_api_key="fake")
    app.dependency_overrides[get_redis] = FakeRedis
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        status = await client.get("/api/images/regenerate")
        assert status.json() == {"enabled": True}
        response = await client.post(
            "/api/images/regenerate",
            files={"file": ("preprocessed.png", png(), "image/png")},
            data={"bbox": "[10,20,30,40]"},
        )
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.headers["cache-control"] == "no-store"
    assert len(response.headers["x-generation-id"]) == 32
    api_setup.assert_called_once()


def test_prepare_regions_removes_every_target():
    data, boxes, size = service.prepare_regions(png(), "[[0,0,10,10],[50,40,60,50]]")
    assert boxes == [(0, 0, 10, 10), (50, 40, 60, 50)] and size == (100, 80)
    image = Image.open(BytesIO(data))
    assert image.getpixel((5, 5)) == (255, 255, 255)
    assert image.getpixel((55, 45)) == (255, 255, 255)
    assert image.getpixel((30, 30)) == (255, 0, 0)


@pytest.mark.parametrize(
    "boxes",
    ["[]", "[1,2,3,4]", "[[1,2,3,4],[1,2,3]]", "[[0,0,101,80]]", json.dumps([[0, 0, 1, 1]] * 21)],
)
def test_invalid_region_lists_are_rejected(boxes):
    with pytest.raises(HTTPException) as error:
        service.prepare_regions(png(), boxes)
    assert error.value.status_code == 422


def test_many_regions_use_one_provider_call_and_keep_order(monkeypatch):
    left = Image.new("RGB", (100, 80), "blue")
    left.paste((0, 255, 0), (50, 0, 100, 80))
    buffer = BytesIO()
    left.save(buffer, format="PNG")
    response = MagicMock()
    response.__enter__.return_value.read.return_value = json.dumps(
        {
            "candidates": [
                {
                    "content": {
                        "parts": [
                            {
                                "inlineData": {
                                    "mimeType": "image/png",
                                    "data": base64.b64encode(buffer.getvalue()).decode(),
                                }
                            }
                        ]
                    }
                }
            ]
        }
    ).encode()
    send = MagicMock(return_value=response)
    monkeypatch.setattr(service, "urlopen", send)
    patches = service.generate_patches(
        png(), [(10, 10, 30, 30), (60, 20, 90, 40)], (100, 80), Settings(gemini_api_key="fake")
    )
    first, second = (Image.open(BytesIO(p)) for p in patches)
    assert first.size == (20, 20) and first.getpixel((0, 0)) == (0, 0, 255)
    assert second.size == (30, 20) and second.getpixel((0, 0)) == (0, 255, 0)
    assert send.call_count == 1
    assert (
        "[[100, 125, 300, 375], [600, 250, 900, 500]]"
        in json.loads(send.call_args.args[0].data)["contents"][0]["parts"][0]["text"]
    )


async def test_boxes_request_returns_patches_in_one_call(monkeypatch):
    generate = MagicMock(return_value=[png((20, 20)), png((10, 10))])
    monkeypatch.setattr(api, "generate_patches", generate)
    redis = FakeRedis()
    response = await call(redis, boxes="[[10,20,30,40],[50,50,60,60]]")
    body = json.loads(response.body)
    assert response.headers["cache-control"] == "no-store"
    assert [Image.open(BytesIO(base64.b64decode(p))).size for p in body["patches"]] == [
        (20, 20),
        (10, 10),
    ]
    generate.assert_called_once()
    # 영역 순서대로 generation_id 가 오고, 워커가 읽을 키에 같은 패치가 들어 있다
    assert len(body["generation_ids"]) == 2 and len(set(body["generation_ids"])) == 2
    for generation_id, patch in zip(body["generation_ids"], body["patches"], strict=True):
        assert redis.values[f"generation:{generation_id}"][1] == patch


@pytest.mark.parametrize("kwargs", [{}, {"bbox": "[1,1,2,2]", "boxes": "[[1,1,2,2]]"}])
async def test_exactly_one_of_bbox_or_boxes(api_setup, kwargs):
    with pytest.raises(HTTPException) as error:
        await call(**kwargs)
    assert error.value.status_code == 422
    api_setup.assert_not_called()
