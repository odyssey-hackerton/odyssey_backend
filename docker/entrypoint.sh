#!/usr/bin/env sh
set -e

case "$1" in
  api)
    # 시작할 때마다 DB 스키마를 최신으로 맞춘다 (이미 최신이면 아무 일도 하지 않음).
    alembic upgrade head
    exec uvicorn app.main:app --host 0.0.0.0 --port 8000 \
      --proxy-headers --forwarded-allow-ips="*" --workers "${API_WORKERS:-1}"
    ;;
  mock-worker)
    exec python -m mock_worker.main
    ;;
  *)
    exec "$@"
    ;;
esac
