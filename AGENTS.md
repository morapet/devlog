# AGENTS.md — guide for AIs working with devlog

This file is written for LLM agents (you) that need to drive devlog. There are two ways to talk to it:

- **MCP** — `devlog-mcp` exposes 18 tools over stdio. Use this whenever your client supports MCP. It does the URL plumbing for you and accepts project slugs instead of ids.
- **Raw HTTP** — every MCP tool is a thin wrapper around the REST API at `http://127.0.0.1:8765`. Curl/httpx works fine. Use this when MCP isn't available or you want batch / scripted operations.

For full surface details see [SPECIFICATION.md](SPECIFICATION.md). This document is for *operating* the system, not implementing it.

---

## 1. Setup

### Connect via MCP (preferred)

Add this to your MCP client config (Claude Code: `~/.claude.json`; Claude Desktop: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "devlog": {
      "command": "uv",
      "args": ["run", "--directory", "/absolute/path/to/devlog", "devlog-mcp"]
    }
  }
}
```

The backend (`uv run devlog`) must be running before any tool call. Health check: `GET /health` → `{"ok": true}`.

### Talk to it via HTTP (no MCP)

```bash
curl -s http://127.0.0.1:8765/health
# {"ok":true}
```

All endpoints are JSON in / JSON out, localhost only by default. Override the base URL with `DEVLOG_BASE_URL`. If the backend has `DEVLOG_PASSWORD` set (hosted setups), send `Authorization: Bearer <password>` on every request — `devlog-mcp` does this automatically when the same env var is set.

---

## 2. Core concepts in 60 seconds

- **Project** — top-level container. Has a `slug` (`^[a-z0-9][a-z0-9-]*$`) and optional `parent_id` for 2-level nesting (root → child, no grandchildren).
- **Item** — anything inside a project, distinguished by `kind`:
  - `task` — has `status` (todo / today / doing / blocked / someday / done / cancelled), `priority`, `due_at`, `body`
  - `note` — has `body` (markdown), optional `title`
  - `link` — has `url`, optional `display_label` (overrides fetched title), `is_pinned` (= bookmark), `is_read`
- **work_session** — time tracking row attached to a task. Opens automatically when a task enters `doing`, closes on leave.
- **attachment** — a drawing on an item, stored as drawio XML (for re-edit) + SVG (for render).
- **tag** — JSON array of strings on every item. Indexed in full-text search.

**Hard invariants** the backend enforces. You should rely on them, not duplicate them:

| Rule | Consequence |
|---|---|
| Single `doing` | Marking task X `doing` automatically demotes whatever was previously doing back to `today` (and closes its session). Just call `mark_doing` and trust it. |
| `parent_id` 2-level cap | API rejects 3-level chains; a project with children cannot become a child. |
| End-of-workday autopause | Open sessions running past the working-hours end (default 18:00 Mon-Fri local) are auto-closed at that boundary. Don't simulate this. |
| Version snapshot | Every PATCH that changes `title` or `body` snapshots the previous content. Restoring an old version is its own PATCH; that creates yet another version. |
| Refs auto-rebuild | After any save, the body is scanned for `#N` and `[[Title]]` and edges in `refs` are rewritten. Just write those tokens; backlinks come for free. |
| FTS auto-sync | Don't write to `items_fts`. Triggers handle inserts/updates/deletes including the `tags` column. |
| Cascade on project delete | Deleting a project deletes its items. Child projects get `parent_id = NULL` (promoted to roots), not deleted. |

---

## 3. Common workflows

Each is shown twice: once via MCP, once via HTTP. Pick the style your environment supports.

### 3.1 Create a project and set it as current

**MCP:**
```
create_project(slug="auth-refactor", name="Auth refactor", color="#3b82f6")
set_current_project(project="auth-refactor")
```

**HTTP:**
```bash
curl -s -X POST http://127.0.0.1:8765/projects \
  -H 'content-type: application/json' \
  -d '{"slug":"auth-refactor","name":"Auth refactor","color":"#3b82f6"}'

curl -s -X POST http://127.0.0.1:8765/projects/12/current
```

### 3.2 Nest a project (2-level only)

