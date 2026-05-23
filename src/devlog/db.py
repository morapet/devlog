import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone

from .config import data_dir, db_path

SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
    id          INTEGER PRIMARY KEY,
    slug        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    description TEXT,
    color       TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
    id                 INTEGER PRIMARY KEY,
    kind               TEXT NOT NULL CHECK (kind IN ('task','note','link')),
    project_id         INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title              TEXT,
    body               TEXT,
    tags               TEXT NOT NULL DEFAULT '[]',
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    -- task fields
    status             TEXT CHECK (status IN ('todo','today','doing','blocked','someday','done','cancelled')),
    due_at             TEXT,
    priority           TEXT CHECK (priority IN ('low','normal','high')),
    blocked_reason     TEXT,
    done_at            TEXT,
    doing_started_at   TEXT,
    -- link fields
    url                TEXT,
    link_description   TEXT,
    favicon_url        TEXT,
    is_read            INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_items_project_kind ON items(project_id, kind);
CREATE INDEX IF NOT EXISTS idx_items_kind_status  ON items(kind, status);
CREATE INDEX IF NOT EXISTS idx_items_updated      ON items(updated_at DESC);

-- backlinks: (from_id) references (to_id)
CREATE TABLE IF NOT EXISTS refs (
    from_id  INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    to_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    PRIMARY KEY (from_id, to_id)
);
CREATE INDEX IF NOT EXISTS idx_refs_to ON refs(to_id);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS work_sessions (
    id          INTEGER PRIMARY KEY,
    item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    started_at  TEXT NOT NULL,
    ended_at    TEXT
);

