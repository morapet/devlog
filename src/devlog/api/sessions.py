from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..db import conn, tx

router = APIRouter(tags=["sessions"])


def _parse(s: str) -> datetime:
    dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _seconds(started_at: str, ended_at: Optional[str]) -> float:
    start = _parse(started_at)
    end = _parse(ended_at) if ended_at else datetime.now(timezone.utc)
    return max(0.0, (end - start).total_seconds())


class Session(BaseModel):
    id: int
    item_id: int
    started_at: str
    ended_at: Optional[str]
    duration_seconds: float
    is_open: bool


class SessionCreate(BaseModel):
    started_at: str
    ended_at: Optional[str] = None


class SessionUpdate(BaseModel):
    started_at: Optional[str] = None
    ended_at: Optional[str] = None  # None = close-as-now is NOT done here; use empty string to clear


def _to_session(row) -> Session:
    return Session(
        id=row["id"],
        item_id=row["item_id"],
        started_at=row["started_at"],
        ended_at=row["ended_at"],
        duration_seconds=round(_seconds(row["started_at"], row["ended_at"]), 1),
        is_open=row["ended_at"] is None,
    )


@router.get("/tasks/{item_id}/sessions", response_model=list[Session])
def list_sessions(item_id: int) -> list[Session]:
    c = conn()
    row = c.execute("SELECT kind FROM items WHERE id = ?", (item_id,)).fetchone()
    if not row:
        raise HTTPException(404)
    if row["kind"] != "task":
        raise HTTPException(400, "item is not a task")
    rows = c.execute(
        "SELECT id, item_id, started_at, ended_at FROM work_sessions WHERE item_id = ? ORDER BY started_at DESC",
        (item_id,),
    ).fetchall()
    return [_to_session(r) for r in rows]


@router.post("/tasks/{item_id}/sessions", response_model=Session, status_code=201)
def create_session(item_id: int, body: SessionCreate) -> Session:
    # validate inputs
    try:
        start = _parse(body.started_at)
        end = _parse(body.ended_at) if body.ended_at else None
    except ValueError as e:
        raise HTTPException(400, f"bad timestamp: {e}")
    if end is not None and end <= start:
        raise HTTPException(400, "ended_at must be after started_at")

    with tx() as c:
        row = c.execute("SELECT kind FROM items WHERE id = ?", (item_id,)).fetchone()
        if not row:
            raise HTTPException(404)
        if row["kind"] != "task":
            raise HTTPException(400, "item is not a task")
        cur = c.execute(
            "INSERT INTO work_sessions(item_id, started_at, ended_at) VALUES (?, ?, ?)",
            (item_id, start.isoformat(timespec="seconds"), end.isoformat(timespec="seconds") if end else None),
        )
        new_row = c.execute(
            "SELECT id, item_id, started_at, ended_at FROM work_sessions WHERE id = ?",
            (cur.lastrowid,),
        ).fetchone()
    return _to_session(new_row)


@router.patch("/sessions/{session_id}", response_model=Session)
def update_session(session_id: int, body: SessionUpdate) -> Session:
    fields: dict = {}
    if body.started_at is not None:
        try:
            fields["started_at"] = _parse(body.started_at).isoformat(timespec="seconds")
        except ValueError as e:
            raise HTTPException(400, f"bad started_at: {e}")
    if body.ended_at is not None:
        # empty string means "no change"; "null" string handled by client by not sending it
        if body.ended_at == "":
            fields["ended_at"] = None  # mark open
        else:
            try:
                fields["ended_at"] = _parse(body.ended_at).isoformat(timespec="seconds")
            except ValueError as e:
                raise HTTPException(400, f"bad ended_at: {e}")
    if not fields:
        c = conn()
        row = c.execute(
            "SELECT id, item_id, started_at, ended_at FROM work_sessions WHERE id = ?",
            (session_id,),
        ).fetchone()
        if not row:
            raise HTTPException(404)
        return _to_session(row)

    with tx() as c:
        existing = c.execute(
            "SELECT id, item_id, started_at, ended_at FROM work_sessions WHERE id = ?",
            (session_id,),
        ).fetchone()
        if not existing:
            raise HTTPException(404)
        new_started = fields.get("started_at", existing["started_at"])
        new_ended = fields.get("ended_at", existing["ended_at"])
        if new_ended is not None and _parse(new_ended) <= _parse(new_started):
            raise HTTPException(400, "ended_at must be after started_at")
        sets = ", ".join(f"{k} = ?" for k in fields)
        c.execute(f"UPDATE work_sessions SET {sets} WHERE id = ?", (*fields.values(), session_id))
        row = c.execute(
            "SELECT id, item_id, started_at, ended_at FROM work_sessions WHERE id = ?",
            (session_id,),
        ).fetchone()
    return _to_session(row)


@router.delete("/sessions/{session_id}", status_code=204)
def delete_session(session_id: int) -> None:
    with tx() as c:
        cur = c.execute("DELETE FROM work_sessions WHERE id = ?", (session_id,))
        if cur.rowcount == 0:
            raise HTTPException(404)


@router.get("/tasks/totals")
def task_totals(project_id: Optional[int] = None) -> dict[int, float]:
    c = conn()
    sql = (
        "SELECT work_sessions.item_id, work_sessions.started_at, work_sessions.ended_at "
        "FROM work_sessions JOIN items ON items.id = work_sessions.item_id "
        "WHERE items.kind = 'task'"
    )
    params: list = []
    if project_id is not None:
        sql += " AND items.project_id = ?"
        params.append(project_id)
    rows = c.execute(sql, params).fetchall()
    totals: dict[int, float] = {}
    for r in rows:
        totals[r["item_id"]] = totals.get(r["item_id"], 0.0) + _seconds(r["started_at"], r["ended_at"])
    return {tid: round(s, 1) for tid, s in totals.items()}
