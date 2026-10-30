"""업로드 파일 검증. 확장자나 Content-Type은 믿지 않고 파일 앞부분(매직 바이트)으로 판별한다."""

from dataclasses import dataclass


@dataclass(frozen=True)
class ImageType:
    ext: str
    content_type: str


JPEG = ImageType("jpg", "image/jpeg")
PNG = ImageType("png", "image/png")
WEBP = ImageType("webp", "image/webp")


def detect_image_type(head: bytes) -> ImageType | None:
    if head.startswith(b"\xff\xd8\xff"):
        return JPEG
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return PNG
    if len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return WEBP
    return None