**MCP:**
```
create_project(slug="auth-jwt", name="JWT rotation", parent_id=12)
```

**HTTP:**
```bash
curl -s -X POST http://127.0.0.1:8765/projects \
  -H 'content-type: application/json' \
  -d '{"slug":"auth-jwt","name":"JWT rotation","parent_id":12}'
```

Trying to nest a child under another child returns `400 "parent must be a root project (2-level hierarchy only)"`. Make the parent a root first, or restructure.

### 3.3 Add a task, note, link

**MCP:**
```
create_task(project="auth-refactor", title="Rotate signing keys",
            status="today", priority="high",
            body="See [[JWT rotation]] for context. Blocked by #88.",
            tags=["security","ops"])

create_note(project="auth-refactor",
            title="Design notes",
            body="## Approach\n\nDual-issuer for 7 days, then flip.")

create_link(project="auth-refactor",
            url="https://datatracker.ietf.org/doc/rfc7519/",
            display_label="JWT spec",
            tags=["reference"],
            is_pinned=True)
```

**HTTP:**
```bash
curl -s -X POST http://127.0.0.1:8765/tasks \
  -H 'content-type: application/json' \
  -d '{"project_id":12,"title":"Rotate signing keys","status":"today","priority":"high","body":"See [[JWT rotation]] for context. Blocked by #88.","tags":["security","ops"]}'
```

`project_id` is required at the HTTP layer. The MCP wrapper accepts a slug and resolves it for you.

### 3.4 Start / pause / finish work on a task

```
mark_doing(item_id=42)        # automatically pauses whatever else was doing
# … work …
update_task(item_id=42, status="today")   # pause, keep on today's queue
# or
mark_done(item_id=42)         # finish — sets done_at
```

You never need to manually open/close work_sessions for the normal workflow — the status transitions do it. Use manual session creation only to log **retroactive** time (e.g. you forgot to start `doing`).

### 3.5 Retroactively log time

**MCP:**
```
add_session(task_id=42,
            started_at="2026-05-26T09:00:00+02:00",
            ended_at="2026-05-26T11:30:00+02:00")
```

**HTTP:**
```bash
curl -s -X POST http://127.0.0.1:8765/tasks/42/sessions \
  -H 'content-type: application/json' \
  -d '{"started_at":"2026-05-26T09:00:00+02:00","ended_at":"2026-05-26T11:30:00+02:00"}'
```

`ended_at` is optional — omit to open a session that ticks until the autopause loop or a manual close runs. Editing a session: `PATCH /sessions/{id}` with `started_at` and/or `ended_at`; `ended_at: ""` re-opens it.

Get totals for the list view:
```
GET /tasks/totals?project_id=12
# { "42": 9015.0, "43": 22.0, ... }
```

### 3.6 Search

```
search(q="jwt")                    # plain FTS prefix search
search(q="tag:security")           # exact tag match
search(q="tag:security rotation")  # AND of tag filter + free text
search(q="tag:work tag:urgent")    # multiple tag filters (all required)
```

Pure `tag:` queries skip FTS and sort by `updated_at DESC`. The FTS index covers `title + body + url + link_description + tags` so plain words can also hit a tag value.

### 3.7 Stats

```
stats(from_date="2026-05-25", to_date="2026-05-25")     # today
stats(from_date="2026-05-19", to_date="2026-05-25")     # last week
stats(project="auth-refactor", from_date="2026-05-01")  # month-to-date, one project
```

Response includes `total_seconds`, `by_day`, `by_task`, `by_project`, and an `activity` block with the ids of tasks done / tasks created / notes created / links created in the range.

**Time math is raw — no working-hours clipping.** The clipping setting is only used by the autopause loop to decide *when* to close open sessions; it does not affect reported time.

---

## 4. Cross-references in markdown bodies

Every task/note/link body is markdown. The renderer recognises three special tokens that are also stored as graph edges in `refs`:

| Token | Meaning |
|---|---|
| `#42` | Reference to item id 42. Title is auto-decorated in preview. |
| `[[Some Title]]` | Reference resolved by title (same project first, then global). |
| `![[drawing:N]]` | Inline drawio drawing N (see §5). |

