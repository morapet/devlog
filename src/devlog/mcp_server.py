"""MCP server for devlog.

Exposes the devlog HTTP API as MCP tools so an LLM client (Claude Desktop,
Claude Code, etc.) can create projects, tasks, notes, links, log time, and
search.

Run as a stdio MCP server:

    uv run devlog-mcp

or as a module:

    uv run python -m devlog.mcp_server

The server talks to the running devlog backend over HTTP (default
http://127.0.0.1:8765). Make sure `uv run devlog` is running first.
"""
from __future__ import annotations

import os
from typing import Any, Optional

import httpx
from mcp.server.fastmcp import FastMCP

BASE_URL = os.environ.get("DEVLOG_BASE_URL", "http://127.0.0.1:8765")

# Instructions surfaced to the LLM client at MCP `initialize`. Concise on
# purpose — full reference lives in AGENTS.md and SPECIFICATION.md in the repo.
INSTRUCTIONS = """\
devlog is a local-first task/note/link tracker with built-in time tracking and
drawio diagrams. Use these tools to record work and look things up. There is
ONE user and ONE backend at http://127.0.0.1:8765; no auth, no multi-tenant.

## Hard invariants (rely on these; don't simulate them)

- **Single 'doing'.** At most one task is `doing` system-wide. Call
  `mark_doing(item_id)` and trust the backend — it demotes whatever was
  previously doing to `today` and closes that task's open session atomically.
- **2-level project tree.** A project's `parent_id` must point to a root
  (parent_id IS NULL). Three-level chains are rejected. If you need depth,
  model the third level as tags.
- **Auto-pause at end of workday.** Open work_sessions running past the
  working-hours end (default 18:00 Mon–Fri local) are auto-closed by the
  backend at that boundary. Don't try to close them manually.
- **Refs auto-rebuild.** `#42` and `[[Title]]` tokens in any item body create
  graph edges in `refs` on save. Backlinks come for free — just write the
  tokens, don't manage edges.
- **Version snapshots.** Every PATCH that changes title or body snapshots the
  previous content. Restoring an old version is itself a PATCH (which creates
  yet another version).
- **Cascade.** Deleting a project deletes its items; child projects are
  promoted to roots (parent_id = NULL), not deleted.
- **Project arg accepts slug or id.** `create_task(project="auth", …)` is
  resolved by these tools to the int id.

## Common workflows

- New project: `create_project(slug, name)` then optionally `set_current_project(slug)`.
- Add work: `create_task(project, title, status="today", priority?, body?, tags?)`,
  `create_note(project, body, title?, tags?)`,
  `create_link(project, url, display_label?, tags?, is_pinned?)`.
- Track time: `mark_doing(item_id)` to start (auto-pauses whatever was doing),
  `update_task(item_id, status="today")` to pause, `mark_done(item_id)` to finish.
- Retroactive time: `add_session(task_id, started_at, ended_at?)` (ISO 8601 with TZ).
- Search: plain words use FTS; `tag:value` filters exact tags. Multiple
  tokens AND: `search(q="tag:work auth jwt")`.
- Stats: `stats(from_date, to_date, project?)` returns total_seconds + by_day
  + by_task + by_project + activity. Time math is RAW (no working-hours
  clipping in stats — that setting only drives auto-pause).

## Drawings (attachments)

Each drawing has TWO payloads stored together:
- `data_xml` — drawio mxfile XML; loaded by the drawio editor for re-edit.
- `data_svg` — rendered SVG; inlined in the markdown preview via Shadow DOM.

You author BOTH yourself (drawio doesn't render headlessly). The minimum
mxfile is `<mxfile><diagram><mxGraphModel><root><mxCell id="0"/><mxCell
id="1" parent="0"/>...vertices...edges...</root></mxGraphModel></diagram></mxfile>`.
See AGENTS.md §5.4 for a copy-pastable Python helper that builds
boxes-and-arrows mxfile + matching SVG from `(vertices, edges)` lists.

Tools:
- `list_attachments(item_id)`
- `create_attachment(item_id, data_xml, data_svg, title?)` → returns the new id
- `update_attachment(attachment_id, data_xml?, data_svg?, title?)`
- `delete_attachment(attachment_id)`

To make the drawing show inline in a note, embed `![[drawing:N]]` in the
note body via `update_note(item_id, body=...)`.

## Cheapest endpoint for a question

- "what am I doing right now?" → `list_items(kind='task', status='doing', limit=1)`
- "tasks due today across projects" → `list_items(kind='task', status='today')`
- "find anything about X" → `search(q="X", limit=20)`
- "how much time on task N?" → `task_totals()` or `list_sessions(task_id=N)`
- "what did I do this week?" → `stats(from_date=monday, to_date=today)`
- "is this item linked anywhere?" → `get_item(N)` (includes `backlinks` + `refs_out`)

Visual color palette for drawings (so generated diagrams match the UI):
info  #eff6ff/#3b82f6/#1e3a8a, success #ecfdf5/#10b981/#065f46,
warning #fef3c7/#f59e0b/#92400e, critical #fef2f2/#ef4444/#7f1d1d,
system #f1f5f9/#0f172a/#0f172a, async #fdf4ff/#a855f7/#581c87,
muted #f1f5f9/#94a3b8/#334155. Edges: stroke #475569, width 1.5.

Full reference: AGENTS.md (operating guide) and SPECIFICATION.md (full spec)
in the devlog repo.
"""

