from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Query
from pydantic import BaseModel

from ..db import conn
from ..stats import clip_session, _tz
from .settings import load as load_working_hours

router = APIRouter(prefix="/stats", tags=["stats"])


class DayBucket(BaseModel):
    date: str
    seconds: float


class TaskBucket(BaseModel):
    item_id: int
    title: str | None
    project_id: int
    status: str | None
    seconds: float


class Activity(BaseModel):
    tasks_done: list[int]
    tasks_created: list[int]
    notes_created: list[int]
    links_created: list[int]


class StatsResponse(BaseModel):
    range_from: str
    range_to: str
    working_hours: dict
    total_seconds: float
    by_day: list[DayBucket]
    by_task: list[TaskBucket]
    by_project: dict[int, float]
    activity: Activity


def _resolve_range(from_: str | None, to: str | None, wh) -> tuple[datetime, datetime]:
    tz = _tz(wh)
    now_local = datetime.now(tz)
    if not from_ and not to:
        # default: last 7 local days inclusive
        end_local = datetime.combine(now_local.date() + timedelta(days=1), time.min, tzinfo=tz)
        start_local = end_local - timedelta(days=7)
        return start_local.astimezone(timezone.utc), end_local.astimezone(timezone.utc)

    def parse(s: str, end: bool) -> datetime:
        # accept YYYY-MM-DD or full ISO
        if len(s) == 10:
            d = datetime.fromisoformat(s).date()
            t = time.max if end else time.min
            return datetime.combine(d, t, tzinfo=tz).astimezone(timezone.utc)
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=tz)
        return dt.astimezone(timezone.utc)

    start_utc = parse(from_, end=False) if from_ else (now_local - timedelta(days=7)).astimezone(timezone.utc)
    end_utc = parse(to, end=True) if to else now_local.astimezone(timezone.utc)
    return start_utc, end_utc


@router.get("", response_model=StatsResponse)
def stats(
    from_: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = Query(None),
    project_id: Optional[int] = None,
) -> StatsResponse:
    wh = load_working_hours()
    range_from, range_to = _resolve_range(from_, to, wh)
    now_utc = datetime.now(timezone.utc)

    c = conn()

    # sessions overlapping the range
    where = ["(ended_at IS NULL OR ended_at >= ?)", "started_at <= ?"]
    params: list = [range_from.isoformat(timespec="seconds"), range_to.isoformat(timespec="seconds")]
    if project_id is not None:
        where.append("items.project_id = ?")
        params.append(project_id)
    sql = (
        "SELECT work_sessions.*, items.project_id, items.title, items.status "
        "FROM work_sessions JOIN items ON items.id = work_sessions.item_id "
        "WHERE " + " AND ".join(where)
    )
    sessions = c.execute(sql, params).fetchall()

    by_day_acc: dict[str, float] = defaultdict(float)
    by_task_acc: dict[int, float] = defaultdict(float)
    by_project_acc: dict[int, float] = defaultdict(float)
    task_meta: dict[int, sqlite3_RowLike] = {}

    for row in sessions:
        per_day = clip_session(
            row["started_at"], row["ended_at"], wh, now_utc=now_utc,
            range_from=range_from, range_to=range_to,
        )
        for d, secs in per_day:
            by_day_acc[d.isoformat()] += secs
            by_task_acc[row["item_id"]] += secs
            by_project_acc[row["project_id"]] += secs
        task_meta[row["item_id"]] = row

    total = sum(by_day_acc.values())

    by_day = [DayBucket(date=k, seconds=round(v, 1)) for k, v in sorted(by_day_acc.items())]
    by_task = sorted(
        (
            TaskBucket(
                item_id=tid,
                title=task_meta[tid]["title"],
                project_id=task_meta[tid]["project_id"],
                status=task_meta[tid]["status"],
                seconds=round(secs, 1),
            )
            for tid, secs in by_task_acc.items()
        ),
        key=lambda b: b.seconds,
        reverse=True,
    )

    # activity feed
    rf = range_from.isoformat(timespec="seconds")
    rt = range_to.isoformat(timespec="seconds")
    proj_filter = "AND project_id = ?" if project_id is not None else ""
    proj_params = (project_id,) if project_id is not None else ()

    def ids(sql: str, args: tuple) -> list[int]:
        return [r["id"] for r in c.execute(sql, args).fetchall()]

    tasks_done = ids(
        f"SELECT id FROM items WHERE kind='task' AND status='done' AND done_at BETWEEN ? AND ? {proj_filter} ORDER BY done_at DESC",
        (rf, rt, *proj_params),
    )
    tasks_created = ids(
        f"SELECT id FROM items WHERE kind='task' AND created_at BETWEEN ? AND ? {proj_filter} ORDER BY created_at DESC",
        (rf, rt, *proj_params),
    )
    notes_created = ids(
        f"SELECT id FROM items WHERE kind='note' AND created_at BETWEEN ? AND ? {proj_filter} ORDER BY created_at DESC",
        (rf, rt, *proj_params),
    )
    links_created = ids(
        f"SELECT id FROM items WHERE kind='link' AND created_at BETWEEN ? AND ? {proj_filter} ORDER BY created_at DESC",
        (rf, rt, *proj_params),
    )

    return StatsResponse(
        range_from=rf,
        range_to=rt,
        working_hours=wh.model_dump(),
        total_seconds=round(total, 1),
        by_day=by_day,
        by_task=by_task,
        by_project={pid: round(s, 1) for pid, s in by_project_acc.items()},
        activity=Activity(
            tasks_done=tasks_done,
            tasks_created=tasks_created,
            notes_created=notes_created,
            links_created=links_created,
        ),
    )