After any save, the backend re-parses the body and rewrites the outbound edges. **Backlinks** on item 42 will automatically include anything that wrote `#42`. As an LLM you just write the tokens and let the system do the graph work.

---

## 5. Drawings — the tricky part

Drawings live in the `attachments` table with two payloads:

- `data_xml` — drawio mxfile XML. Loaded by the drawio editor when the user double-clicks the drawing in the UI. Required for re-edit.
- `data_svg` — rendered SVG. Inlined in the preview via Shadow DOM. Required for display.

You will almost always be authoring **both** at once: the SVG describes what the user sees, the XML describes what the drawio editor will load when they want to refine it.

### 5.1 Minimum viable drawio mxfile

```xml
<mxfile host="localhost">
  <diagram id="d1" name="Page-1">
    <mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" page="1"
                  pageScale="1" pageWidth="850" pageHeight="1100">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>

        <!-- A box: rounded rect with text -->
        <mxCell id="v1" value="Hello" vertex="1" parent="1"
                style="rounded=1;whiteSpace=wrap;html=1;
                       fillColor=#eff6ff;strokeColor=#3b82f6;
                       fontColor=#1e3a8a;fontSize=13;strokeWidth=2;">
          <mxGeometry x="40" y="40" width="160" height="60" as="geometry"/>
        </mxCell>

        <!-- Another box -->
        <mxCell id="v2" value="World" vertex="1" parent="1"
                style="rounded=1;whiteSpace=wrap;html=1;
                       fillColor=#ecfdf5;strokeColor=#10b981;
                       fontColor=#065f46;fontSize=13;strokeWidth=2;">
          <mxGeometry x="260" y="40" width="160" height="60" as="geometry"/>
        </mxCell>

        <!-- Edge with arrow -->
        <mxCell id="e1" value="" edge="1" parent="1" source="v1" target="v2"
                style="endArrow=classic;html=1;strokeColor=#475569;strokeWidth=1.5;">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>

      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
```

The same diagram as SVG (the *renderable* version) should match visually. You produce it yourself — drawio doesn't render headlessly. Use simple primitives:

```xml
<svg xmlns="http://www.w3.org/2000/svg" width="500" height="160" viewBox="0 0 500 160"
     font-family="Helvetica,Arial,sans-serif">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5"
            markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="#475569"/>
    </marker>
  </defs>
  <rect width="500" height="160" fill="white"/>
  <g>
    <rect x="40"  y="40" width="160" height="60" rx="8"
          fill="#eff6ff" stroke="#3b82f6" stroke-width="2"/>
    <text x="120" y="74" font-size="13" text-anchor="middle"
          fill="#1e3a8a" font-weight="600">Hello</text>
    <rect x="260" y="40" width="160" height="60" rx="8"
          fill="#ecfdf5" stroke="#10b981" stroke-width="2"/>
    <text x="340" y="74" font-size="13" text-anchor="middle"
          fill="#065f46" font-weight="600">World</text>
    <line x1="200" y1="70" x2="260" y2="70"
          stroke="#475569" stroke-width="1.5" marker-end="url(#arrow)"/>
  </g>
</svg>
```

### 5.2 Create / update / delete

There are now MCP tools for this. Prefer them when MCP is available:

```
create_attachment(item_id, data_xml=<mxfile>, data_svg=<svg>, title="Architecture")
update_attachment(attachment_id, data_xml=..., data_svg=...)
delete_attachment(attachment_id)
list_attachments(item_id)
get_attachment(attachment_id)
```

If MCP isn't available, the HTTP equivalents are:

```bash
# create
ATT=$(curl -s -X POST http://127.0.0.1:8765/items/24/attachments \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg xml "$MXFILE_XML" --arg svg "$SVG_TEXT" \
    '{kind:"drawing", title:"Architecture", data_xml:$xml, data_svg:$svg}')" \
  | jq -r .id)

# update (e.g. when refining)
curl -s -X PATCH http://127.0.0.1:8765/attachments/$ATT \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg xml "$NEW_XML" --arg svg "$NEW_SVG" \
    '{data_xml:$xml, data_svg:$svg}')"

# fetch raw SVG (no auth needed; mime is image/svg+xml)
curl -s http://127.0.0.1:8765/attachments/$ATT/svg

# delete
curl -s -X DELETE http://127.0.0.1:8765/attachments/$ATT
```

