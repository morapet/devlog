"""Time-spent computation (raw per-day, plus a deprecated clipping helper)."""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo  # noqa: F401  (used indirectly via _tz)

from .api.settings import WorkingHours


def _tz(wh: WorkingHours):
    if wh.tz == "local" or not wh.tz:
        return datetime.now().astimezone().tzinfo
    return ZoneInfo(wh.tz)


def _parse_hm(s: str) -> time:
    h, m = s.split(":")
    return time(int(h), int(m))


def _parse_iso(s: str) -> datetime:
    # tolerate trailing Z or +00:00
    dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def clip_session(
    started_at: str,
    ended_at: str | None,
    wh: WorkingHours,
    now_utc: datetime | None = None,
    range_from: datetime | None = None,
    range_to: datetime | None = None,
) -> list[tuple[date, float]]:
    """DEPRECATED: kept for backward compatibility. Returns raw per-day seconds (no working-hours clipping)."""
    return raw_session(started_at, ended_at, wh, now_utc=now_utc, range_from=range_from, range_to=range_to)


def raw_session(
    started_at: str,
    ended_at: str | None,
    wh: WorkingHours,
    now_utc: datetime | None = None,
    range_from: datetime | None = None,
    range_to: datetime | None = None,
) -> list[tuple[date, float]]:
    """Return per-day raw seconds (no working-hours clip), bucketed by local-day-of-occurrence.

    Optionally clipped to [range_from, range_to] in UTC.
    """
    tz = _tz(wh)
    start = _parse_iso(started_at)
    end = _parse_iso(ended_at) if ended_at else (now_utc or datetime.now(timezone.utc))

    if range_from:
        start = max(start, range_from)
    if range_to:
        end = min(end, range_to)
    if end <= start:
        return []

    start_local = start.astimezone(tz)
    end_local = end.astimezone(tz)

    out: list[tuple[date, float]] = []
    cur_day = start_local.date()
    last_day = end_local.date()
    while cur_day <= last_day:
        day_start = datetime.combine(cur_day, time(0, 0), tzinfo=tz)
        day_end = day_start + timedelta(days=1)
        seg_start = max(start_local, day_start)
        seg_end = min(end_local, day_end)
        if seg_end > seg_start:
            out.append((cur_day, (seg_end - seg_start).total_seconds()))
        cur_day += timedelta(days=1)
    return out
