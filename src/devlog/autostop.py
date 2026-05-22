"""Auto-pause doing tasks at end of work day.

A background loop runs every minute. For every open work_session, if the local
end-of-workday for the session's start date has passed, the session is closed at
that moment and the task is moved from 'doing' back to 'today'.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, time, timedelta, timezone

from .api.settings import load as load_working_hours
from .db import conn, tx, utcnow
from .stats import _tz


TICK_SECONDS = 60


def _parse_hm(s: str) -> time:
    h, m = s.split(":")
    return time(int(h), int(m))


def _parse_iso(s: str) -> datetime:
    dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def check_once() -> int:
    """Run a single auto-pause sweep. Returns number of tasks paused."""
    wh = load_working_hours()
    tz = _tz(wh)
    end_t = _parse_hm(wh.end)
    days = set(wh.days)
    now_utc = datetime.now(timezone.utc)

    paused = 0
    with tx() as c:
        rows = c.execute(
            "SELECT id, item_id, started_at FROM work_sessions WHERE ended_at IS NULL"
        ).fetchall()
        for r in rows:
            start_local = _parse_iso(r["started_at"]).astimezone(tz)
            start_day = start_local.date()
            if start_day.isoweekday() not in days:
                # Session began on a non-working day → don't auto-pause; user must manage.
                continue
            end_of_workday_local = datetime.combine(start_day, end_t, tzinfo=tz)
            end_of_workday_utc = end_of_workday_local.astimezone(timezone.utc)
            if now_utc <= end_of_workday_utc:
                continue
            # Guard: never end before start (e.g. session started after end-of-day).
            if end_of_workday_utc <= _parse_iso(r["started_at"]):
                continue
            ended_at_iso = end_of_workday_utc.isoformat(timespec="seconds")
            now_iso = utcnow()
            c.execute(
                "UPDATE work_sessions SET ended_at = ? WHERE id = ?",
                (ended_at_iso, r["id"]),
            )
            c.execute(
                "UPDATE items SET status = 'today', doing_started_at = NULL, updated_at = ? "
                "WHERE id = ? AND status = 'doing'",
                (now_iso, r["item_id"]),
            )
            paused += 1
    if paused:
        print(f"[autostop] paused {paused} task(s) at end of work day")
    return paused


async def auto_stop_loop() -> None:
    while True:
        try:
            check_once()
        except Exception as e:  # noqa: BLE001
            print(f"[autostop] error: {e!r}")
        await asyncio.sleep(TICK_SECONDS)
