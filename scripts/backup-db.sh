#!/usr/bin/env bash
# Make a consistent backup of the devlog SQLite database.
#
# Uses sqlite3 .backup which is safe to run while the server is writing — it
# does a hot copy via SQLite's online backup API (WAL is included automatically).
# Backups land in $DEVLOG_DATA_DIR/backups/devlog-YYYYMMDD-HHMMSS.db.
#
# Honors DEVLOG_DATA_DIR; defaults to ~/.local/share/devlog.
#
# Optional flags:
#   --keep N    Keep only the most recent N backups; delete older ones.
#               Default: keep all.
set -euo pipefail

KEEP=""
while [ $# -gt 0 ]; do
    case "$1" in
        --keep) KEEP="$2"; shift 2 ;;
        -h|--help)
            grep '^#' "$0" | sed 's/^# //;s/^#//'
            exit 0 ;;
        *) echo "unknown arg: $1" >&2; exit 1 ;;
    esac
done

DB_DIR="${DEVLOG_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/devlog}"
DB="$DB_DIR/devlog.db"
BACKUP_DIR="$DB_DIR/backups"

if [ ! -f "$DB" ]; then
    echo "no database at $DB" >&2
    exit 1
fi

mkdir -p "$BACKUP_DIR"
TS="$(date +%Y%m%d-%H%M%S)"
DEST="$BACKUP_DIR/devlog-$TS.db"

sqlite3 "$DB" ".backup '$DEST'"

SIZE="$(du -h "$DEST" | cut -f1)"
echo "backup written: $DEST ($SIZE)"

if [ -n "$KEEP" ]; then
    # ls -t orders newest first; tail -n +N+1 picks the (N+1)th onward.
    OLD=$(ls -t "$BACKUP_DIR"/devlog-*.db 2>/dev/null | tail -n +"$((KEEP + 1))" || true)
    if [ -n "$OLD" ]; then
        echo "pruning older backups (keeping $KEEP):"
        printf '  %s\n' $OLD
        rm -f $OLD
    fi
fi
