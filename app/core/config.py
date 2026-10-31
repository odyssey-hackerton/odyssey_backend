from functools import lru_cache

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """환경변수(.env)로 주입되는 설정. 이름은 대소문자 구분 없이 매칭된다."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_env: str = "local"
    log_level: str = "INFO"

    database_url: str = "postgresql+asyncpg://odyssey:odyssey@localhost:5432/odyssey"
    redis_url: str = "redis://localhost:6379/0"

    # AWS S3
    s3_bucket: str = "odyssey-hackarton-images"
    s3_region: str = "ap-northeast-2"
    aws_access_key_id: str | None = None
    aws_secret_access_key: str | None = None
    presign_expires_seconds: int = 300

    # 업로드 제한
    max_upload_bytes: int = 10 * 1024 * 1024
    max_text_chars: int = 5000

    # 서버 전용 이미지 생성. 키가 없으면 편집 UI의 생성 버튼을 비활성화한다.
    gemini_api_key: SecretStr | None = None
    gemini_image_model: str = Field(default="gemini-nano-banana-2.1", pattern=r"^[a-zA-Z0-9._-]+$")

    # 큐 (API-워커 계약 v1)
    jobs_stream: str = "jobs"
    results_stream: str = "results"
    results_group: str = "api"
    stream_maxlen: int = 10000
    progress_ttl_seconds: int = 24 * 3600
    max_iterations: int = Field(default=3, ge=1, le=3)

    # 프론트 개발 서버 등 다른 출처에서 호출할 때만 (예: ["http://localhost:5173"])
    cors_origins: list[str] = []


@lru_cache
def get_settings() -> Settings:
    return Settings()