mcp = FastMCP("devlog", instructions=INSTRUCTIONS)

# A single shared client. httpx.Client is thread-safe for use across requests.
_client = httpx.Client(base_url=BASE_URL, timeout=20.0)


def _req(method: str, path: str, **kwargs) -> Any:
    r = _client.request(method, path, **kwargs)
    if r.status_code == 204:
        return {"ok": True}
    if not r.is_success:
        # Surface a useful error so the LLM can react.
        try:
            detail = r.json()
        except Exception:
            detail = r.text
        raise RuntimeError(f"HTTP {r.status_code} {path}: {detail}")
    if r.headers.get("content-type", "").startswith("application/json"):
        return r.json()
    return r.text


def _resolve_project(project: str | int) -> int:
    """Accept either a numeric id or a slug; return the int id."""
    if isinstance(project, int):
        return project
    s = str(project).strip()
    if s.isdigit():
        return int(s)
    for p in _req("GET", "/projects"):
        if p["slug"] == s or p["name"].lower() == s.lower():
            return int(p["id"])
    raise ValueError(f"Project not found: {project!r}")


# ----------------------- Projects -----------------------

@mcp.tool()
def list_projects() -> list[dict]:
    """List all projects in devlog."""
    return _req("GET", "/projects")


@mcp.tool()
def create_project(
    slug: str,
    name: str,
    description: Optional[str] = None,
    color: Optional[str] = None,
) -> dict:
    """Create a new project.

    Args:
        slug: lowercase identifier matching ^[a-z0-9][a-z0-9-]*$ (e.g. "devlog").
        name: human-friendly display name.
        description: optional description.
        color: optional hex color like "#3b82f6".
    """
    payload = {"slug": slug, "name": name, "description": description, "color": color}
    return _req("POST", "/projects", json=payload)


@mcp.tool()
def set_current_project(project: str) -> dict:
    """Mark a project (by slug or id) as the current/active project."""
    pid = _resolve_project(project)
    return _req("POST", f"/projects/{pid}/current")


@mcp.tool()
def get_current_project() -> Optional[dict]:
    """Return the currently active project, or null."""
    return _req("GET", "/projects/current/resolve")


# ----------------------- Items: create -----------------------

@mcp.tool()
def create_task(
    project: str,
    title: str,
    status: str = "todo",
    priority: Optional[str] = None,
    body: Optional[str] = None,
    tags: Optional[list[str]] = None,
    due_at: Optional[str] = None,
) -> dict:
    """Create a task in the given project.

    Args:
        project: project slug or id.
        title: task title (required).
        status: one of todo, today, doing, blocked, someday, done, cancelled.
        priority: low, normal, or high.
        body: markdown body (optional).
        tags: list of tag strings.
        due_at: ISO date/datetime (optional).
    """
    payload = {
        "project_id": _resolve_project(project),
        "title": title,
        "status": status,
        "priority": priority,
        "body": body,
        "tags": tags or [],
        "due_at": due_at,
    }
    return _req("POST", "/tasks", json=payload)


@mcp.tool()
def create_note(
    project: str,
    body: str,
    title: Optional[str] = None,
    tags: Optional[list[str]] = None,
) -> dict:
    """Create a markdown note attached to the given project.

    Args:
        project: project slug or id.
        body: markdown content (required).
        title: optional title.
        tags: list of tag strings.
    """
    payload = {
        "project_id": _resolve_project(project),
        "title": title,
        "body": body,
        "tags": tags or [],
    }
    return _req("POST", "/notes", json=payload)


