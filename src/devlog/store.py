"""Data access: row→model mapping and item read helpers."""
import json
import sqlite3

from .models import Item


def row_to_item(c: sqlite3.Connection, row: sqlite3.Row, with_refs: bool = False) -> Item:
    d = dict(row)
    d["tags"] = json.loads(d.get("tags") or "[]")
    d["is_read"] = bool(d.get("is_read") or 0)
    d["is_pinned"] = bool(d.get("is_pinned") or 0)
    item = Item.model_validate(d)
    if with_refs:
        item.refs_out = [r["to_id"] for r in c.execute("SELECT to_id FROM refs WHERE from_id = ?", (item.id,))]
        item.backlinks = [r["from_id"] for r in c.execute("SELECT from_id FROM refs WHERE to_id = ?", (item.id,))]
    return item


def get_item(c: sqlite3.Connection, item_id: int, with_refs: bool = True) -> Item | None:
    row = c.execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()
    return row_to_item(c, row, with_refs=with_refs) if row else None
