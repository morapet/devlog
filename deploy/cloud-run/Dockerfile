# devlog on Cloud Run: the stock image + Litestream for SQLite persistence.
# Cloud Run instances have an ephemeral filesystem, so Litestream streams
# every write to a GCS bucket and restores the DB on container start.
# Overridable so CI can layer onto a locally built base instead of GHCR.
ARG BASE_IMAGE=ghcr.io/morapet/devlog:latest
FROM ${BASE_IMAGE}

COPY --from=litestream/litestream:0.3 /usr/local/bin/litestream /usr/local/bin/litestream
COPY litestream.yml /etc/litestream.yml
COPY entrypoint.sh /entrypoint.sh

CMD ["/bin/sh", "/entrypoint.sh"]