# Placeholder type alias to keep type hints honest (avoid importing sqlite3.Row name)
sqlite3_RowLike = object


class WeekPeriod(BaseModel):
    year: int
    week: int
    label: str
    range_from: str
    range_to: str
    seconds: float


class MonthPeriod(BaseModel):
    year: int
    month: int
    label: str
    range_from: str
    range_to: str
    seconds: float


class PeriodsResponse(BaseModel):
    weeks: list[WeekPeriod]
    months: list[MonthPeriod]


@router.get("/periods", response_model=PeriodsResponse)
def periods() -> PeriodsResponse:
    wh = load_working_hours()
    c = conn()
    rows = c.execute("SELECT started_at, ended_at FROM work_sessions").fetchall()
    now_utc = datetime.now(timezone.utc)

    weeks: dict[tuple[int, int], float] = defaultdict(float)
    months: dict[tuple[int, int], float] = defaultdict(float)
    for r in rows:
        for d, secs in clip_session(r["started_at"], r["ended_at"], wh, now_utc=now_utc):
            iso_year, iso_week, _ = d.isocalendar()
            weeks[(iso_year, iso_week)] += secs
            months[(d.year, d.month)] += secs

    week_list: list[WeekPeriod] = []
    for (y, w), secs in sorted(weeks.items(), reverse=True):
        if secs <= 0:
            continue
        start = date.fromisocalendar(y, w, 1)
        end = start + timedelta(days=6)
        week_list.append(WeekPeriod(
            year=y, week=w,
            label=f"W{w:02d} · {start.strftime('%b %d')}–{end.strftime('%b %d, %Y')}",
            range_from=start.isoformat(),
            range_to=end.isoformat(),
            seconds=round(secs, 1),
        ))

    month_list: list[MonthPeriod] = []
    for (y, mo), secs in sorted(months.items(), reverse=True):
        if secs <= 0:
            continue
        start = date(y, mo, 1)
        # end = last day of month
        next_first = date(y + (1 if mo == 12 else 0), 1 if mo == 12 else mo + 1, 1)
        end = next_first - timedelta(days=1)
        month_list.append(MonthPeriod(
            year=y, month=mo,
            label=f"{start.strftime('%B %Y')}",
            range_from=start.isoformat(),
            range_to=end.isoformat(),
            seconds=round(secs, 1),
        ))

    return PeriodsResponse(weeks=week_list, months=month_list)
