"""Parse #id and [[title]] references out of item title+body and resolve to item ids."""
import re
import sqlite3

ID_REF = re.compile(r"(?<!\w)#(\d+)\b")
TITLE_REF = re.compile(r"\[\[([^\[\]\n]+?)\]\]")


def extract(*texts: str | None) -> tuple[set[int], set[str]]:
    ids: set[int] = set()
    titles: set[str] = set()
    for t in texts:
        if not t:
            continue
        ids.update(int(m.group(1)) for m in ID_REF.finditer(t))
        titles.update(m.group(1).strip() for m in TITLE_REF.finditer(t))
    return ids, titles


def resolve_titles(c: sqlite3.Connection, titles: set[str], project_id: int) -> set[int]:
    if not titles:
        return set()
    found: set[int] = set()
    for title in titles:
        # prefer same-project match, then global; first hit wins
        row = c.execute(
            "SELECT id FROM items WHERE title = ? AND project_id = ? LIMIT 1",
            (title, project_id),
        ).fetchone()
        if not row:
            row = c.execute("SELECT id FROM items WHERE title = ? LIMIT 1", (title,)).fetchone()
        if row:
            found.add(row["id"])
    return found


def rebuild_refs(c: sqlite3.Connection, from_id: int, project_id: int, title: str | None, body: str | None) -> None:
    ids, titles = extract(title, body)
    ids.update(resolve_titles(c, titles, project_id))
    ids.discard(from_id)
    # filter to existing ids
    if ids:
        placeholders = ",".join("?" * len(ids))
        rows = c.execute(f"SELECT id FROM items WHERE id IN ({placeholders})", tuple(ids)).fetchall()
        ids = {r["id"] for r in rows}
    c.execute("DELETE FROM refs WHERE from_id = ?", (from_id,))
    for to_id in ids:
        c.execute("INSERT OR IGNORE INTO refs(from_id, to_id) VALUES (?, ?)", (from_id, to_id))
