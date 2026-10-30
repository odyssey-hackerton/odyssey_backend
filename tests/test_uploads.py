from app.services.uploads import JPEG, PNG, WEBP, detect_image_type


def test_detects_supported_images():
    assert detect_image_type(b"\xff\xd8\xff\xe0" + b"\0" * 12) == JPEG
    assert detect_image_type(b"\x89PNG\r\n\x1a\n" + b"\0" * 8) == PNG
    assert detect_image_type(b"RIFF\0\0\0\0WEBPVP8 ") == WEBP


def test_rejects_other_files():
    assert detect_image_type(b"%PDF-1.7\n") is None
    assert detect_image_type(b"GIF89a") is None
    assert detect_image_type(b"") is None
