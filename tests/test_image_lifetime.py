import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import boto3
import pytest
from moto import mock_aws

from app.core.config import Settings
from app.queue.consumer import save_result
from app.schemas.contract import ResultMessage
from app.storage.s3 import Storage

AI_ROOT = Path(__file__).resolve().parents[2] / "odyssey_ai"
HAS_AI_REPO = AI_ROOT.is_dir()


@pytest.mark.parametrize("versioned", [False, True])
@pytest.mark.parametrize("implementation", ["api", "worker"])
async def test_delete_removes_all_exact_key_versions_but_preserves_other_objects(
    versioned, implementation, monkeypatch
):
    storage_type = Storage
    if implementation == "worker":
        if not HAS_AI_REPO:
            pytest.skip("AI 스토리지 비교에는 AI 레포 체크아웃이 필요하다")
        monkeypatch.syspath_prepend(str(AI_ROOT))
        from worker.storage import Storage as WorkerStorage

        storage_type = WorkerStorage
    with mock_aws():
        settings = Settings(
            s3_bucket="test-images",
            s3_region="us-east-1",
            aws_access_key_id="test",
            aws_secret_access_key="test",
        )
        client = boto3.client("s3", region_name="us-east-1")
        client.create_bucket(Bucket=settings.s3_bucket)
        if versioned:
            client.put_bucket_versioning(
                Bucket=settings.s3_bucket, VersioningConfiguration={"Status": "Enabled"}
            )
        storage = storage_type(settings)
        await storage.put("originals/x", b"first", "image/png")
        await storage.put("originals/x", b"second", "image/png")
        await storage.put("originals/xy", b"unrelated", "image/png")
        client.delete_object(Bucket=settings.s3_bucket, Key="originals/x")
        await storage.delete("originals/x")
        await storage.delete("originals/x")
        versions = client.list_object_versions(Bucket=settings.s3_bucket)
        assert all(v["Key"] != "originals/x" for v in versions.get("Versions", []))
        assert all(v["Key"] != "originals/x" for v in versions.get("DeleteMarkers", []))
        assert await storage.get("originals/xy") == b"unrelated"
        with pytest.raises(ValueError):
            await storage.delete("results/x")


@pytest.mark.parametrize("same_execution,status", [(False, "QUEUED"), (True, "DONE")])
async def test_stale_or_duplicate_result_cannot_overwrite_current_job(same_execution, status):
    execution = uuid.uuid4()
    job = SimpleNamespace(execution_id=execution, status=status)
    session = AsyncMock()
    session.execute.return_value = MagicMock(scalar_one_or_none=MagicMock(return_value=job))
    factory = MagicMock(
        return_value=MagicMock(
            __aenter__=AsyncMock(return_value=session),
            __aexit__=AsyncMock(return_value=False),
        )
    )
    redis = AsyncMock()
    message = ResultMessage(
        job_id=uuid.uuid4(),
        execution_id=execution if same_execution else uuid.uuid4(),
        status="FAILED",
    )
    await save_result(factory, redis, Settings(), message)
    session.commit.assert_not_called()
    assert session.execute.await_count == 1
    assert job.status == status
