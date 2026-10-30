import asyncio
import logging

import boto3
from botocore.client import BaseClient
from botocore.config import Config
from botocore.exceptions import ClientError

from app.core.config import Settings

logger = logging.getLogger(__name__)

ORIGINALS_PREFIX = "originals/"
RESULTS_PREFIX = "results/"


def original_key(job_id: str, ext: str) -> str:
    return f"{ORIGINALS_PREFIX}{job_id}.{ext}"


def result_key(job_id: str, ext: str) -> str:
    return f"{RESULTS_PREFIX}{job_id}.{ext}"


class Storage:
    """AWS S3 래퍼. boto3는 동기 라이브러리라 네트워크 호출은 스레드에서 실행한다.

    버킷은 AWS 콘솔에서 미리 만든다 (README의 "AWS 준비").
    """

    def __init__(self, settings: Settings) -> None:
        self.bucket = settings.s3_bucket
        self._client: BaseClient = boto3.client(
            "s3",
            region_name=settings.s3_region,
            aws_access_key_id=settings.aws_access_key_id,
            aws_secret_access_key=settings.aws_secret_access_key,
            config=Config(
                signature_version="s3v4", retries={"max_attempts": 3, "mode": "standard"}
            ),
        )

    async def put(self, key: str, data: bytes, content_type: str) -> None:
        await asyncio.to_thread(
            self._client.put_object,
            Bucket=self.bucket,
            Key=key,
            Body=data,
            ContentType=content_type,
        )

    async def get(self, key: str) -> bytes:
        def _get() -> bytes:
            obj = self._client.get_object(Bucket=self.bucket, Key=key)
            return obj["Body"].read()

        return await asyncio.to_thread(_get)

    def presign_get(self, key: str, expires_seconds: int) -> str:
        # 서명은 로컬 계산이라 네트워크 호출이 없다.
        return self._client.generate_presigned_url(
            "get_object",
            Params={"Bucket": self.bucket, "Key": key},
            ExpiresIn=expires_seconds,
        )

    async def ping(self) -> bool:
        try:
            await asyncio.to_thread(self._client.head_bucket, Bucket=self.bucket)
            return True
        except ClientError:
            return False
