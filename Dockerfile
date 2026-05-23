FROM python:3.13-slim AS base

# uv is pulled from its official static-binary image; this is the recommended path.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

# Tell uv to use the system Python that came with the base image instead of
# trying to fetch whatever's pinned in .python-version (which targets 3.14).
ENV UV_PYTHON_PREFERENCE=only-system \
    UV_PYTHON=/usr/local/bin/python \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    UV_LINK_MODE=copy

# Curl + ca-certificates are needed by scripts/install-drawio.sh.
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates tar \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first so they're cached when only source changes.
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --frozen --no-dev --python /usr/local/bin/python

# App source.
COPY src/ ./src/
COPY scripts/ ./scripts/

# Optional: pre-install the drawio webapp at build time. Disable with --build-arg INSTALL_DRAWIO=0.
ARG INSTALL_DRAWIO=1
RUN if [ "$INSTALL_DRAWIO" = "1" ]; then \
        bash scripts/install-drawio.sh ; \
    fi

# Re-sync so the project itself is installed and console scripts work.
RUN uv sync --frozen --no-dev --python /usr/local/bin/python

ENV DEVLOG_HOST=0.0.0.0 \
    DEVLOG_PORT=8765 \
    DEVLOG_DATA_DIR=/data \
    PATH="/app/.venv/bin:$PATH"

EXPOSE 8765
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
    CMD curl -sf http://localhost:8765/health || exit 1

CMD ["devlog"]
