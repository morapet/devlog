from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..db import conn, tx

router = APIRouter(prefix="/settings", tags=["settings"])

WorkingDay = Literal[1, 2, 3, 4, 5, 6, 7]  # ISO weekday: 1=Mon


class WorkingHours(BaseModel):
    start: str = Field(default="08:00", pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    end: str = Field(default="18:00", pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    days: list[WorkingDay] = Field(default_factory=lambda: [1, 2, 3, 4, 5])
    tz: str = Field(default="local")  # 'local' or IANA name


DEFAULT = WorkingHours()


def load() -> WorkingHours:
    row = conn().execute("SELECT value FROM settings WHERE key = 'working_hours'").fetchone()
    if not row:
        return DEFAULT
    try:
        return WorkingHours.model_validate_json(row["value"])
    except Exception:
        return DEFAULT


@router.get("/working_hours", response_model=WorkingHours)
def get_working_hours() -> WorkingHours:
    return load()


@router.put("/working_hours", response_model=WorkingHours)
def set_working_hours(wh: WorkingHours) -> WorkingHours:
    if wh.start >= wh.end:
        raise HTTPException(400, "start must be earlier than end")
    with tx() as c:
        c.execute(
            "INSERT INTO settings(key, value) VALUES('working_hours', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (wh.model_dump_json(),),
        )
    return wh
