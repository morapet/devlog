#!/bin/sh
# Cloud Run entrypoint: restore the SQLite DB from the GCS replica (fresh
# instances start with an empty /data), then run devlog under Litestream so
# every write streams back to the bucket.
set -e

# Cloud Run tells the container which port to listen on via PORT.
export DEVLOG_PORT="${PORT:-8765}"
export DEVLOG_HOST=0.0.0.0
export DEVLOG_DATA_DIR="${DEVLOG_DATA_DIR:-/data}"

if [ -z "$LITESTREAM_REPLICA_URL" ]; then
    echo "FATAL: LITESTREAM_REPLICA_URL is not set (e.g. gcs://bucket/devlog)" >&2
    exit 1
fi

mkdir -p "$DEVLOG_DATA_DIR"

litestream restore -if-replica-exists -if-db-not-exists "$DEVLOG_DATA_DIR/devlog.db"

exec litestream replicate -exec devlog
