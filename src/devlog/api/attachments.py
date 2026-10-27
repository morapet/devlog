from __future__ import annotations

import base64
import binascii
import platform
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel

from ..db import conn, tx, utcnow

router = APIRouter(tags=["attachments"])

# Mesh formats the in-browser viewer can load, mapped to a sane content-type.
MESH_MIME = {
    "stl": "model/stl",
    "obj": "model/obj",
    "3mf": "model/3mf",
}

# Guard against a runaway base64 payload bloating the DB / JSON exports.
MAX_PAYLOAD_BYTES = 40 * 1024 * 1024  # 40 MB per encoded field


class Attachment(BaseModel):
    id: int
    item_id: int
    kind: str
    title: Optional[str] = None
    data_xml: Optional[str] = None
    data_svg: Optional[str] = None
    # kind='model' payloads (base64): a viewable mesh + optional native file.
    mesh_b64: Optional[str] = None
    mesh_format: Optional[str] = None
    native_b64: Optional[str] = None
    native_name: Optional[str] = None
    created_at: str
    updated_at: str


class AttachmentSummary(BaseModel):
    """Lighter version omitting bulky payloads — used for list endpoints."""
    id: int
    item_id: int
    kind: str
    title: Optional[str] = None
    mesh_format: Optional[str] = None
    native_name: Optional[str] = None
    created_at: str
    updated_at: str
    has_xml: bool
    has_svg: bool
    has_mesh: bool
    has_native: bool


class AttachmentCreate(BaseModel):
    kind: str = "drawing"
    title: Optional[str] = None
    data_xml: Optional[str] = None
    data_svg: Optional[str] = None
    mesh_b64: Optional[str] = None
    mesh_format: Optional[str] = None
    native_b64: Optional[str] = None
    native_name: Optional[str] = None


class AttachmentUpdate(BaseModel):
    title: Optional[str] = None
    data_xml: Optional[str] = None
    data_svg: Optional[str] = None
    mesh_b64: Optional[str] = None
    mesh_format: Optional[str] = None
    native_b64: Optional[str] = None
    native_name: Optional[str] = None


def _row_get(r, key: str):
    """Tolerant column read — a row from an un-migrated DB may lack a column."""
    try:
        return r[key]
    except (IndexError, KeyError):
        return None


def _row_to_summary(r) -> AttachmentSummary:
    return AttachmentSummary(
        id=r["id"], item_id=r["item_id"], kind=r["kind"], title=r["title"],
        mesh_format=_row_get(r, "mesh_format"), native_name=_row_get(r, "native_name"),
        created_at=r["created_at"], updated_at=r["updated_at"],
        has_xml=bool(r["data_xml"]), has_svg=bool(r["data_svg"]),
        has_mesh=bool(_row_get(r, "mesh_b64")), has_native=bool(_row_get(r, "native_b64")),
    )


def _decode_b64(value: str, label: str) -> bytes:
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(400, f"{label} is not valid base64")


def _validate_payloads(fields: dict) -> None:
    """Reject oversize / mis-typed model payloads before they hit the DB."""
    for key in ("mesh_b64", "native_b64"):
        val = fields.get(key)
        if val and len(val) > MAX_PAYLOAD_BYTES:
            raise HTTPException(413, f"{key} exceeds the {MAX_PAYLOAD_BYTES // (1024 * 1024)} MB limit")
    fmt = fields.get("mesh_format")
    if fmt is not None and fmt not in MESH_MIME:
        raise HTTPException(400, f"unsupported mesh_format {fmt!r}; expected one of {sorted(MESH_MIME)}")


@router.get("/items/{item_id}/attachments", response_model=list[AttachmentSummary])
def list_for_item(item_id: int) -> list[AttachmentSummary]:
    c = conn()
    if not c.execute("SELECT 1 FROM items WHERE id = ?", (item_id,)).fetchone():
        raise HTTPException(404)
    # Compute the has_* flags in SQL so we never pull the bulky payloads
    # (data_xml / mesh_b64 / native_b64) just to list attachments.
    rows = c.execute(
        "SELECT id, item_id, kind, title, created_at, updated_at, mesh_format, native_name, "
        "       length(coalesce(data_xml,'')) > 0 AS has_xml, "
        "       length(coalesce(data_svg,'')) > 0 AS has_svg, "
        "       length(coalesce(mesh_b64,'')) > 0 AS has_mesh, "
        "       length(coalesce(native_b64,'')) > 0 AS has_native "
        "FROM attachments WHERE item_id = ? ORDER BY id",
        (item_id,),
    ).fetchall()
    return [
        AttachmentSummary(
            id=r["id"], item_id=r["item_id"], kind=r["kind"], title=r["title"],
            mesh_format=r["mesh_format"], native_name=r["native_name"],
            created_at=r["created_at"], updated_at=r["updated_at"],
            has_xml=bool(r["has_xml"]), has_svg=bool(r["has_svg"]),
            has_mesh=bool(r["has_mesh"]), has_native=bool(r["has_native"]),
        )
        for r in rows
    ]