@mcp.tool()
def create_link(
    project: str,
    url: str,
    annotation: Optional[str] = None,
    tags: Optional[list[str]] = None,
    is_read: bool = False,
    fetch_metadata: bool = True,
) -> dict:
    """Save a link to the given project.

    Args:
        project: project slug or id.
        url: full URL.
        annotation: free-form note about the link.
        tags: list of tag strings.
        is_read: mark as already read.
        fetch_metadata: if True, the backend tries to fetch the page's title and OG description.
    """
    payload = {
        "project_id": _resolve_project(project),
        "url": url,
        "annotation": annotation,
        "tags": tags or [],
        "is_read": is_read,
        "fetch_metadata": fetch_metadata,
    }
    return _req("POST", "/links", json=payload)


# ----------------------- Items: read / update / delete -----------------------

@mcp.tool()
def list_items(
    project: Optional[str] = None,
    kind: Optional[str] = None,
    status: Optional[str] = None,
    is_read: Optional[bool] = None,
    is_pinned: Optional[bool] = None,
    limit: int = 100,
) -> list[dict]:
    """List items (tasks/notes/links) with optional filters.

    Args:
        project: slug or id to scope; omit for global.
        kind: 'task' | 'note' | 'link' to filter.
        status: task status filter (e.g. 'doing', 'today').
        is_read: filter links by read flag.
        is_pinned: filter for bookmarked links.
        limit: max results (default 100).
    """
    params: dict[str, Any] = {"limit": limit}
    if project is not None:
        params["project_id"] = _resolve_project(project)
    if kind:
        params["kind"] = kind
    if status:
        params["status"] = status
    if is_read is not None:
        params["is_read"] = str(is_read).lower()
    if is_pinned is not None:
        params["is_pinned"] = str(is_pinned).lower()
    return _req("GET", "/items", params=params)


@mcp.tool()
def get_item(item_id: int) -> dict:
    """Fetch a single item with all fields and backlinks/refs_out."""
    return _req("GET", f"/items/{item_id}")


@mcp.tool()
def update_task(
    item_id: int,
    title: Optional[str] = None,
    status: Optional[str] = None,
    priority: Optional[str] = None,
    body: Optional[str] = None,
    tags: Optional[list[str]] = None,
    blocked_reason: Optional[str] = None,
    due_at: Optional[str] = None,
) -> dict:
    """Update fields on a task. Only fields you pass are changed."""
    payload = {k: v for k, v in {
        "title": title, "status": status, "priority": priority, "body": body,
        "tags": tags, "blocked_reason": blocked_reason, "due_at": due_at,
    }.items() if v is not None}
    return _req("PATCH", f"/tasks/{item_id}", json=payload)


@mcp.tool()
def update_note(
    item_id: int,
    title: Optional[str] = None,
    body: Optional[str] = None,
    tags: Optional[list[str]] = None,
) -> dict:
    """Update fields on a note."""
    payload = {k: v for k, v in {"title": title, "body": body, "tags": tags}.items() if v is not None}
    return _req("PATCH", f"/notes/{item_id}", json=payload)


@mcp.tool()
def update_link(
    item_id: int,
    title: Optional[str] = None,
    annotation: Optional[str] = None,
    tags: Optional[list[str]] = None,
    is_read: Optional[bool] = None,
    is_pinned: Optional[bool] = None,
) -> dict:
    """Update fields on a link."""
    payload = {k: v for k, v in {
        "title": title, "annotation": annotation, "tags": tags,
        "is_read": is_read, "is_pinned": is_pinned,
    }.items() if v is not None}
    return _req("PATCH", f"/links/{item_id}", json=payload)


@mcp.tool()
def delete_item(item_id: int) -> dict:
    """Delete an item (task, note, or link). Cascades to sessions/versions/attachments."""
    return _req("DELETE", f"/items/{item_id}")


# ----------------------- Sessions (time tracking) -----------------------

@mcp.tool()
def list_sessions(task_id: int) -> list[dict]:
    """List all work sessions for a task with durations."""
    return _req("GET", f"/tasks/{task_id}/sessions")


@mcp.tool()
def add_session(task_id: int, started_at: str, ended_at: Optional[str] = None) -> dict:
    """Manually log a work session for a task.

    Args:
        task_id: the task's id.
        started_at: ISO 8601 timestamp with timezone (e.g. '2026-05-22T09:00:00+02:00').
        ended_at: ISO timestamp when stopped; omit for an open/ongoing session.
    """
    return _req("POST", f"/tasks/{task_id}/sessions", json={"started_at": started_at, "ended_at": ended_at})


@mcp.tool()
def task_totals(project: Optional[str] = None) -> dict[int, float]:
    """Total tracked seconds per task id. Optionally scoped to one project."""
    params = {}
    if project is not None:
        params["project_id"] = _resolve_project(project)
    return _req("GET", "/tasks/totals", params=params)


# ----------------------- Attachments (drawings) -----------------------

@mcp.tool()
def list_attachments(item_id: int) -> list[dict]:
    """List drawings (and other attachments) on an item.

    Each entry is a summary that omits the bulky data_xml field — use
    get_attachment to fetch the full payload for re-editing.
    """
    return _req("GET", f"/items/{item_id}/attachments")


@mcp.tool()
def get_attachment(attachment_id: int) -> dict:
    """Fetch an attachment in full, including data_xml (drawio mxfile) and data_svg."""
    return _req("GET", f"/attachments/{attachment_id}")


@mcp.tool()
def create_attachment(
    item_id: int,
    data_xml: str,
    data_svg: str,
    title: Optional[str] = None,
    kind: str = "drawing",
) -> dict:
    """Attach a drawing to an item (task / note / link). Returns the new attachment.

    You must author BOTH payloads:
      - data_xml: drawio mxfile XML, used by the drawio editor for re-edit.
      - data_svg: rendered SVG, inlined in the markdown preview.

    Minimum mxfile skeleton:
      <mxfile><diagram id="d1" name="Page-1"><mxGraphModel ...><root>
        <mxCell id="0"/><mxCell id="1" parent="0"/>
        <mxCell id="v1" value="X" vertex="1" parent="1"
          style="rounded=1;whiteSpace=wrap;html=1;fillColor=#eff6ff;strokeColor=#3b82f6;">
          <mxGeometry x="40" y="40" width="160" height="60" as="geometry"/>
        </mxCell>
        <mxCell id="e1" edge="1" parent="1" source="v1" target="v2"
          style="endArrow=classic;html=1;strokeColor=#475569;">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
      </root></mxGraphModel></diagram></mxfile>

    After creating attachment id N, embed it in the item's body via:
      update_note(item_id, body="... ![[drawing:N]] ...")
    (or update_task / update_link as appropriate).
    """
    return _req("POST", f"/items/{item_id}/attachments", json={
        "kind": kind,
        "title": title,
        "data_xml": data_xml,
        "data_svg": data_svg,
    })


@mcp.tool()
def update_attachment(
    attachment_id: int,
    data_xml: Optional[str] = None,
    data_svg: Optional[str] = None,
    title: Optional[str] = None,
) -> dict:
    """Update a drawing's XML, SVG, or title. Pass only the fields you want changed."""
    payload = {k: v for k, v in {"data_xml": data_xml, "data_svg": data_svg, "title": title}.items() if v is not None}
    return _req("PATCH", f"/attachments/{attachment_id}", json=payload)


@mcp.tool()
def delete_attachment(attachment_id: int) -> dict:
    """Delete an attachment. Note: the ![[drawing:N]] token in any item body is NOT
    automatically removed — clean it up via update_note / update_task / update_link
    if needed."""
    return _req("DELETE", f"/attachments/{attachment_id}")


# ----------------------- Search & stats -----------------------

@mcp.tool()
def search(
    q: str,
    project: Optional[str] = None,
    kind: Optional[str] = None,
    limit: int = 30,
) -> list[dict]:
    """Full-text search across items. Supports `tag:value` tokens for exact tag filters.

    Examples:
      q="jwt"                       → text match anywhere
      q="tag:work auth"             → items tagged 'work' AND containing 'auth'
      q="tag:urgent"                → items tagged 'urgent', sorted by recent
    """
    params: dict[str, Any] = {"q": q, "limit": limit}
    if project is not None:
        params["project_id"] = _resolve_project(project)
    if kind:
        params["kind"] = kind
    return _req("GET", "/search", params=params)


@mcp.tool()
def stats(
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    project: Optional[str] = None,
) -> dict:
    """Aggregate time stats. Range defaults to the last 7 days.

    Args:
        from_date: YYYY-MM-DD start (inclusive). Omit for default.
        to_date: YYYY-MM-DD end (inclusive). Omit for today.
        project: optional project slug/id to scope.
    """
    params: dict[str, Any] = {}
    if from_date:
        params["from"] = from_date
    if to_date:
        params["to"] = to_date
    if project is not None:
        params["project_id"] = _resolve_project(project)
    return _req("GET", "/stats", params=params)


# ----------------------- Entry point -----------------------

def run() -> None:
    """Console-script entry point — run the MCP server over stdio."""
    mcp.run()


if __name__ == "__main__":
    run()
