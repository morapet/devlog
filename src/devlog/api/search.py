from typing import Optional

from fastapi import APIRouter, Query

from ..db import conn
from ..models import Item
from ..store import row_to_item

router = APIRouter(prefix="/search", tags=["search"])


def _parse_query(q: str) -> tuple[str | None, list[str]]:
    """Split into (fts_query_or_None, exact_tag_filters).

    Tokens starting with 'tag:' become exact tag filters; remaining tokens
    become prefix-matched FTS terms.
    """
    tags: list[str] = []
    text_terms: list[str] = []
    for raw in q.split():
        if raw.lower().startswith("tag:") and len(raw) > 4:
            tags.append(raw[4:].strip().replace('"', ""))
        else:
            clean = raw.replace('"', "").strip()
            if clean:
                text_terms.append(clean)
    fts = " ".join(f'"{t}"*' for t in text_terms) if text_terms else None
    return fts, tags


@router.get("", response_model=list[Item])
def search(
    q: str = Query(min_length=1),
    project_id: Optional[int] = None,
    kind: Optional[str] = None,
    limit: int = 50,
) -> list[Item]:
    c = conn()
    fts_q, tag_filters = _parse_query(q)

    if not fts_q and not tag_filters:
        return []

    params: list = []
    if fts_q:
        sql = (
            "SELECT items.* FROM items_fts "
            "JOIN items ON items.id = items_fts.rowid "
            "WHERE items_fts MATCH ?"
        )
        params.append(fts_q)
        order = "rank"
    else:
        # Pure tag filter — no FTS needed.
        sql = "SELECT items.* FROM items WHERE 1=1"
        order = "items.updated_at DESC"

    if project_id is not None:
        sql += " AND items.project_id = ?"; params.append(project_id)
    if kind:
        sql += " AND items.kind = ?"; params.append(kind)
    for t in tag_filters:
        sql += " AND EXISTS (SELECT 1 FROM json_each(items.tags) WHERE value = ?)"
        params.append(t)

    sql += f" ORDER BY {order} LIMIT ?"
    params.append(limit)

    rows = c.execute(sql, params).fetchall()
    return [row_to_item(c, r) for r in rows]