@router.post("/items/{item_id}/attachments", response_model=Attachment, status_code=201)
def create(item_id: int, body: AttachmentCreate) -> Attachment:
    _validate_payloads(body.model_dump())
    now = utcnow()
    with tx() as c:
        if not c.execute("SELECT 1 FROM items WHERE id = ?", (item_id,)).fetchone():
            raise HTTPException(404)
        cur = c.execute(
            "INSERT INTO attachments"
            "(item_id, kind, title, data_xml, data_svg, mesh_b64, mesh_format, "
            " native_b64, native_name, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (item_id, body.kind, body.title, body.data_xml, body.data_svg,
             body.mesh_b64, body.mesh_format, body.native_b64, body.native_name, now, now),
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


@router.get("/attachments/{att_id}/mesh")
def get_mesh(att_id: int) -> Response:
    """Raw mesh bytes for the in-browser 3D viewer (decoded from base64)."""
    row = conn().execute(
        "SELECT mesh_b64, mesh_format FROM attachments WHERE id = ?", (att_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404)
    if not row["mesh_b64"]:
        raise HTTPException(404, "attachment has no mesh")
    data = _decode_b64(row["mesh_b64"], "mesh_b64")
    mime = MESH_MIME.get(row["mesh_format"] or "", "application/octet-stream")
    return Response(content=data, media_type=mime, headers={"Cache-Control": "no-cache"})


class OpenNativeResult(BaseModel):
    opened: bool
    reason: str


@router.post("/attachments/{att_id}/open-native", response_model=OpenNativeResult)
def open_native(att_id: int) -> OpenNativeResult:
    """Open the model in the native SolidCraft app on the local machine.

    Prefers the editable ``.solidcraft`` file; falls back to the mesh (which
    SolidCraft imports as a static body). Only works when the backend runs on
    the same Mac as SolidCraft — which it does for the local-first setup.
    """
    if platform.system() != "Darwin":
        return OpenNativeResult(opened=False, reason="native open is only supported on macOS")
    row = conn().execute(
        "SELECT native_b64, native_name, mesh_b64, mesh_format FROM attachments WHERE id = ?",
        (att_id,),
    ).fetchone()
    if not row:
        raise HTTPException(404)

    if row["native_b64"]:
        payload = _decode_b64(row["native_b64"], "native_b64")
        name = row["native_name"] or f"model-{att_id}.solidcraft"
    elif row["mesh_b64"]:
        payload = _decode_b64(row["mesh_b64"], "mesh_b64")
        name = f"model-{att_id}.{row['mesh_format'] or 'stl'}"
    else:
        raise HTTPException(404, "attachment has no openable file")

    # Write to a stable per-attachment temp path so re-opening reuses it.
    safe = Path(name).name or f"model-{att_id}"
    out = Path(tempfile.gettempdir()) / "devlog-models" / str(att_id) / safe
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(payload)

    # `open -a SolidCraft` returns non-zero when the app can't be found.
    proc = subprocess.run(
        ["open", "-a", "SolidCraft", str(out)],
        capture_output=True, text=True,
    )
    if proc.returncode == 0:
        return OpenNativeResult(opened=True, reason=str(out))
    return OpenNativeResult(
        opened=False,
        reason="SolidCraft doesn't appear to be installed (open failed: "
               + (proc.stderr.strip() or f"exit {proc.returncode}") + ")",
    )


@router.patch("/attachments/{att_id}", response_model=Attachment)
def update(att_id: int, body: AttachmentUpdate) -> Attachment:
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        return get_attachment(att_id)
    _validate_payloads(fields)
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
