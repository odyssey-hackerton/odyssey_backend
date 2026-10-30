import logging


def setup_logging(level: str) -> None:
    # 이미지·텍스트 원문, presigned URL은 절대 로그에 남기지 않는다.
    logging.basicConfig(
        level=level.upper(),
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )
