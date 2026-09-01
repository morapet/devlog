"""Export / import of devlog data.

Two granularities share one file format (a schema-versioned JSON dump of the
relevant tables):

  * **Full** — every table, ids preserved. Used to move a whole backend to a new
    data dir (e.g. into the native app). ``GET /export`` + import mode ``replace``.
  * **Scoped** — a chosen set of projects and everything under them. Used to move
    or share individual projects between backends. ``POST /export`` with a list
    of project slugs (or none = all projects).

Scoped imports never preserve ids — they *remap* every id so the incoming data
can't collide with what's already in the target. Two non-destructive-by-default
modes:

  * ``merge`` — add the file's projects as new projects; a slug already present
    is auto-suffixed (``auth`` -> ``auth-2``). Nothing existing is deleted.
  * ``replace_projects`` — for each project in the file, delete the existing
    project with the same slug (and all its items) first, then load fresh. Other
    projects are left untouched.

Every import takes an automatic hot-backup first, so a mistaken import is always
recoverable (see also the /backups restore endpoints).
"""

from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import export_crypto
from ..backup import hot_backup
from ..db import conn, tx, utcnow

router = APIRouter(tags=["portability"])

SCHEMA_VERSION = 1

# Real, dumpable tables in dependency order (parents before children). The FTS
# virtual tables (items_fts*) are excluded — they are rebuilt by triggers when
# rows are inserted into `items`. `shares` is intentionally excluded: share
# tokens are backend-local and shouldn't travel with the data.
EXPORT_TABLES = [
    "projects",
    "items",
    "refs",
    "work_sessions",
    "item_versions",
    "attachments",
    "settings",
]

# Tables that make up a scoped (per-project) export — everything hanging off the
# selected projects. `settings` is DB-wide, not per-project, so it is omitted.
SCOPED_TABLES = ["projects", "items", "refs", "work_sessions", "item_versions", "attachments"]

# Reverse order for deletion so children go before parents. We delete `items`
# explicitly (rather than relying on FK cascade from projects) because
# recursive_triggers is off, so cascade deletes would not fire the FTS triggers
# and would leave items_fts stale.
DELETE_ORDER = [
    "item_versions",
    "work_sessions",
    "refs",
    "attachments",
    "items",
    "projects",
    "settings",
]


def _columns(c, table: str) -> list[str]:
    return [r["name"] for r in c.execute(f"PRAGMA table_info({table})").fetchall()]


def _dump_table(c, table: str, where: str = "", params: tuple = ()) -> list[dict[str, Any]]:
    order = " ORDER BY id" if "id" in _columns(c, table) else ""
    rows = c.execute(f"SELECT * FROM {table} WHERE {where or '1=1'}{order}", params).fetchall()
    return [dict(r) for r in rows]


def _in_clause(values: list[int]) -> tuple[str, tuple]:
    if not values:
        return "0", ()  # matches nothing
    marks = ",".join("?" for _ in values)
    return marks, tuple(values)


# ---------- export ----------


class ExportDoc(BaseModel):
    schema_version: int
    exported_at: str
    source: str
    partial: bool = False
    projects: list[str] | None = None
    tables: dict[str, list[dict[str, Any]]]


@router.get("/export")
def export_all() -> dict[str, Any]:
    """Full backend export (every table, ids preserved)."""
    c = conn()
    tables = {t: _dump_table(c, t) for t in EXPORT_TABLES}
    return {
        "schema_version": SCHEMA_VERSION,
        "exported_at": utcnow(),
        "source": "devlog",
        "partial": False,
        "projects": None,
        "tables": tables,
    }


class ExportRequest(BaseModel):
    # None or [] -> all projects. Slugs of the projects to export.
    projects: list[str] | None = None
    encrypt: bool = False


@router.get("/export/token")
def export_token() -> dict[str, str]:
    """Reveal the app's export token (needed to decrypt encrypted exports)."""
    return {"token": export_crypto.get_token()}


