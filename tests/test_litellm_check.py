import base64
import io
import json
import unittest
import urllib.error
import zlib
from unittest.mock import patch

from scripts.check_litellm import check, main


class LiteLLMCheckTests(unittest.TestCase):
    def invoke(self, model, answer, usage=None):
        response = io.BytesIO(json.dumps({
            "model": "upstream-model",
            "choices": [{"message": {"content": answer}}],
            "usage": usage,
        }).encode())
        response.headers = {"x-litellm-call-id": "test-call"}
        with patch("urllib.request.urlopen", return_value=response) as send:
            result = check("https://proxy.example.invalid/v1/", "test-key", model)
        request = send.call_args.args[0]
        self.assertEqual(request.full_url, "https://proxy.example.invalid/v1/chat/completions")
        self.assertEqual(request.get_header("Authorization"), "Bearer test-key")
        return json.loads(request.data), result

    def test_text_request_and_usage(self):
        usage = {"prompt_tokens": 10, "completion_tokens": 1, "total_tokens": 11}
        payload, result = self.invoke("odyssey-llm", "OK", usage)
        self.assertEqual(payload["model"], "odyssey-llm")
        self.assertIsInstance(payload["messages"][0]["content"], str)
        self.assertEqual(result["usage"], usage)
        self.assertEqual(result["call_id"], "test-call")

    def test_vision_request_includes_valid_red_png_for_primary_and_backup(self):
        usage = {"prompt_tokens": 100, "completion_tokens": 1, "total_tokens": 101}
        for model in ("odyssey-vlm", "odyssey-vlm-fallback"):
            with self.subTest(model=model):
                payload, _ = self.invoke(model, "Red.", usage)
                content = payload["messages"][0]["content"]
                self.assertNotIn("red", content[0]["text"].lower())
                url = content[1]["image_url"]["url"]
                self.assertTrue(url.startswith("data:image/png;base64,"))
                png = base64.b64decode(url.split(",", 1)[1], validate=True)
                self.assertEqual(png[:8], b"\x89PNG\r\n\x1a\n")
                self.assertEqual(int.from_bytes(png[16:20]), 64)
                self.assertEqual(int.from_bytes(png[20:24]), 64)
                start = png.index(b"IDAT") + 4
                length = int.from_bytes(png[start - 8:start - 4])
                self.assertEqual(zlib.decompress(png[start:start + length]),
                                 (b"\x00" + b"\xff\x00\x00" * 64) * 64)

    def test_missing_or_invalid_usage_is_not_reported_as_success(self):
        for usage in (None, {}, {"prompt_tokens": "10"}):
            with self.subTest(usage=usage), self.assertRaises(ValueError):
                self.invoke("odyssey-llm", "OK", usage)

    def test_wrong_visual_answer_is_not_reported_as_success(self):
        with self.assertRaises(ValueError):
            self.invoke("odyssey-vlm", "blue")

    def test_provider_error_exits_without_printing_response_body(self):
        error = urllib.error.HTTPError(
            "https://proxy.example.invalid/v1/chat/completions", 503,
            "private-provider-detail", {}, io.BytesIO(b"private-request-body"),
        )
        with (
            patch("sys.argv", ["check_litellm.py", "odyssey-vlm"]),
            patch.dict("os.environ", {"LITELLM_API_KEY": "test-key"}),
            patch("urllib.request.urlopen", side_effect=error),
            self.assertRaises(SystemExit) as raised,
        ):
            main()
        self.assertIn("503", str(raised.exception))
        self.assertNotIn("private", str(raised.exception))
        self.assertNotIn("test-key", str(raised.exception))
