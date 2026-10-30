FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_PYTHON_DOWNLOADS=never \
    PATH="/opt/venv/bin:$PATH"

RUN pip install --no-cache-dir uv==0.11.32

WORKDIR /srv

# 의존성 레이어를 먼저 만들어 코드만 바뀌면 빠르게 다시 빌드되게 한다.
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --frozen --no-dev

COPY . .
RUN chmod +x docker/entrypoint.sh \
    && useradd --create-home --uid 1000 app \
    && chown -R app /srv
USER app

EXPOSE 8000
ENTRYPOINT ["/srv/docker/entrypoint.sh"]
CMD ["api"]
