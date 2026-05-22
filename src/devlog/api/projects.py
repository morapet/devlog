from fastapi import APIRouter, HTTPException

from ..db import conn, tx, utcnow
from ..models import Project, ProjectIn, ProjectUpdate

router = APIRouter(prefix="/projects", tags=["projects"])


def _row_to_project(row) -> Project:
    return Project.model_validate(dict(row))


@router.get("", response_model=list[Project])
def list_projects() -> list[Project]:
    rows = conn().execute("SELECT * FROM projects ORDER BY name").fetchall()
    return [_row_to_project(r) for r in rows]


@router.post("", response_model=Project, status_code=201)
def create_project(p: ProjectIn) -> Project:
    now = utcnow()
    with tx() as c:
        try:
            cur = c.execute(
                "INSERT INTO projects(slug,name,description,color,created_at,updated_at) VALUES (?,?,?,?,?,?)",
                (p.slug, p.name, p.description, p.color, now, now),
            )
        except Exception as e:
            raise HTTPException(409, f"slug conflict or invalid: {e}")
        row = c.execute("SELECT * FROM projects WHERE id = ?", (cur.lastrowid,)).fetchone()
    return _row_to_project(row)


@router.get("/{project_id}", response_model=Project)
def get_project(project_id: int) -> Project:
    row = conn().execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    if not row:
        raise HTTPException(404)
    return _row_to_project(row)


@router.patch("/{project_id}", response_model=Project)
def update_project(project_id: int, p: ProjectUpdate) -> Project:
    fields = {k: v for k, v in p.model_dump(exclude_unset=True).items()}
    if not fields:
        return get_project(project_id)
    fields["updated_at"] = utcnow()
    sets = ", ".join(f"{k} = ?" for k in fields)
    with tx() as c:
        cur = c.execute(f"UPDATE projects SET {sets} WHERE id = ?", (*fields.values(), project_id))
        if cur.rowcount == 0:
            raise HTTPException(404)
        row = c.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    return _row_to_project(row)


@router.delete("/{project_id}", status_code=204)
def delete_project(project_id: int) -> None:
    with tx() as c:
        cur = c.execute("DELETE FROM projects WHERE id = ?", (project_id,))
        if cur.rowcount == 0:
            raise HTTPException(404)


@router.post("/{project_id}/current", status_code=204)
def set_current(project_id: int) -> None:
    with tx() as c:
        row = c.execute("SELECT id FROM projects WHERE id = ?", (project_id,)).fetchone()
        if not row:
            raise HTTPException(404)
        c.execute(
            "INSERT INTO settings(key,value) VALUES('current_project_id', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (str(project_id),),
        )


@router.get("/current/resolve", response_model=Project | None)
def get_current() -> Project | None:
    c = conn()
    row = c.execute("SELECT value FROM settings WHERE key='current_project_id'").fetchone()
    if not row:
        return None
    prow = c.execute("SELECT * FROM projects WHERE id = ?", (int(row["value"]),)).fetchone()
    return _row_to_project(prow) if prow else None
