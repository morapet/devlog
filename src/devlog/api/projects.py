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


def _validate_parent(c, parent_id: int | None, self_id: int | None = None) -> None:
    """Enforce the 2-level cap:
       - parent must exist
       - parent must itself be a root (parent_id IS NULL)
       - parent cannot be self
       - if self is provided and has children, it cannot become a child
    """
    if parent_id is None or parent_id == 0:
        return
    if self_id is not None and parent_id == self_id:
        raise HTTPException(400, "a project cannot be its own parent")
    prow = c.execute("SELECT id, parent_id FROM projects WHERE id = ?", (parent_id,)).fetchone()
    if not prow:
        raise HTTPException(400, f"parent project {parent_id} does not exist")
    if prow["parent_id"] is not None:
        raise HTTPException(400, "parent must be a root project (2-level hierarchy only)")
    if self_id is not None:
        kids = c.execute("SELECT 1 FROM projects WHERE parent_id = ? LIMIT 1", (self_id,)).fetchone()
        if kids:
            raise HTTPException(400, "this project has children, so it cannot itself become a child")


@router.post("", response_model=Project, status_code=201)
def create_project(p: ProjectIn) -> Project:
    now = utcnow()
    with tx() as c:
        _validate_parent(c, p.parent_id)
        try:
            cur = c.execute(
                "INSERT INTO projects(slug,name,description,color,parent_id,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?)",
                (p.slug, p.name, p.description, p.color, p.parent_id or None, now, now),
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
    # parent_id == 0 means "clear" (make this a root again).
    if "parent_id" in fields:
        if fields["parent_id"] in (0, None):
            fields["parent_id"] = None
    with tx() as c:
        if "parent_id" in fields:
            _validate_parent(c, fields["parent_id"], self_id=project_id)
        fields["updated_at"] = utcnow()
        sets = ", ".join(f"{k} = ?" for k in fields)
        cur = c.execute(f"UPDATE projects SET {sets} WHERE id = ?", (*fields.values(), project_id))
        if cur.rowcount == 0:
            raise HTTPException(404)
        row = c.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    return _row_to_project(row)


@router.delete("/{project_id}", status_code=204)
def delete_project(project_id: int) -> None:
    with tx() as c:
        # Promote any children to roots (no orphaned references).
        c.execute("UPDATE projects SET parent_id = NULL WHERE parent_id = ?", (project_id,))
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