@router.post("/export")
def export_scoped(req: ExportRequest) -> dict[str, Any]:
    """Scoped export of selected projects (or all when none are given)."""
    c = conn()

    if req.projects:
        rows = c.execute(
            f"SELECT id, slug FROM projects WHERE slug IN ({','.join('?' for _ in req.projects)})",
            tuple(req.projects),
        ).fetchall()
        found = {r["slug"]: r["id"] for r in rows}
        missing = [s for s in req.projects if s not in found]
        if missing:
            raise HTTPException(404, f"unknown project slug(s): {', '.join(missing)}")
        project_ids = list(found.values())
        slugs = list(found.keys())
        partial = True
    else:
        rows = c.execute("SELECT id, slug FROM projects ORDER BY id").fetchall()
        project_ids = [r["id"] for r in rows]
        slugs = [r["slug"] for r in rows]
        partial = False

    pmarks, pparams = _in_clause(project_ids)
    item_ids = [r["id"] for r in c.execute(f"SELECT id FROM items WHERE project_id IN ({pmarks})", pparams)]
    imarks, iparams = _in_clause(item_ids)

    tables = {
        "projects": _dump_table(c, "projects", f"id IN ({pmarks})", pparams),
        "items": _dump_table(c, "items", f"project_id IN ({pmarks})", pparams),
        # Only refs fully contained in the exported item set.
        "refs": _dump_table(
            c, "refs", f"from_id IN ({imarks}) AND to_id IN ({imarks})", iparams + iparams
        ),
        "work_sessions": _dump_table(c, "work_sessions", f"item_id IN ({imarks})", iparams),
        "item_versions": _dump_table(c, "item_versions", f"item_id IN ({imarks})", iparams),
        "attachments": _dump_table(c, "attachments", f"item_id IN ({imarks})", iparams),
    }

    payload = {
        "schema_version": SCHEMA_VERSION,
        "exported_at": utcnow(),
        "source": "devlog",
        "partial": partial,
        "projects": slugs,
        "tables": tables,
    }
    if req.encrypt:
        return export_crypto.encrypt(payload, export_crypto.get_token())
    return payload


# ---------- import ----------


class ImportRequest(BaseModel):
    mode: Literal["replace", "merge", "replace_projects"]
    confirm: bool = False
    data: dict[str, Any]
    # Required only when `data` is an encrypted envelope.
    token: str | None = None


class ImportResult(BaseModel):
    ok: bool
    mode: str
    backup_path: str
    previous_counts: dict[str, int]
    imported_counts: dict[str, int]
    projects: list[str]


def _counts(c, tables: list[str]) -> dict[str, int]:
    return {t: c.execute(f"SELECT count(*) AS n FROM {t}").fetchone()["n"] for t in tables}


def _validate_doc(data: dict[str, Any]) -> dict[str, list]:
    if data.get("schema_version") != SCHEMA_VERSION:
        raise HTTPException(
            400,
            f"unsupported export schema_version {data.get('schema_version')!r}; "
            f"this backend expects {SCHEMA_VERSION}.",
        )
    src_tables = data.get("tables")
    if not isinstance(src_tables, dict):
        raise HTTPException(400, "malformed export: missing 'tables' object.")
    for t, rows in src_tables.items():
        if not isinstance(rows, list):
            raise HTTPException(400, f"malformed export: table '{t}' is not a list.")
    return src_tables


def _insert(c, table: str, row: dict, cols: set[str], overrides: dict) -> int:
    """Insert a row (id auto-assigned), applying overrides; return the new id."""
    use = {k: v for k, v in row.items() if k in cols and k != "id"}
    use.update({k: v for k, v in overrides.items() if k in cols})
    names = ", ".join(use)
    marks = ", ".join("?" for _ in use)
    cur = c.execute(f"INSERT INTO {table} ({names}) VALUES ({marks})", tuple(use.values()))
    return cur.lastrowid


@router.post("/import", response_model=ImportResult)
def import_all(req: ImportRequest) -> ImportResult:
    data = req.data
    if export_crypto.is_encrypted(data):
        if not req.token:
            raise HTTPException(400, "this export is encrypted; a token is required to import it.")
        try:
            data = export_crypto.decrypt(data, req.token)
        except export_crypto.InvalidToken as e:
            raise HTTPException(400, f"could not decrypt: {e}") from e

    if req.mode == "replace" and not req.confirm:
        raise HTTPException(
            400,
            "replace is destructive and must be confirmed: pass confirm=true.",
        )

    src_tables = _validate_doc(data)

    if req.mode == "replace":
        return _full_replace(src_tables)
    return _scoped_import(src_tables, req.mode)


def _full_replace(src_tables: dict[str, list]) -> ImportResult:
    """Whole-DB wipe-and-reload, preserving ids (used to migrate a backend)."""
    backup_path = hot_backup(tag="pre-import")
    with tx() as c:
        previous = _counts(c, EXPORT_TABLES)
        c.execute("PRAGMA defer_foreign_keys = ON")
        for t in DELETE_ORDER:
            c.execute(f"DELETE FROM {t}")

        imported: dict[str, int] = {}
        for t in EXPORT_TABLES:
            rows = src_tables.get(t, [])
            cols = set(_columns(c, t))
            n = 0
            for row in rows:
                use = [(k, v) for k, v in row.items() if k in cols]
                if not use:
                    continue
                names = ", ".join(k for k, _ in use)
                marks = ", ".join("?" for _ in use)
                c.execute(f"INSERT INTO {t} ({names}) VALUES ({marks})", tuple(v for _, v in use))
                n += 1
            imported[t] = n
    return ImportResult(
        ok=True, mode="replace", backup_path=str(backup_path),
        previous_counts=previous, imported_counts=imported, projects=[],
    )


