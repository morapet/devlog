"""Whole-DB backup & restore.

A backup is a consistent copy of the SQLite database (WAL included) written to
``<data_dir>/backups/``. Restoring replaces the live database with a chosen
backup — and always takes a fresh safety backup first, so even a restore is
reversible.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..backup import (
    delete_backup,
    hot_backup,
    list_backups,
    prune_backups,
    restore_backup,
)

router = APIRouter(prefix="/backups", tags=["backups"])


class BackupInfo(BaseModel):
    name: str
    created_at: str | None
    tag: str
    size: int


@router.get("", response_model=list[BackupInfo])
def get_backups() -> list[dict]:
    return list_backups()


@router.post("", response_model=BackupInfo)
def create_backup() -> dict:
    path = hot_backup(tag="manual")
    for b in list_backups():
        if b["name"] == path.name:
            return b
    # Fallback (shouldn't happen): report what we can.
    return {"name": path.name, "created_at": None, "tag": "manual", "size": path.stat().st_size}


class PruneRequest(BaseModel):
    keep: int = 10


class PruneResult(BaseModel):
    deleted: list[str]
    remaining: int


@router.post("/prune", response_model=PruneResult)
def post_prune(req: PruneRequest) -> PruneResult:
    """Delete all but the newest `keep` backups."""
    deleted = prune_backups(req.keep)
    return PruneResult(deleted=deleted, remaining=len(list_backups()))


@router.delete("/{name}", status_code=204)
def delete_one(name: str) -> None:
    try:
        delete_backup(name)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e


class RestoreRequest(BaseModel):
    name: str
    confirm: bool = False


class RestoreResult(BaseModel):
    ok: bool
    restored: str
    safety_backup: str


@router.post("/restore", response_model=RestoreResult)
def post_restore(req: RestoreRequest) -> RestoreResult:
    if not req.confirm:
        raise HTTPException(
            400, "restore replaces all current data and must be confirmed: pass confirm=true."
        )
    try:
        safety = restore_backup(req.name)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    return RestoreResult(ok=True, restored=req.name, safety_backup=str(safety))
