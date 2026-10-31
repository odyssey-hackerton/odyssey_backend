"""LLM/VLM 연결 점검. 실제 요청 1회 발생; VLM은 개인정보 없는 빨간 정사각형 사용."""

import argparse
import getpass
import json
import os
import urllib.error
import urllib.request

# 64×64 RGB PNG. 질문에는 색을 적지 않아 이미지 인식 결과를 확인한다.
RED_SQUARE = (
    "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnAB"
    "dLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjx"
    "BQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC"
)


def check(base_url: str, key: str, model: str) -> dict:
    vision = model in ("odyssey-vlm", "odyssey-vlm-fallback")
    content = "Reply with exactly OK."
    if vision:
        content = [
            {"type": "text", "text": "What color is this square? Reply with one English word."},
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{RED_SQUARE}"}},
        ]
    request = urllib.request.Request(
        base_url.rstrip("/") + "/chat/completions",
        data=json.dumps({
            "model": model,
            "messages": [{"role": "user", "content": content}],
            "max_tokens": 1024,
        }).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    # 기본 모델과 폴백이 각각 90초 걸리는 경우에도 결과를 받는다.
    with urllib.request.urlopen(request, timeout=210) as response:
        result = json.load(response)
        call_id = response.headers.get("x-litellm-call-id")
    answer = result["choices"][0]["message"]["content"]
    expected = "red" if vision else "ok"
    if not isinstance(answer, str) or answer.strip().rstrip(".! ").lower() != expected:
        raise ValueError("기대한 답을 받지 못했습니다. 모델 출력과 토큰 제한을 확인하세요.")
    usage = result.get("usage")
    if not isinstance(usage, dict) or any(
        type(usage.get(name)) is not int or usage[name] < 0
        for name in ("prompt_tokens", "completion_tokens", "total_tokens")
    ):
        raise ValueError("공급자가 유효한 토큰 사용량을 반환하지 않았습니다.")
    return {
        "requested_model": model,
        "model": result.get("model"),
        "call_id": call_id,
        "usage": usage,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model", choices=(
        "odyssey-llm", "odyssey-vlm", "odyssey-llm-fallback", "odyssey-vlm-fallback",
    ))
    args = parser.parse_args()
    base_url = os.environ.get("LITELLM_BASE_URL", "http://127.0.0.1:4000/v1")
    key = os.environ.get("LITELLM_API_KEY") or getpass.getpass("워커 Virtual Key: ")
    try:
        print(json.dumps(check(base_url, key, args.model), ensure_ascii=False))
    except urllib.error.HTTPError as error:
        raise SystemExit(f"HTTP {error.code}: 관리자 UI에서 요청 로그를 확인하세요.") from None
    except urllib.error.URLError:
        raise SystemExit("연결 실패: LiteLLM 주소와 서버 상태를 확인하세요.") from None
    except (ValueError, KeyError, IndexError, TypeError, TimeoutError):
        raise SystemExit("점검 실패: 응답 형식·정답·usage 또는 시간 초과를 확인하세요.") from None


if __name__ == "__main__":
    main()