def _free_slug(c, slug: str) -> str:
    """A slug not currently taken, suffixing -2, -3, … on collision."""
    if not c.execute("SELECT 1 FROM projects WHERE slug = ?", (slug,)).fetchone():
        return slug
    n = 2
    while c.execute("SELECT 1 FROM projects WHERE slug = ?", (f"{slug}-{n}",)).fetchone():
        n += 1
    return f"{slug}-{n}"


def _delete_project_by_slug(c, slug: str) -> None:
    row = c.execute("SELECT id FROM projects WHERE slug = ?", (slug,)).fetchone()
    if not row:
        return
    pid = row["id"]
    # Delete items explicitly so the FTS delete triggers fire, then the project.
    item_ids = [r["id"] for r in c.execute("SELECT id FROM items WHERE project_id = ?", (pid,))]
    for iid in item_ids:
        c.execute("DELETE FROM items WHERE id = ?", (iid,))
    c.execute("DELETE FROM projects WHERE id = ?", (pid,))


def _scoped_import(src_tables: dict[str, list], mode: str) -> ImportResult:
    """Merge / replace-by-project, remapping every id to avoid collisions."""
    backup_path = hot_backup(tag="pre-import")
    src_projects = src_tables.get("projects", [])

    with tx() as c:
        previous = _counts(c, SCOPED_TABLES)
        c.execute("PRAGMA defer_foreign_keys = ON")

        if mode == "replace_projects":
            for p in src_projects:
                if p.get("slug"):
                    _delete_project_by_slug(c, p["slug"])

        pcols = set(_columns(c, "projects"))
        icols = set(_columns(c, "items"))

        # --- projects (parent_id resolved in a second pass) ---
        proj_map: dict[int, int] = {}
        result_slugs: list[str] = []
        for p in src_projects:
            old_id = p.get("id")
            slug = _free_slug(c, p.get("slug") or f"project-{old_id}")
            new_id = _insert(c, "projects", p, pcols, {"slug": slug, "parent_id": None})
            if old_id is not None:
                proj_map[old_id] = new_id
            result_slugs.append(slug)
        # Re-link parents that were part of the same import; others stay roots.
        for p in src_projects:
            old_id, old_parent = p.get("id"), p.get("parent_id")
            if old_id in proj_map and old_parent in proj_map:
                c.execute(
                    "UPDATE projects SET parent_id = ? WHERE id = ?",
                    (proj_map[old_parent], proj_map[old_id]),
                )

        # --- items ---
        item_map: dict[int, int] = {}
        for it in src_tables.get("items", []):
            old_pid = it.get("project_id")
            if old_pid not in proj_map:
                continue  # orphan — its project wasn't imported
            overrides = {"project_id": proj_map[old_pid]}
            # 'doing' is live, single-per-backend state; don't import it as active.
            if it.get("status") == "doing":
                overrides["status"] = "today"
                overrides["doing_started_at"] = None
            new_id = _insert(c, "items", it, icols, overrides)
            if it.get("id") is not None:
                item_map[it["id"]] = new_id

        # --- refs (only when both endpoints were imported) ---
        n_refs = 0
        for r in src_tables.get("refs", []):
            f, t = item_map.get(r.get("from_id")), item_map.get(r.get("to_id"))
            if f is None or t is None:
                continue
            c.execute("INSERT OR IGNORE INTO refs (from_id, to_id) VALUES (?, ?)", (f, t))
            n_refs += 1

        # --- child tables keyed by item_id ---
        ws_cols = set(_columns(c, "work_sessions"))
        n_ws = 0
        for s in src_tables.get("work_sessions", []):
            new_item = item_map.get(s.get("item_id"))
            if new_item is None:
                continue
            overrides = {"item_id": new_item}
            # Close any imported open session — an active session belongs to the
            # live 'doing' task, which we don't import as active.
            if s.get("ended_at") is None:
                overrides["ended_at"] = s.get("started_at")
            _insert(c, "work_sessions", s, ws_cols, overrides)
            n_ws += 1

        iv_cols = set(_columns(c, "item_versions"))
        n_iv = 0
        for v in src_tables.get("item_versions", []):
            new_item = item_map.get(v.get("item_id"))
            if new_item is None:
                continue
            _insert(c, "item_versions", v, iv_cols, {"item_id": new_item})
            n_iv += 1

        at_cols = set(_columns(c, "attachments"))
        n_at = 0
        for a in src_tables.get("attachments", []):
            new_item = item_map.get(a.get("item_id"))
            if new_item is None:
                continue
            _insert(c, "attachments", a, at_cols, {"item_id": new_item})
            n_at += 1

        imported = {
            "projects": len(proj_map),
            "items": len(item_map),
            "refs": n_refs,
            "work_sessions": n_ws,
            "item_versions": n_iv,
            "attachments": n_at,
        }

    return ImportResult(
        ok=True, mode=mode, backup_path=str(backup_path),
        previous_counts=previous, imported_counts=imported, projects=result_slugs,
    )
