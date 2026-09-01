"""Hot backup of the SQLite database via the online backup API.

Safe to run while the server is writing (WAL is included). Mirrors what
scripts/backup-db.sh does, but callable in-process so the import endpoint can
snapshot the DB *before* a destructive operation.
"""

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from .config import data_dir, db_path

# Filenames written by hot_backup(): devlog-YYYYMMDD-HHMMSS[-tag].db
_TS_FMT = "%Y%m%d-%H%M%S"


def backups_dir() -> Path:
    return data_dir() / "backups"


def hot_backup(tag: str = "") -> Path:
    """Write a consistent copy of the DB into <data_dir>/backups/ and return it.

    `tag` is inserted into the filename (sanitized) to record why the backup was
    taken, e.g. "pre-import".
    """
    d = backups_dir()
    d.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    safe = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in tag).strip("-")
    name = f"devlog-{ts}-{safe}.db" if safe else f"devlog-{ts}.db"
    dest = d / name

    src = sqlite3.connect(db_path())
    try:
        out = sqlite3.connect(dest)
        try:
            src.backup(out)
        finally:
            out.close()
    finally:
        src.close()
    return dest


def _parse_meta(name: str) -> tuple[str | None, str]:
    """(created_at ISO or None, tag) parsed from a backup filename."""
    stem = name[:-3] if name.endswith(".db") else name
    parts = stem.split("-")  # ["devlog", "YYYYMMDD", "HHMMSS", *tag]
    created_at = None
    if len(parts) >= 3:
        try:
            dt = datetime.strptime(f"{parts[1]}-{parts[2]}", _TS_FMT).replace(tzinfo=timezone.utc)
            created_at = dt.isoformat(timespec="seconds")
        except ValueError:
            created_at = None
    tag = "-".join(parts[3:]) if len(parts) > 3 else ""
    return created_at, tag


def list_backups() -> list[dict]:
    """Backups in <data_dir>/backups/, newest first."""
    d = backups_dir()
    if not d.exists():
        return []
    out = []
    for p in d.glob("devlog-*.db"):
        try:
            size = p.stat().st_size
        except OSError:
            continue
        created_at, tag = _parse_meta(p.name)
        out.append({"name": p.name, "created_at": created_at, "tag": tag, "size": size})
    out.sort(key=lambda b: b["name"], reverse=True)
    return out


def resolve_backup(name: str) -> Path:
    """Resolve a backup filename to a path inside backups_dir, or raise ValueError.

    Guards against path traversal: only a bare filename that actually lives in
    the backups directory is accepted.
    """
    if not name or "/" in name or "\\" in name or name in (".", ".."):
        raise ValueError("invalid backup name")
    d = backups_dir().resolve()
    p = (d / name).resolve()
    if p.parent != d or not p.is_file():
        raise ValueError("backup not found")
    return p


def restore_backup(name: str) -> Path:
    """Replace the live DB with the named backup, returning a pre-restore backup.

    A safety hot-backup is taken first so a mistaken restore is recoverable. The
    restore copies the chosen file's contents *into* the live connection (via the
    SQLite online-backup API), which replaces schema and data atomically without
    swapping files underneath open WAL connections.
    """
    from .db import conn, ensure_schema_current, write_lock

    src_path = resolve_backup(name)
    safety = hot_backup(tag="pre-restore")

    with write_lock():
        src = sqlite3.connect(src_path)
        try:
            src.backup(conn())  # overwrites the destination database entirely
        finally:
            src.close()
        # An older backup may predate a migration; bring it up to date.
        ensure_schema_current()
    return safety
