from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel

from ..db import conn, tx, utcnow

router = APIRouter(tags=["attachments"])


class Attachment(BaseModel):
    id: int
    item_id: int
    kind: str
    title: Optional[str] = None
    data_xml: Optional[str] = None
    data_svg: Optional[str] = None
    created_at: str
    updated_at: str


class AttachmentSummary(BaseModel):
    """Lighter version omitting bulky data_xml — used for list endpoints."""
    id: int
    item_id: int
    kind: str
    title: Optional[str] = None
    created_at: str
    updated_at: str
    has_xml: bool
    has_svg: bool


class AttachmentCreate(BaseModel):
    kind: str = "drawing"
    title: Optional[str] = None
    data_xml: Optional[str] = None
    data_svg: Optional[str] = None


class AttachmentUpdate(BaseModel):
    title: Optional[str] = None
    data_xml: Optional[str] = None
    data_svg: Optional[str] = None


def _row_to_summary(r) -> AttachmentSummary:
    return AttachmentSummary(
        id=r["id"], item_id=r["item_id"], kind=r["kind"], title=r["title"],
        created_at=r["created_at"], updated_at=r["updated_at"],
        has_xml=bool(r["data_xml"]), has_svg=bool(r["data_svg"]),
    )


@router.get("/items/{item_id}/attachments", response_model=list[AttachmentSummary])
def list_for_item(item_id: int) -> list[AttachmentSummary]:
    c = conn()
    if not c.execute("SELECT 1 FROM items WHERE id = ?", (item_id,)).fetchone():
        raise HTTPException(404)
    rows = c.execute(
        "SELECT id, item_id, kind, title, created_at, updated_at, data_xml, data_svg "
        "FROM attachments WHERE item_id = ? ORDER BY id",
        (item_id,),
    ).fetchall()
    return [_row_to_summary(r) for r in rows]


@router.post("/items/{item_id}/attachments", response_model=Attachment, status_code=201)
def create(item_id: int, body: AttachmentCreate) -> Attachment:
    now = utcnow()
    with tx() as c:
        if not c.execute("SELECT 1 FROM items WHERE id = ?", (item_id,)).fetchone():
            raise HTTPException(404)
        cur = c.execute(
            "INSERT INTO attachments(item_id, kind, title, data_xml, data_svg, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (item_id, body.kind, body.title, body.data_xml, body.data_svg, now, now),
        )
        row = c.execute("SELECT * FROM attachments WHERE id = ?", (cur.lastrowid,)).fetchone()
    return Attachment.model_validate(dict(row))


@router.get("/attachments/{att_id}", response_model=Attachment)
def get_attachment(att_id: int) -> Attachment:
    row = conn().execute("SELECT * FROM attachments WHERE id = ?", (att_id,)).fetchone()
    if not row:
        raise HTTPException(404)
    return Attachment.model_validate(dict(row))


@router.get("/attachments/{att_id}/svg")
def get_svg(att_id: int) -> Response:
    row = conn().execute("SELECT data_svg FROM attachments WHERE id = ?", (att_id,)).fetchone()
    if not row:
        raise HTTPException(404)
    svg = row["data_svg"] or ""
    return Response(
        content=svg,
        media_type="image/svg+xml",
        headers={"Cache-Control": "no-cache"},
    )


@router.patch("/attachments/{att_id}", response_model=Attachment)
def update(att_id: int, body: AttachmentUpdate) -> Attachment:
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        return get_attachment(att_id)
    fields["updated_at"] = utcnow()
    sets = ", ".join(f"{k} = ?" for k in fields)
    with tx() as c:
        cur = c.execute(
            f"UPDATE attachments SET {sets} WHERE id = ?",
            (*fields.values(), att_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(404)
        row = c.execute("SELECT * FROM attachments WHERE id = ?", (att_id,)).fetchone()
    return Attachment.model_validate(dict(row))


@router.delete("/attachments/{att_id}", status_code=204)
def delete(att_id: int) -> None:
    with tx() as c:
        cur = c.execute("DELETE FROM attachments WHERE id = ?", (att_id,))
        if cur.rowcount == 0:
            raise HTTPException(404)
