FROM python:3.13-slim AS base

# uv is pulled from its official static-binary image; this is the recommended path.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

# Curl + ca-certificates are needed by scripts/install-drawio.sh.
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates tar \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first so they're cached when only source changes.
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --frozen --no-dev

# App source.
COPY src/ ./src/
COPY scripts/ ./scripts/

# Optional: pre-install the drawio webapp at build time. Disable with --build-arg INSTALL_DRAWIO=0.
ARG INSTALL_DRAWIO=1
RUN if [ "$INSTALL_DRAWIO" = "1" ]; then \
        bash scripts/install-drawio.sh ; \
    fi

# Re-install the package itself so console scripts work.
RUN uv sync --frozen --no-dev

ENV DEVLOG_HOST=0.0.0.0 \
    DEVLOG_PORT=8765 \
    DEVLOG_DATA_DIR=/data

EXPOSE 8765
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
    CMD curl -sf http://localhost:8765/health || exit 1

CMD ["uv", "run", "--no-dev", "devlog"]
