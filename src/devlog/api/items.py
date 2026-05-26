"""Item endpoints (tasks, notes, links)."""
import json
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from ..db import conn, tx, utcnow
from ..link_fetcher import fetch as fetch_link
from ..models import (
    Item,
    LinkCreate,
    LinkUpdate,
    NoteCreate,
    NoteUpdate,
    TaskCreate,
    TaskUpdate,
)
from ..refs import rebuild_refs
from ..store import get_item, row_to_item

router = APIRouter(tags=["items"])


class Version(BaseModel):
    id: int
    item_id: int
    title: Optional[str]
    body: Optional[str]
    saved_at: str


def _snapshot(c, item_id: int, title: Optional[str], body: Optional[str], when: str) -> None:
    c.execute(
        "INSERT INTO item_versions(item_id, title, body, saved_at) VALUES (?, ?, ?, ?)",
        (item_id, title, body, when),
    )


def _assert_project(c, project_id: int) -> None:
    if not c.execute("SELECT 1 FROM projects WHERE id = ?", (project_id,)).fetchone():
        raise HTTPException(404, "project not found")


# ---------- Tasks ----------
@router.post("/tasks", response_model=Item, status_code=201)
def create_task(t: TaskCreate) -> Item:
    now = utcnow()
    with tx() as c:
        _assert_project(c, t.project_id)
        if t.status == "doing":
            _clear_doing(c, now)
        cur = c.execute(
            """INSERT INTO items(kind, project_id, title, body, tags, created_at, updated_at,
                                 status, due_at, priority, doing_started_at)
               VALUES('task', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                t.project_id, t.title, t.body, json.dumps(t.tags), now, now,
                t.status, t.due_at, t.priority,
                now if t.status == "doing" else None,
            ),
        )
        item_id = cur.lastrowid
        if t.status == "doing":
            _open_session(c, item_id, now)
        rebuild_refs(c, item_id, t.project_id, t.title, t.body)
        _snapshot(c, item_id, t.title, t.body, now)
        return get_item(c, item_id)  # type: ignore[return-value]


@router.patch("/tasks/{item_id}", response_model=Item)
def update_task(item_id: int, t: TaskUpdate) -> Item:
    return _update(item_id, "task", t.model_dump(exclude_unset=True))


@router.post("/tasks/{item_id}/doing", response_model=Item)
def mark_doing(item_id: int) -> Item:
    return _update(item_id, "task", {"status": "doing"})


@router.post("/tasks/{item_id}/done", response_model=Item)
def mark_done(item_id: int) -> Item:
    return _update(item_id, "task", {"status": "done"})


# ---------- Notes ----------
@router.post("/notes", response_model=Item, status_code=201)
def create_note(n: NoteCreate) -> Item:
    now = utcnow()
    with tx() as c:
        _assert_project(c, n.project_id)
        cur = c.execute(
            """INSERT INTO items(kind, project_id, title, body, tags, created_at, updated_at)
               VALUES('note', ?, ?, ?, ?, ?, ?)""",
            (n.project_id, n.title, n.body, json.dumps(n.tags), now, now),
        )
        item_id = cur.lastrowid
        rebuild_refs(c, item_id, n.project_id, n.title, n.body)
        _snapshot(c, item_id, n.title, n.body, now)
        return get_item(c, item_id)  # type: ignore[return-value]


@router.patch("/notes/{item_id}", response_model=Item)
def update_note(item_id: int, n: NoteUpdate) -> Item:
    return _update(item_id, "note", n.model_dump(exclude_unset=True))


# ---------- Links ----------
@router.post("/links", response_model=Item, status_code=201)
async def create_link(l: LinkCreate) -> Item:
    now = utcnow()
    url = str(l.url)
    title = l.title
    description = None
    favicon = None
    if l.fetch_metadata:
        meta = await fetch_link(url)
        title = title or meta.title
        description = meta.description
        favicon = meta.favicon_url
    with tx() as c:
        _assert_project(c, l.project_id)
        cur = c.execute(
            """INSERT INTO items(kind, project_id, title, body, tags, created_at, updated_at,
                                 url, link_description, favicon_url, is_read, display_label)
               VALUES('link', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                l.project_id, title, l.annotation, json.dumps(l.tags), now, now,
                url, description, favicon, 1 if l.is_read else 0, l.display_label,
            ),
        )
        item_id = cur.lastrowid
        rebuild_refs(c, item_id, l.project_id, title, l.annotation)
        _snapshot(c, item_id, title, l.annotation, now)
        return get_item(c, item_id)  # type: ignore[return-value]


