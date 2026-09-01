"""Read-only share links.

A share is a random token that grants a time-limited, read-only *focus-mode*
view of a single item to anyone who can reach the backend — e.g. someone else on
the same network. It exposes only the shared item (and its inline drawings) via a
token-scoped endpoint; it is a scoped read-only *view*, not an auth boundary for
the rest of the API (see README / design notes).
"""

import json
import os
import secrets
import socket
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ..db import conn, tx, utcnow

router = APIRouter(tags=["shares"])

DEFAULT_DAYS = 30
MAX_DAYS = 3650


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _serving_lan() -> bool:
    """True if the backend is bound to an interface other devices can reach."""
    host = os.environ.get("DEVLOG_BOUND_HOST", "127.0.0.1")
    return host not in ("127.0.0.1", "localhost", "::1", "")


def _lan_ip() -> str:
    """Best-effort local network IP (the address other devices would use)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


class ShareIn(BaseModel):
    days: int = DEFAULT_DAYS


class Share(BaseModel):
    token: str
    item_id: int
    created_at: str
    expires_at: str
    url: str
    lan_url: str
    serving_lan: bool


def _share_urls(request: Request, token: str) -> tuple[str, str]:
    """(url as the creator sees it, url with the LAN IP for sharing)."""
    scheme = request.url.scheme
    port = request.url.port
    hostport = f"{request.url.hostname}" + (f":{port}" if port else "")
    url = f"{scheme}://{hostport}/share/{token}"
    lanport = f":{port}" if port else ""
    lan_url = f"{scheme}://{_lan_ip()}{lanport}/share/{token}"
    return url, lan_url


@router.post("/items/{item_id}/share", response_model=Share, status_code=201)
def create_share(item_id: int, body: ShareIn, request: Request) -> Share:
    days = max(1, min(body.days or DEFAULT_DAYS, MAX_DAYS))
    with tx() as c:
        it = c.execute("SELECT id FROM items WHERE id = ?", (item_id,)).fetchone()
        if not it:
            raise HTTPException(404, "item not found")
        token = secrets.token_urlsafe(16)
        created = utcnow()
        expires = (_now() + timedelta(days=days)).isoformat(timespec="seconds")
        c.execute(
            "INSERT INTO shares(token, item_id, created_at, expires_at) VALUES (?,?,?,?)",
            (token, item_id, created, expires),
        )
    url, lan_url = _share_urls(request, token)
    return Share(token=token, item_id=item_id, created_at=created, expires_at=expires,
                 url=url, lan_url=lan_url, serving_lan=_serving_lan())


@router.get("/items/{item_id}/shares", response_model=list[Share])
def list_shares(item_id: int, request: Request) -> list[Share]:
    now = utcnow()
    rows = conn().execute(
        "SELECT * FROM shares WHERE item_id = ? AND revoked = 0 AND expires_at > ? "
        "ORDER BY created_at DESC",
        (item_id, now),
    ).fetchall()
    out = []
    serving = _serving_lan()
    for r in rows:
        url, lan_url = _share_urls(request, r["token"])
        out.append(Share(token=r["token"], item_id=r["item_id"], created_at=r["created_at"],
                         expires_at=r["expires_at"], url=url, lan_url=lan_url, serving_lan=serving))
    return out


@router.delete("/shares/{token}", status_code=204)
def revoke_share(token: str) -> None:
    with tx() as c:
        cur = c.execute("UPDATE shares SET revoked = 1 WHERE token = ?", (token,))
        if cur.rowcount == 0:
            raise HTTPException(404, "share not found")


def _load_valid_share(token: str):
    row = conn().execute("SELECT * FROM shares WHERE token = ?", (token,)).fetchone()
    if not row or row["revoked"]:
        raise HTTPException(404, "This share link is invalid or has been revoked.")
    if row["expires_at"] <= utcnow():
        raise HTTPException(410, "This share link has expired.")
    return row


@router.get("/shares/{token}/data")
def share_data(token: str) -> dict:
    share = _load_valid_share(token)
    c = conn()
    it = c.execute("SELECT * FROM items WHERE id = ?", (share["item_id"],)).fetchone()
    if not it:
        raise HTTPException(404, "The shared item no longer exists.")
    proj = c.execute("SELECT name FROM projects WHERE id = ?", (it["project_id"],)).fetchone()
    atts = c.execute(
        "SELECT id, title, data_svg FROM attachments WHERE item_id = ? ORDER BY id",
        (share["item_id"],),
    ).fetchall()
    try:
        tags = json.loads(it["tags"] or "[]")
    except (ValueError, TypeError):
        tags = []
    return {
        "item": {
            "id": it["id"],
            "kind": it["kind"],
            "title": it["title"],
            "body": it["body"],
            "tags": tags,
            "url": it["url"],
            "link_description": it["link_description"],
            "display_label": it["display_label"],
            "status": it["status"],
            "created_at": it["created_at"],
            "updated_at": it["updated_at"],
        },
        "project": proj["name"] if proj else None,
        "attachments": [{"id": a["id"], "title": a["title"], "svg": a["data_svg"]} for a in atts],
        "shared": {"created_at": share["created_at"], "expires_at": share["expires_at"]},
    }
