"""업로드 파일 검증. 확장자나 Content-Type은 믿지 않고 파일 앞부분(매직 바이트)으로 판별한다."""

import warnings
from dataclasses import dataclass
from io import BytesIO

from PIL import Image, ImageOps


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


def image_size(data: bytes) -> tuple[int, int] | None:
    """EXIF 회전을 반영한 픽셀 크기. 워커·프론트가 쓰는 좌표계와 같다. 못 읽으면 None."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(data)) as image:
                return ImageOps.exif_transpose(image).size
    except Exception:
        return None