CREATE TABLE IF NOT EXISTS item_versions (
    id        INTEGER PRIMARY KEY,
    item_id   INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    title     TEXT,
    body      TEXT,
    saved_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_versions_item ON item_versions(item_id, saved_at DESC);

CREATE TABLE IF NOT EXISTS attachments (
    id          INTEGER PRIMARY KEY,
    item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL DEFAULT 'drawing',
    title       TEXT,
    data_xml    TEXT,
    data_svg    TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_item ON attachments(item_id);
CREATE INDEX IF NOT EXISTS idx_sessions_item    ON work_sessions(item_id);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON work_sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_open    ON work_sessions(item_id) WHERE ended_at IS NULL;

-- FTS5 over items (also indexes tags as a space-joined column)
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
    title, body, url, link_description, tags,
    content='items', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
    INSERT INTO items_fts(rowid, title, body, url, link_description, tags)
    VALUES (new.id, coalesce(new.title,''), coalesce(new.body,''), coalesce(new.url,''), coalesce(new.link_description,''),
            (SELECT coalesce(group_concat(value, ' '), '') FROM json_each(new.tags)));
END;
CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
    INSERT INTO items_fts(items_fts, rowid, title, body, url, link_description, tags)
    VALUES('delete', old.id, coalesce(old.title,''), coalesce(old.body,''), coalesce(old.url,''), coalesce(old.link_description,''),
           (SELECT coalesce(group_concat(value, ' '), '') FROM json_each(old.tags)));
END;
CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN
    INSERT INTO items_fts(items_fts, rowid, title, body, url, link_description, tags)
    VALUES('delete', old.id, coalesce(old.title,''), coalesce(old.body,''), coalesce(old.url,''), coalesce(old.link_description,''),
           (SELECT coalesce(group_concat(value, ' '), '') FROM json_each(old.tags)));
    INSERT INTO items_fts(rowid, title, body, url, link_description, tags)
    VALUES (new.id, coalesce(new.title,''), coalesce(new.body,''), coalesce(new.url,''), coalesce(new.link_description,''),
            (SELECT coalesce(group_concat(value, ' '), '') FROM json_each(new.tags)));
END;
"""


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _connect() -> sqlite3.Connection:
    data_dir().mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(
        db_path(),
        isolation_level=None,  # autocommit; we use explicit BEGIN
        check_same_thread=False,
        timeout=10.0,
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    return conn


_local = threading.local()
_init_lock = threading.Lock()
_write_lock = threading.RLock()
_schema_ready = False


def _ensure_schema(c: sqlite3.Connection) -> None:
    global _schema_ready
    with _init_lock:
        if _schema_ready:
            return
        c.executescript(SCHEMA)
        _migrate(c)
        _schema_ready = True


def conn() -> sqlite3.Connection:
    c = getattr(_local, "conn", None)
    if c is None:
        c = _connect()
        _local.conn = c
        _ensure_schema(c)
    return c


def _migrate(c: sqlite3.Connection) -> None:
    cols = {r["name"] for r in c.execute("PRAGMA table_info(items)").fetchall()}
    if "is_pinned" not in cols:
        c.execute("ALTER TABLE items ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0")
        c.execute("CREATE INDEX IF NOT EXISTS idx_items_pinned ON items(is_pinned) WHERE is_pinned = 1")

    # Rebuild items_fts if it doesn't include the 'tags' column.
    fts_cols: set[str] = set()
    try:
        fts_cols = {r["name"] for r in c.execute("PRAGMA table_info(items_fts)").fetchall()}
    except sqlite3.OperationalError:
        fts_cols = set()
    if "tags" not in fts_cols:
        c.executescript(
            """
            DROP TRIGGER IF EXISTS items_ai;
            DROP TRIGGER IF EXISTS items_ad;
            DROP TRIGGER IF EXISTS items_au;
            DROP TABLE IF EXISTS items_fts;
            CREATE VIRTUAL TABLE items_fts USING fts5(
                title, body, url, link_description, tags,
                content='items', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
            );
            CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN
                INSERT INTO items_fts(rowid, title, body, url, link_description, tags)
                VALUES (new.id, coalesce(new.title,''), coalesce(new.body,''), coalesce(new.url,''), coalesce(new.link_description,''),
                        (SELECT coalesce(group_concat(value, ' '), '') FROM json_each(new.tags)));
            END;
            CREATE TRIGGER items_ad AFTER DELETE ON items BEGIN
                INSERT INTO items_fts(items_fts, rowid, title, body, url, link_description, tags)
                VALUES('delete', old.id, coalesce(old.title,''), coalesce(old.body,''), coalesce(old.url,''), coalesce(old.link_description,''),
                       (SELECT coalesce(group_concat(value, ' '), '') FROM json_each(old.tags)));
            END;
            CREATE TRIGGER items_au AFTER UPDATE ON items BEGIN
                INSERT INTO items_fts(items_fts, rowid, title, body, url, link_description, tags)
                VALUES('delete', old.id, coalesce(old.title,''), coalesce(old.body,''), coalesce(old.url,''), coalesce(old.link_description,''),
                       (SELECT coalesce(group_concat(value, ' '), '') FROM json_each(old.tags)));
                INSERT INTO items_fts(rowid, title, body, url, link_description, tags)
                VALUES (new.id, coalesce(new.title,''), coalesce(new.body,''), coalesce(new.url,''), coalesce(new.link_description,''),
                        (SELECT coalesce(group_concat(value, ' '), '') FROM json_each(new.tags)));
            END;
            """
        )
        # Backfill rows.
        c.execute(
            """
            INSERT INTO items_fts(rowid, title, body, url, link_description, tags)
            SELECT id, coalesce(title,''), coalesce(body,''), coalesce(url,''), coalesce(link_description,''),
                   (SELECT coalesce(group_concat(value, ' '), '') FROM json_each(items.tags))
            FROM items
            """
        )


@contextmanager
def tx():
    c = conn()
    with _write_lock:
        c.execute("BEGIN IMMEDIATE")
        try:
            yield c
            c.execute("COMMIT")
        except Exception:
            c.execute("ROLLBACK")
            raise