@router.patch("/links/{item_id}", response_model=Item)
def update_link(item_id: int, l: LinkUpdate) -> Item:
    data = l.model_dump(exclude_unset=True)
    # annotation maps to body column
    if "annotation" in data:
        data["body"] = data.pop("annotation")
    return _update(item_id, "link", data)


# ---------- Generic read & delete ----------
@router.get("/items/{item_id}", response_model=Item)
def read_item(item_id: int) -> Item:
    item = get_item(conn(), item_id)
    if not item:
        raise HTTPException(404)
    return item


@router.get("/items/{item_id}/versions", response_model=list[Version])
def list_versions(item_id: int) -> list[Version]:
    c = conn()
    if not c.execute("SELECT 1 FROM items WHERE id = ?", (item_id,)).fetchone():
        raise HTTPException(404)
    rows = c.execute(
        "SELECT id, item_id, title, body, saved_at FROM item_versions WHERE item_id = ? ORDER BY saved_at DESC, id DESC",
        (item_id,),
    ).fetchall()
    return [Version.model_validate(dict(r)) for r in rows]


@router.delete("/items/{item_id}", status_code=204)
def delete_item(item_id: int) -> None:
    with tx() as c:
        cur = c.execute("DELETE FROM items WHERE id = ?", (item_id,))
        if cur.rowcount == 0:
            raise HTTPException(404)


@router.get("/items", response_model=list[Item])
def list_items(
    project_id: Optional[int] = None,
    kind: Optional[str] = None,
    status: Optional[str] = Query(None),
    is_read: Optional[bool] = None,
    is_pinned: Optional[bool] = None,
    limit: int = 200,
    offset: int = 0,
) -> list[Item]:
    where, params = [], []
    if project_id is not None:
        where.append("project_id = ?"); params.append(project_id)
    if kind:
        where.append("kind = ?"); params.append(kind)
    if status:
        where.append("status = ?"); params.append(status)
    if is_read is not None:
        where.append("is_read = ?"); params.append(1 if is_read else 0)
    if is_pinned is not None:
        where.append("is_pinned = ?"); params.append(1 if is_pinned else 0)
    sql = "SELECT * FROM items"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY updated_at DESC LIMIT ? OFFSET ?"
    params.extend([limit, offset])
    c = conn()
    rows = c.execute(sql, params).fetchall()
    return [row_to_item(c, r) for r in rows]


# ---------- internals ----------
def _clear_doing(c, now: str | None = None) -> None:
    now = now or utcnow()
    c.execute(
        "UPDATE items SET status='today', doing_started_at=NULL, updated_at=? "
        "WHERE kind='task' AND status='doing'",
        (now,),
    )
    _close_open_sessions(c, now)


def _close_open_sessions(c, now: str) -> None:
    c.execute(
        "UPDATE work_sessions SET ended_at = ? WHERE ended_at IS NULL",
        (now,),
    )


def _open_session(c, item_id: int, now: str) -> None:
    c.execute(
        "INSERT INTO work_sessions(item_id, started_at) VALUES (?, ?)",
        (item_id, now),
    )


def _update(item_id: int, expected_kind: str, fields: dict) -> Item:
    if "tags" in fields and fields["tags"] is not None:
        fields["tags"] = json.dumps(fields["tags"])
    if not fields:
        item = get_item(conn(), item_id)
        if not item:
            raise HTTPException(404)
        return item
    now = utcnow()
    fields["updated_at"] = now
    with tx() as c:
        row = c.execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()
        if not row:
            raise HTTPException(404)
        if row["kind"] != expected_kind:
            raise HTTPException(400, f"item is not a {expected_kind}")

        # task status side-effects
        if expected_kind == "task" and "status" in fields:
            new_status = fields["status"]
            old_status = row["status"]
            if new_status == "doing":
                if old_status != "doing":
                    _clear_doing(c, now)
                    fields["doing_started_at"] = now
                    _open_session(c, item_id, now)
                # else: already doing, no-op
            else:
                if old_status == "doing":
                    _close_open_sessions(c, now)
                fields["doing_started_at"] = None
            if new_status == "done":
                fields["done_at"] = now
            elif old_status == "done":
                fields["done_at"] = None

        sets = ", ".join(f"{k} = ?" for k in fields)
        c.execute(f"UPDATE items SET {sets} WHERE id = ?", (*fields.values(), item_id))

        # if title/body changed, rebuild refs and snapshot a new version
        if any(k in fields for k in ("title", "body")):
            newrow = c.execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()
            rebuild_refs(c, item_id, newrow["project_id"], newrow["title"], newrow["body"])
            if newrow["title"] != row["title"] or newrow["body"] != row["body"]:
                _snapshot(c, item_id, newrow["title"], newrow["body"], now)

        return get_item(c, item_id)  # type: ignore[return-value]