### 5.3 Embed in a note

After creating attachment N, embed it in the note's body so the preview renders it inline:

```markdown
## System architecture

![[drawing:42]]

Components: web UI, mac tray, MCP server …
```

Multiple drawings per note are fine — each `![[drawing:N]]` is replaced independently.

### 5.4 Python helper for batch authoring

A small generator for boxes-and-arrows diagrams. Copy this when you need to author several at once:

```python
import json, httpx
from html import escape

BASE = "http://127.0.0.1:8765"

def mxfile(title, vertices, edges):
    """vertices: list of (vid, label, x, y, w, h, fill, stroke, font)
       edges: list of (source_vid, target_vid, label='', dashed=False)"""
    cells = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>']
    for vid, label, x, y, w, h, fill, stroke, fc in vertices:
        style = (f"rounded=1;whiteSpace=wrap;html=1;fillColor={fill};"
                 f"strokeColor={stroke};fontColor={fc};fontSize=13;"
                 f"fontStyle=1;strokeWidth=2;")
        cells.append(
          f'<mxCell id="{vid}" value="{escape(label)}" style="{style}" '
          f'vertex="1" parent="1">'
          f'<mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry"/>'
          f'</mxCell>')
    for i, (s, t, label, dashed) in enumerate(edges, 1):
        style = ("endArrow=classic;html=1;strokeColor=#475569;"
                 "strokeWidth=1.5;fontSize=10;fontColor=#475569;")
        if dashed: style += "dashed=1;dashPattern=4 3;"
        cells.append(
          f'<mxCell id="e{i}" value="{escape(label) or ""}" style="{style}" '
          f'edge="1" parent="1" source="{s}" target="{t}">'
          f'<mxGeometry relative="1" as="geometry"/></mxCell>')
    body = "".join(cells)
    return (f'<mxfile host="localhost"><diagram id="{escape(title)}" '
            f'name="{escape(title)}"><mxGraphModel dx="1200" dy="800" '
            f'grid="1" gridSize="10" page="1" pageScale="1" pageWidth="850" '
            f'pageHeight="1100"><root>{body}</root></mxGraphModel></diagram></mxfile>')

def svg(width, height, vertices, edges):
    """Same vertices/edges; produce a matching SVG."""
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" '
             f'height="{height}" viewBox="0 0 {width} {height}" '
             f'font-family="Helvetica,Arial,sans-serif">',
             '<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" '
             'markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
             '<path d="M0,0 L10,5 L0,10 z" fill="#475569"/></marker></defs>',
             f'<rect width="{width}" height="{height}" fill="white"/>']
    centers = {}
    for vid, label, x, y, w, h, fill, stroke, fc in vertices:
        parts.append(f'<g transform="translate({x},{y})">'
            f'<rect width="{w}" height="{h}" rx="8" fill="{fill}" '
            f'stroke="{stroke}" stroke-width="2"/>'
            f'<text x="{w/2}" y="{h/2+5}" font-size="13" text-anchor="middle" '
            f'fill="{fc}" font-weight="600">{escape(label)}</text></g>')
        centers[vid] = (x + w/2, y + h/2)
    for s, t, label, dashed in edges:
        x1, y1 = centers[s]
        x2, y2 = centers[t]
        dash = ' stroke-dasharray="4,3"' if dashed else ""
        parts.append(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" '
            f'stroke="#475569" stroke-width="1.5" marker-end="url(#a)"{dash}/>')
        if label:
            parts.append(f'<text x="{(x1+x2)/2}" y="{(y1+y2)/2 - 6}" '
                f'font-size="10" text-anchor="middle" fill="#475569">'
                f'{escape(label)}</text>')
    parts.append("</svg>")
    return "\n".join(parts)


# usage:
vertices = [
    ("a", "Client",  40, 40, 140, 60, "#eff6ff", "#3b82f6", "#1e3a8a"),
    ("b", "Backend", 240, 40, 140, 60, "#f1f5f9", "#0f172a", "#0f172a"),
    ("c", "SQLite",  140, 160, 140, 60, "#fef2f2", "#ef4444", "#7f1d1d"),
]
edges = [("a", "b", "HTTP", False), ("b", "c", "", False)]

note_id = 24
with httpx.Client(base_url=BASE) as cx:
    r = cx.post(f"/items/{note_id}/attachments", json={
        "kind": "drawing",
        "title": "Architecture",
        "data_xml": mxfile("Architecture", vertices, edges),
        "data_svg": svg(420, 240, vertices, edges),
    })
    att_id = r.json()["id"]

# Now patch the note body to embed it
body = cx.get(f"/items/{note_id}").json()["body"] or ""
new_body = f"![[drawing:{att_id}]]\n\n" + body
cx.patch(f"/notes/{note_id}", json={"body": new_body})
```

