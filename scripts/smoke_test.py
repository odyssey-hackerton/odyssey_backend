"""배포 후 전체 흐름 확인용 스모크 테스트.

업로드 → SSE 진행 상황 → 결과 URL → 리포트까지 확인한다. 워커(Mock 또는 실제 AI)가 떠 있어야 한다.

    uv run python scripts/smoke_test.py http://localhost        # Nginx 경유
    uv run python scripts/smoke_test.py http://localhost:8000   # API 직접
"""

import io
import json
import sys

import httpx
from PIL import Image


def make_image() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (320, 240), (90, 140, 200)).save(buf, format="JPEG")
    return buf.getvalue()


def main(base: str) -> int:
    with httpx.Client(base_url=base, timeout=30) as client:
        print("health:", client.get("/api/health").json())

        r = client.post("/api/jobs", files={"file": ("test.jpg", make_image(), "image/jpeg")})
        r.raise_for_status()
        job_id = r.json()["job_id"]
        print("job:", job_id)

        final = None
        with client.stream("GET", f"/api/jobs/{job_id}/events", timeout=120) as s:
            event = None
            for line in s.iter_lines():
                if line.startswith("event:"):
                    event = line.split(":", 1)[1].strip()
                elif line.startswith("data:") and event in ("progress", "done"):
                    data = json.loads(line.split(":", 1)[1])
                    print(f"  {event}: {data['status']}")
                    if event == "done":
                        final = data["status"]
                        break
        if final != "DONE":
            print("FAILED: final status", final)
            return 1

        result = client.get(f"/api/jobs/{job_id}/result").json()
        img = httpx.get(result["url"], timeout=30)
        print("result image:", img.status_code, img.headers.get("content-type"), len(img.content))
        print("report:", client.get(f"/api/jobs/{job_id}/report").json())
        return 0 if img.status_code == 200 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "http://localhost"))