### 5.5 Visual conventions used by devlog itself

If you want drawings to match the rest of the UI:

| Role | fill | stroke | text |
|---|---|---|---|
| neutral / info | `#eff6ff` | `#3b82f6` | `#1e3a8a` |
| warning / accent | `#fef3c7` | `#f59e0b` | `#92400e` |
| success | `#ecfdf5` | `#10b981` | `#065f46` |
| critical | `#fef2f2` | `#ef4444` | `#7f1d1d` |
| system / backend | `#f1f5f9` | `#0f172a` | `#0f172a` |
| async / meta | `#fdf4ff` | `#a855f7` | `#581c87` |
| muted | `#f1f5f9` | `#94a3b8` | `#334155` |

Edges: `#475569` stroke, width 1.5, classic arrow marker.

---

## 6. Pitfalls

| Pitfall | Avoid by |
|---|---|
| Manually clearing `doing` when starting another task | Don't. Just call `mark_doing(new_id)`. The backend does it atomically. |
| Hand-writing into `items_fts` | Don't. Triggers keep it consistent including `tags`. |
| Setting a deep tree | Only 2 levels are allowed. If you need more, model the third level as tags. |
| Assuming `current project` matters for data filtering | It doesn't — it's only a UI default for what to scope to and what to pre-select in capture. List endpoints accept explicit `project_id`. |
| Confusing `is_pinned` (bookmark) with `is_read` | They're independent. A read link can still be a bookmark. |
| Sending `null` for `parent_id` on PATCH | FastAPI's `exclude_unset` swallows it. Send `parent_id: 0` to clear (make root). |
| Drawio editor showing a stub even though the diagram looks right inline | The `data_xml` and `data_svg` are independent. If you only set the SVG, drawio shows an empty canvas. Always author both. |
| Generating one big multi-paragraph body that mentions many `#N` refs that don't exist yet | Refs to non-existent ids are silently dropped from `refs`. The text still renders (with no title decoration). Either create the referenced items first, or accept that the backlinks panel will be empty until you do. |
| Using HTTPS URLs in MCP tool calls — none of them need it | Backend is localhost only. |

---

## 7. Reading vs. writing — pick the cheapest endpoint

Don't fetch more than you need:

- For a quick check: `list_items(project=..., kind="task", status="doing", limit=10)` is much cheaper than fetching every project's items.
- `get_item(N)` includes `backlinks` and `refs_out`; the list endpoint doesn't.
- `task_totals()` is one round-trip; per-task `list_sessions` × N is N round-trips.
- `stats()` with a date range bundles per-task, per-day, per-project totals + activity.
- Plain markdown body and title come from `list_items`; you don't need `get_item` unless you want the cross-refs.

---

## 8. Where to look in the source

- HTTP endpoints — `src/devlog/api/*.py` (one router per group)
- Schema + migrations — `src/devlog/db.py`
- MCP wrapper — `src/devlog/mcp_server.py`
- Web markdown + drawing pipeline — `src/devlog/web/app.js`
- End-to-end smoke that exercises most workflows — `scripts/smoke_test.py`

`scripts/smoke_test.py` is a concise reference for the request/response shapes — when in doubt about a field, read it.
