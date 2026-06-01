# devlog — full specification

This document specifies the devlog system in enough detail to be reimplemented from scratch. Where multiple valid choices exist, the *required behavior* is described first, followed by the *current implementation* in parentheses; only the required behavior is normative.

---

## 1. Purpose

devlog is a local-first developer task / note / link tracker with built-in time tracking, freehand diagrams (drawio), rich markdown, full-text search, and an MCP server so an LLM can drive everything. A single user runs it on their own machine; the backend talks to a single SQLite file. No authentication, no multi-tenant concerns.

The system has these surfaces:

1. **HTTP API** — the source of truth, REST + JSON, served on `127.0.0.1:8765`.
2. **Web UI** — vanilla JS SPA served by the same process at `/`.
3. **macOS menu-bar tray** — native SwiftUI client.
4. **Linux tray** — Python/GTK client (libayatana-appindicator).
5. **MCP server** — stdio JSON-RPC, exposes the API as ~18 tools.

The web UI is browse-and-edit. The trays are read-and-quick-act (start/done/pause + open bookmarks). The MCP server is for headless creation of projects/tasks/notes/links/sessions and search.

---

## 2. Required behaviors (invariants)

These must hold across any reimplementation:

| Invariant | Description |
|---|---|
| **Single doing** | At most one task system-wide has `status = 'doing'`. Marking a different task `doing` automatically demotes the previous one to `today`. |
| **2-level project tree** | A project's `parent_id` may point to a root (parent_id IS NULL) project only. A 3-level chain is rejected. A project with children cannot itself become a child. |
| **Working-hours autopause** | A background job (≈ every 60 s) closes any open work-session at the end-of-workday for its start day's local timezone and moves the task back to `today`. End-of-workday is read from settings (default 18:00 Mon–Fri, local). Sessions started on non-working days are not auto-paused. |
| **Version snapshot** | Every successful PATCH to a task / note / link that changes `title` *or* `body` writes a row to `item_versions`. Creation writes the initial v1. |
| **Refs are rebuilt on save** | After any create/update of an item, parse `#<id>` and `[[Title]]` from `title + body`, resolve to existing item ids (title match prefers same project then global, single hit wins), and rewrite the row's outbound edges in `refs`. |
| **FTS stays in sync** | An FTS5 virtual table over `items.title, body, url, link_description, tags` is kept in sync via AFTER INSERT/UPDATE/DELETE triggers. |
| **Single-doing time tracking** | Marking a task `doing` opens a `work_session(item_id, started_at, ended_at IS NULL)`. Leaving `doing` (any reason) closes it with `ended_at = now`. |
| **Cascade on project delete** | Deleting a project deletes all its items (and via FK their sessions / versions / attachments / refs). Children projects are promoted to roots (parent_id = NULL), not deleted. |
| **Localhost only** | The HTTP server binds 127.0.0.1 by default. No auth. (Override via `DEVLOG_HOST`.) |

---

## 3. Domain model

```
project ──< item (kind = task | note | link) ──< work_session    (tasks only)
                                              │
                                              ├──< item_version  (title/body history)
                                              ├──< attachment    (drawings)
                                              └──< refs.from_id  ────> refs.to_id (items)
```

### 3.1 project

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | autoincrement |
| slug | TEXT UNIQUE NOT NULL | `^[a-z0-9][a-z0-9-]*$`, max 64 |
| name | TEXT NOT NULL | display name |
| description | TEXT | nullable |
| color | TEXT | nullable, hex like `#3b82f6` |
| parent_id | INTEGER NULL → projects.id | ON DELETE SET NULL, 2-level cap enforced in API |
| created_at | TEXT NOT NULL | ISO-8601 UTC |
| updated_at | TEXT NOT NULL | ISO-8601 UTC |

### 3.2 item

A single table with a `kind` discriminator. The shared id space lets `#42` references work regardless of kind.

| Column | Type | Used for |
|---|---|---|
| id | INTEGER PK | all |
| kind | TEXT NOT NULL CHECK IN ('task','note','link') | all |
| project_id | INTEGER NOT NULL FK projects.id ON DELETE CASCADE | all |
| title | TEXT | all (nullable for notes / links) |
| body | TEXT | all (markdown) |
| tags | TEXT NOT NULL DEFAULT `'[]'` | all (JSON array of strings) |
| created_at | TEXT NOT NULL | all |
| updated_at | TEXT NOT NULL | all |
| status | TEXT CHECK IN ('todo','today','doing','blocked','someday','done','cancelled') | task |
| due_at | TEXT | task |
| priority | TEXT CHECK IN ('low','normal','high') | task |
| blocked_reason | TEXT | task |
| done_at | TEXT | task (set when status → 'done') |
| doing_started_at | TEXT | task (set when status → 'doing') |
| url | TEXT | link |
| link_description | TEXT | link (auto-fetched OG description) |
| favicon_url | TEXT | link |
| is_read | INTEGER NOT NULL DEFAULT 0 | link |
| is_pinned | INTEGER NOT NULL DEFAULT 0 | link (= bookmark) |
| display_label | TEXT | link (user-chosen label that overrides the fetched title) |

Indexes: `(project_id, kind)`, `(kind, status)`, `(updated_at DESC)`, partial `(is_pinned) WHERE is_pinned = 1`.

### 3.3 refs

`from_id → to_id` directed edges between items. Rebuilt for `from_id` after any item save. `(from_id, to_id)` is the primary key.

### 3.4 work_sessions

| Column | Notes |
|---|---|
| id | PK |
| item_id | FK → items.id ON DELETE CASCADE |
| started_at | ISO UTC, NOT NULL |
| ended_at | ISO UTC, NULL while open |

Partial index `(item_id) WHERE ended_at IS NULL` for the autopause scan.

### 3.5 item_versions

| Column | Notes |
|---|---|
| id | PK |
| item_id | FK → items.id ON DELETE CASCADE |
| title | snapshot |
| body | snapshot |
| saved_at | ISO UTC |

Index `(item_id, saved_at DESC)`.

### 3.6 attachments

| Column | Notes |
|---|---|
| id | PK |
| item_id | FK → items.id ON DELETE CASCADE |
| kind | TEXT NOT NULL DEFAULT `'drawing'` |
| title | TEXT nullable |
| data_xml | TEXT (drawio mxfile XML — used for re-edit) |
| data_svg | TEXT (rendered SVG — served inline) |
| created_at / updated_at | ISO UTC |

### 3.7 settings (key/value)

Used for `current_project_id` and `working_hours`. Both stored as TEXT values (JSON for working_hours).

`working_hours` shape:
```json
{ "start": "08:00", "end": "18:00", "days": [1,2,3,4,5], "tz": "local" }
```
`days` are ISO weekdays (1=Mon … 7=Sun). `tz` is `"local"` or an IANA name.

### 3.8 items_fts (virtual table)

FTS5 over the columns: `title, body, url, link_description, tags`. `tags` is concatenated (`group_concat(value, ' ')` from `json_each(items.tags)`) when written by triggers. Tokenizer: `unicode61 remove_diacritics 2`.

---

## 4. HTTP API

JSON in / JSON out, `application/json`. All endpoints are unauthenticated and bound to `127.0.0.1` by default.

### 4.1 Projects

| Method | Path | Notes |
|---|---|---|
| GET | `/projects` | array of projects ordered by name |
| POST | `/projects` | body `{slug, name, description?, color?, parent_id?}` → 201 project |
| GET | `/projects/{id}` | 200/404 |
| PATCH | `/projects/{id}` | body subset of `{name, description, color, parent_id}`; `parent_id: 0` clears (root) |
| DELETE | `/projects/{id}` | 204; cascades items, promotes child projects to roots |
| POST | `/projects/{id}/current` | 204; sets settings.current_project_id |
| GET | `/projects/current/resolve` | 200 project or `null` |

Parent-validation errors (400): "a project cannot be its own parent", "parent project N does not exist", "parent must be a root project (2-level hierarchy only)", "this project has children, so it cannot itself become a child".

### 4.2 Items: create per kind

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/tasks` | `{project_id, title, status?, priority?, body?, tags?, due_at?}` | 201 item |
| POST | `/notes` | `{project_id, title?, body, tags?}` | 201 item |
| POST | `/links` | `{project_id, url, title?, display_label?, annotation?, tags?, is_read?, fetch_metadata?}` | 201 item; if `fetch_metadata: true` (default) the server tries to fetch OG title + description + favicon |

On create with `status: 'doing'`, the server first runs the single-doing protocol (closes the current doing task's open session, demotes it to `today`) before insert.

### 4.3 Items: read / update / delete

| Method | Path | Notes |
|---|---|---|
| GET | `/items` | query params: `project_id, kind, status, is_read, is_pinned, limit (default 200), offset` |
| GET | `/items/{id}` | includes `backlinks: int[]` and `refs_out: int[]` |
| PATCH | `/tasks/{id}` | subset of task fields |
| PATCH | `/notes/{id}` | subset of note fields |
| PATCH | `/links/{id}` | subset of link fields (incl. `is_pinned`, `display_label`) |
| POST | `/tasks/{id}/doing` | shortcut for status → doing |
| POST | `/tasks/{id}/done` | shortcut for status → done |
| DELETE | `/items/{id}` | 204 |
| GET | `/items/{id}/versions` | array, newest first |

### 4.4 Sessions

| Method | Path | Notes |
|---|---|---|
| GET | `/tasks/{id}/sessions` | array with `duration_seconds, is_open` |
| POST | `/tasks/{id}/sessions` | body `{started_at, ended_at?}` (ISO); 201 |
| PATCH | `/sessions/{sid}` | body subset of `{started_at, ended_at}`. `ended_at: ""` re-opens it (sets ended_at NULL). |
| DELETE | `/sessions/{sid}` | 204 |
| GET | `/tasks/totals` | optional `project_id`; returns `{ task_id: total_seconds }` for the JOIN of work_sessions over kind='task' |

### 4.5 Attachments (drawings)

| Method | Path |
|---|---|
| GET | `/items/{id}/attachments` (summary, omits bulky XML) |
| POST | `/items/{id}/attachments` (body: `{kind, title, data_xml, data_svg}`) |
| GET | `/attachments/{aid}` (full XML + SVG) |
| GET | `/attachments/{aid}/svg` (raw `Content-Type: image/svg+xml`) |
| PATCH | `/attachments/{aid}` (subset of `{title, data_xml, data_svg}`) |
| DELETE | `/attachments/{aid}` |

### 4.6 Search

`GET /search?q=<query>&project_id=&kind=&limit=50`

Query syntax:
- Plain words → FTS prefix match across title/body/url/link_description/tags.
- `tag:<value>` tokens → exact tag filter (via `json_each(items.tags)`), AND-combined with other tokens.
- Pure tag-only query (no free-text tokens) → ranks by `items.updated_at DESC` instead of FTS rank.

### 4.7 Stats

`GET /stats?from=YYYY-MM-DD&to=YYYY-MM-DD&project_id=`

- `from`/`to` are inclusive local dates; default = trailing 7 days.
- Time math is **raw** (no working-hours clipping). Sessions are bucketed by their start's local date; cross-midnight sessions are split.

Response:
```json
{
  "range_from": "2026-05-19T22:00:00+00:00",
  "range_to":   "2026-05-26T21:59:59+00:00",
  "working_hours": { ... },
  "total_seconds": 65469.0,
  "by_day":     [{ "date": "2026-05-21", "seconds": 14403.0 }, ...],
  "by_task":    [{ "item_id": 2, "title": "...", "project_id": 1, "status": "done", "seconds": 47625.0 }, ...],
  "by_project": { "1": 65469.0 },
  "activity": {
    "tasks_done":    [int],
    "tasks_created": [int],
    "notes_created": [int],
    "links_created": [int]
  }
}
```

`GET /stats/periods` returns `{weeks: WeekPeriod[], months: MonthPeriod[]}` — only periods that have logged time. Used by the Home view to populate the week/month dropdowns.

### 4.8 Settings

| Method | Path |
|---|---|
| GET | `/settings/working_hours` |
| PUT | `/settings/working_hours` body matches the JSON shape in §3.7 |

### 4.9 Static web UI

`GET /` → `index.html`. `GET /static/*` → the `web/` folder including the vendored drawio under `/static/vendor/drawio/`.

### 4.10 Health

`GET /health` → `{"ok": true}`.

---

## 5. Business-logic details

### 5.1 Single-doing transition

When `status` becomes `doing` (whether on create or update), the server in a single transaction:

1. For every other task currently `doing`:
   - Set `status = 'today'`, `doing_started_at = NULL`, `updated_at = now`.
2. Close any open work_session (`ended_at = now`).
3. For the target task, set `doing_started_at = now` and INSERT a new open session.

When `status` becomes anything else (including `done`), if the previous status was `doing`, close any open session for that task.

When `status` becomes `done`, set `done_at = now`; clear `done_at` if leaving done.

### 5.2 Autopause

Every 60 s the backend runs:

```pseudo
load working_hours
for each work_session WHERE ended_at IS NULL:
    start_local := session.started_at in working_hours.tz
    if start_local.iso_weekday NOT IN working_hours.days: continue
    end_of_workday := combine(start_local.date, working_hours.end, tz)
    if now_utc > end_of_workday:
        UPDATE work_sessions SET ended_at = end_of_workday
        UPDATE items SET status = 'today', doing_started_at = NULL
            WHERE id = session.item_id AND status = 'doing'
```

Important: `ended_at` is the **end-of-workday on the session's local start date**, not "now" — so the recorded time tops out at e.g. 18:00 instead of whenever the background loop happened to fire.

The same pass runs once at server startup so any task left `doing` across a restart gets cleaned up.

### 5.3 Refs parsing

After any insert or update where `title` or `body` changed:

1. Run `(?<!\w)#(\d+)\b` over `title + body` → set of int ids.
2. Run `\[\[([^\[\]\n]+?)\]\]` → set of titles. Resolve each:
   - Prefer first item with matching `title` in same project.
   - Else first item with matching `title` globally.
   - Else drop.
3. Filter ids to those that actually exist in `items`. Exclude self.
4. `DELETE FROM refs WHERE from_id = self`, then `INSERT OR IGNORE` each `(from_id, to_id)`.

### 5.4 Link metadata fetcher

On `POST /links` with `fetch_metadata: true` (default), the server makes a 5-second-timeout GET to the URL, parses HTML, and extracts (in order):

- Title: `og:title` → `twitter:title` → `<title>`
- Description: `og:description` → `<meta name="description">` → `twitter:description`
- Favicon: `<link rel="icon">` / `shortcut icon` / `apple-touch-icon`; fallback to `{scheme}://{host}/favicon.ico`

Failure → leave fields NULL. Don't fail the request.

### 5.5 Version history

On any successful `_update` that changed `title` or `body`, after the UPDATE statement run:

```sql
INSERT INTO item_versions(item_id, title, body, saved_at)
VALUES (?, ?, ?, now)
```

On item creation, also insert v1 with the initial state. The history is unbounded (no pruning).

---

## 6. Web UI

Vanilla JS + Tailwind via Play CDN + markdown-it (+ plugins) + highlight.js + Mermaid. No build step.

### 6.1 Layout

```
┌─ header (title + current project) ────────────────────┐
│                                                       │
├─ sidebar ──┬─ main pane (split) ───────────────────────┤
│            │                                          │
│  + New     │  ┌─ list-pane ──┬─ splitter ─ detail ──┐ │
│  Home      │  │ tabs/filters │  ▏                   │ │
│  Projects  │  │ items list   │  ▏ item editor       │ │
│  ├ Root1   │  │              │  ▏                   │ │
│  │ └ Child │  │              │  ▏                   │ │
│  └ Root2   │  └──────────────┴────────────────────────┘ │
└────────────┴───────────────────────────────────────────┘
```

- `+ New` opens the capture modal (tabs Task/Note/Link). `Esc` cancels. `Tab` / `Shift+Tab` cycles the tabs (only when focus is not in a form field).
- The sidebar shows projects as a 2-level tree (root, then indented children).
- The vertical splitter between list and detail is draggable, min 180px / max 900px, double-click resets to 320px, persisted in `localStorage["listPaneWidth"]`.

### 6.2 Home

Default landing view. Order:
1. **Bookmarks** — pinned links grouped per project. Current project first. Each tile: favicon + label + host. Click opens link in new tab; small ✕ unpins. Empty state nudges to bookmark a link.
2. **Doing** — global, all `doing` tasks across projects. Each row: pulsing amber dot, title, project, live ticking elapsed timer (updates every second), `⏸ Today` and `✓ Done` buttons.
3. **Today** — all tasks with `status: today`, each row has `▶ Start` and `✓ Done`. Click row title → opens detail.
4. **Search** — inline search input + results. Typing fires `/search` (200 ms debounce). Hits are clickable.
5. **Stats** — three cards (Today / This week / This month). Each card has a `<select>` populated from `/stats/periods` so the user can switch to any past logged week/month. Below the cards, three "Top tasks" lists (≤ 5 each).

Home refreshes every 15 s if no drafts are dirty.

### 6.3 List view

Triggered by selecting a project or a pseudo-view. Tabs `Tasks | Notes | Links`. Header row offers:
- **Sort** — by status (default for tasks), priority, updated, created, title, time_spent, due
- **Group** — none / status / priority / tag
- **Filter** — in-list substring filter against title + body + url + tags

Server returns up to 500 items; sort/group/filter happen client-side. Rows show title, snippet, project chip, status/priority chips, and `⏱ Hh MMm` time chip for tasks (fed by `/tasks/totals`).

### 6.4 Detail pane

For tasks/notes/links: header (id · kind · project · `updated …` · 👁 Focus toggle), title (editable input for task/note; rendered link header for links), meta row (status/priority/blocked-reason for tasks; display_label + Read + Bookmark for links), tags editor, time-spent block (tasks only), editor (textarea + markdown preview side by side), actions row (autosave status + History dropdown + Delete), then References + Backlinks panels.

**Focus mode** (toggle button in header, persisted via `localStorage["focusMode"]`):
- Hides meta row, tags editor, time block, action row, drawio Insert button, and the textarea.
- The preview takes a centered max-w-3xl column.
- Cross-refs stay clickable; clicking a drawing opens a lightbox (95vw × 95vh, max 1600 × 1000, scaled to fit, escape/click-outside closes).
- The Edit toggle in the header reverts to full mode.

**Autosave** — text inputs (title, body, blocked_reason, link display_label/annotation, tag chips) use a 700 ms debounce. Selects (status, priority, is_read, is_pinned) save instantly and re-render. Save status indicator cycles `Modified → Saving… → Saved 3s ago`.

**Drawings** — markdown body recognises `![[drawing:N]]`. In the preview, each is replaced by a Shadow-DOM-hosted inline SVG (the shadow root prevents drawio's `<foreignObject>` HTML from inheriting page CSS; we also strip `color-scheme: light dark` so the diagram doesn't shift colors with the OS theme). Click → opens a full-screen modal hosting an iframe of `/static/vendor/drawio/index.html?embed=1&proto=json&saveAndExit=1`. Embed-mode postMessage protocol: respond to `init` with `{action: "load", xml}`; on `save`, capture the XML and request `{action: "export", format: "xmlsvg"}`; on `export`, decode the data: URI and PATCH the attachment.

### 6.5 Markdown rendering

Pipeline:
1. `markdown-it` with `linkify: true, typographer: true`.
2. Plugins:
   - `markdown-it-footnote` — `[^1]` style footnotes
   - `markdown-it-task-lists` — `- [x] done`
   - `markdown-it-anchor` — auto-add `id` to headings
3. Custom admonition rule (MkDocs `!!!` syntax) — emits `<div class="admonition <type>"><p class="admonition-title">…</p>…</div>` with **inlined** background/border colors so external CSS load order can never break it.
4. Code-fence highlighter: `mermaid` fences flagged for post-processing; other languages run through highlight.js (GitHub theme).
5. After markdown→HTML, a DOM walker replaces text nodes outside `<code>/<pre>/<a>` containing `#N`, `[[Title]]`, or `![[drawing:N]]` with real `<a>` / drawing-host elements.
6. Async pass: `processMermaidBlocks` finds every `<pre class="mermaid-source">` and calls `mermaid.render()` to swap in an `<svg>`.

Reference titles are cached client-side and the preview re-renders once they arrive, so `#42` becomes `#42 Fix login bug` in gray after the first fetch.

### 6.6 Project modal

Opens from sidebar `+` or any project row's `⋮`. Fields: Slug (disabled when editing), Name, Description, Color, **Parent project**. The Parent select lists roots only (and is disabled with an explanation when this project has children). Save uses POST or PATCH with `parent_id: 0` to clear. Delete requires the user to retype the slug, then DELETE and refresh.

### 6.7 Keyboard

- `Esc` — closes any open modal (capture, project edit, history, drawing preview, drawio editor).
- `Tab` / `Shift+Tab` in the New-item modal — cycles Task → Note → Link when focus isn't in a form field.

---

## 7. macOS tray

Native SwiftUI menu-bar-only app (`LSUIElement = true`). SF Symbol `checklist` icon + a short status string (currently `doing` task title, or `N today`, or `—` when disconnected).

### 7.1 Build

Swift Package Manager, no Xcode required. `build.sh`:
1. `swift build -c release`
2. Assemble `Devlog.app/Contents/{MacOS, Resources}` with a hand-rolled `Info.plist` (`LSUIElement = true`, bundle id, etc.)
3. Copy the binary, ad-hoc codesign.

### 7.2 Menu structure

```
▶ <doing task>                ▸  ⏸ Pause (move to Today)
                                 ✓ Mark done
─────────
Bookmarks
  <project> (current) · N    ▸  <bookmark>     ← opens URL in default browser
  <project> · N              ▸  …
─────────
Today (N)
  <project> · M              ▸  <task>         ▸ ▶ Start (mark doing)
                                                 ✓ Mark done
─────────
Capture…                     ⌘N   ← opens a SwiftUI Capture window with Task / Note / Link tabs
New project…                       ← opens a SwiftUI New-project window (slug auto-derived from name)
Open Web UI
─────────
Refresh                      ⌘R
Quit Devlog                  ⌘Q
```

The Doing item sits **at the top with no section header** (it's the most prominent slot). Bookmarks and Today are both grouped per project; the current project sorts first then alphabetical.

### 7.3 Backend client

`URLSession` with 10 s timeout. Polls every 5 s on `MenuBarExtra`'s label `.task` (so polling starts as soon as the icon renders, not only when the menu opens). `URLSession` calls run off the main actor; UI updates marshal back via `@MainActor`.

### 7.4 Edit menu hack

To make `Cmd+C / V / X / Z / Shift+Z / A` work in the Capture and New-project windows, an `NSApplicationDelegateAdaptor` installs a programmatic `NSMenu` with the standard Edit items at `applicationDidFinishLaunching`. The menu is never shown (LSUIElement is true) but Cocoa's responder chain still dispatches the shortcuts through it.

### 7.5 Capture window

SwiftUI window with segmented Task / Note / Link tabs (`Cmd+1/2/3` switches), project picker (defaults to current/scope/last), fields per kind, `Esc` cancels, `Cmd+Enter` saves and opens in the web UI, plain `Enter` saves and closes.

---

## 8. Linux tray

Single-file Python script using PyGObject + libayatana-appindicator (with fallback to AppIndicator3). Tested on Ubuntu 22.04 + GNOME 42 X11.

### 8.1 Menu

Same structure as the macOS tray (Doing top-level, Bookmarks per project, Today per project, Capture/New project/Open Web UI as web-UI links — no native dialogs).

### 8.2 Activation gotchas (mandatory)

- Build menus with `Gtk.MenuItem.new_with_label(...)` (the kwarg form `Gtk.MenuItem(label=…)` is unreliable through dbusmenu on GNOME).
- Hold a strong reference to the current `Gtk.Menu` on the instance (`self._menu = menu`). Without it, Python GCs the menu's handler closures shortly after `set_menu()` — the menu structure stays alive on D-Bus but clicks become no-ops.

### 8.3 Icon

Symbolic SVG installed to `~/.local/share/icons/hicolor/symbolic/apps/devlog-tray-symbolic.svg`, referenced by **name** so GNOME re-colors it per panel theme. Plain `#bebebe` fill (the GTK-symbolic placeholder color). Loading by file path skips the recolor pipeline and the icon ends up black on dark panels.

### 8.4 Installer

`install.sh`:
1. `apt-get install python3-gi python3-gi-cairo gir1.2-gtk-3.0 gir1.2-ayatanaappindicator3-0.1 xdg-utils`
2. Drop `~/.local/bin/devlog-tray` launcher
3. Install the `.desktop` file under `~/.local/share/applications/` and `~/.config/autostart/`
4. Copy the symbolic SVG into the user-local icon theme + refresh the icon cache

---

## 9. MCP server

`devlog-mcp` is a stdio FastMCP server (Python `mcp` SDK) that wraps the HTTP API. Backend must be running at `DEVLOG_BASE_URL` (default `http://127.0.0.1:8765`).

Tools exposed:

| Group | Tools |
|---|---|
| Projects | `list_projects`, `create_project`, `set_current_project`, `get_current_project` |
| Create | `create_task`, `create_note`, `create_link` |
| Read | `list_items`, `get_item` |
| Update | `update_task`, `update_note`, `update_link`, `delete_item` |
| Time | `list_sessions`, `add_session`, `task_totals` |
| Discovery | `search`, `stats` |

The `project` argument on each tool accepts either an int id or a slug; the server resolves to id by listing projects.

---

## 10. Configuration

| Env var | Default | Purpose |
|---|---|---|
| `DEVLOG_HOST` | `127.0.0.1` | bind address (use `0.0.0.0` in Docker) |
| `DEVLOG_PORT` | `8765` | bind port |
| `DEVLOG_DATA_DIR` | `$XDG_DATA_HOME/devlog` or `~/.local/share/devlog` | SQLite + backups dir |
| `DEVLOG_BASE_URL` | `http://127.0.0.1:8765` | used by `devlog-mcp` and the Linux tray |
| `DEVLOG_TRAY_ICON` | `devlog-tray-symbolic` | XDG icon name for the Linux tray |
| `DRAWIO_VERSION` | `v30.0.2` | tag used by `scripts/install-drawio.sh` |

---

## 11. File layout (reference)

```
src/devlog/
  __init__.py             # uvicorn entry point
  app.py                  # FastAPI assembly + startup hook (autopause + schema init)
  db.py                   # SCHEMA + thread-local connection + migrations + tx() context
  config.py               # env + data_dir() resolver
  link_fetcher.py         # OG title / description / favicon
  refs.py                 # parse and rebuild #id / [[Title]] edges
  stats.py                # raw per-day session bucketing
  store.py                # row → pydantic mapping
  autostop.py             # 60 s background loop
  models.py               # all pydantic schemas
  api/
    projects.py items.py sessions.py attachments.py
    settings.py stats.py search.py
  web/
    index.html app.js style.css
    vendor/drawio/        # ~120 MB, .gitignore'd, fetched on demand
  mcp_server.py           # FastMCP wrapper
clients/
  mac-tray/               # SwiftUI + SPM
  linux-tray/             # Python + PyGObject + libayatana-appindicator
scripts/
  install-drawio.sh       # fetch + prune drawio webapp
  backup-db.sh            # online SQLite .backup with --keep N rotation
  smoke_test.py           # end-to-end API smoke
Dockerfile  docker-compose.yml  Makefile  pyproject.toml
.github/workflows/
  ci.yml                  # ruff + smoke + macOS swift build + docker build sanity
  docker-publish.yml      # multi-arch image push to ghcr.io on main / v*.*.* tags
```

---

## 12. Stack notes & constraints

- **Python ≥ 3.12.** Lockfile pins via `uv.lock`; Docker image overrides to system `python3.13` with `UV_PYTHON_PREFERENCE=only-system` + `--python /usr/local/bin/python` on `uv sync` so it doesn't try to fetch a different interpreter inside a slim image.
- **SQLite ≥ 3.35** for FTS5 and partial indexes. WAL mode enabled. **Thread-local connections required** — `sqlite3.Connection` is not safe to share across FastAPI's threadpool workers; doing so causes intermittent cursor-interleaving (rows with NULL primary keys, "by_project None" in stats). Use `threading.local()` to give each worker its own connection.
- **markdown-it plugin globals.** When loading plugins via UMD scripts in the browser, the globals differ in case: `markdownit`, `markdownitFootnote`, `markdownitTaskLists`, `markdownItAnchor` (this one uses camel "It"). Admonitions: we implement our own block rule rather than depend on a brittle CDN package.
- **drawio SVG quirks.** drawio's `xmlsvg` export uses `<foreignObject>` for text labels and includes `color-scheme: light dark` on the root. Render inside a Shadow DOM and strip the color-scheme declaration before injection, otherwise text disappears and colors flip with the OS theme.
- **AppIndicator + dbusmenu.** Menu items must be `Gtk.MenuItem.new_with_label`; the `Gtk.Menu` instance must be kept alive on `self`; the icon must be referenced by name in the hicolor symbolic theme to get auto-recoloring.

---

## 13. Deployment

Three first-class paths:

1. **Docker** — `make docker-up` (data persisted to `./data`), or `docker run ghcr.io/morapet/devlog:latest -p 8765:8765 -v ~/devlog-data:/data`. Image ships the vendored drawio inside it.
2. **Local uv** — `make install && make drawio && make dev`.
3. **As a tool** — `uv tool install git+https://github.com/morapet/devlog.git && devlog`.

CI builds run on every push: ruff lint, Python smoke (boots the server with `DEVLOG_DATA_DIR=$RUNNER_TEMP/...`, runs `scripts/smoke_test.py`), macOS Swift build of the tray, Docker build sanity. Releases push a multi-arch image to `ghcr.io/morapet/devlog`.

---

## 14. Out of scope (explicit non-goals)

- Multi-user / auth / TLS / cloud sync. The whole design assumes a single user on `127.0.0.1`.
- Mobile apps.
- Real-time push to clients. All clients poll (Mac tray every 5 s, web Home every 15 s, Linux tray every 5 s).
- Calendar / due-date notifications.
- Importers / exporters beyond plain SQLite (a `.backup` is the supported way to migrate).
- Per-item permissions or sharing.

These are deliberate simplifications; resist the urge to add them without restating the threat model.

---

## 15. Reimplementation checklist

To bring up a clean reimplementation:

- [ ] Schema (§3) + triggers + indexes
- [ ] HTTP API (§4) with the exact request/response shapes
- [ ] Single-doing protocol (§5.1)
- [ ] Autopause loop (§5.2) running at startup and every 60 s
- [ ] Refs rebuild + FTS triggers (§5.3, §3.8)
- [ ] Link metadata fetcher with graceful failure (§5.4)
- [ ] Version snapshots on title/body change (§5.5)
- [ ] Web UI screens (§6) — at minimum: Home + project list/detail + capture modal
- [ ] Markdown pipeline (§6.5) with admonitions + cross-refs + drawings
- [ ] drawio embed in the same modal pattern (§6.4)
- [ ] Mac tray (§7) with single-doing-aware menu
- [ ] Linux tray (§8) — pay attention to the AppIndicator + dbusmenu gotchas
- [ ] MCP server (§9) exposing the listed tools
- [ ] Backup script + online SQLite `.backup` (§13)

A passing run of `scripts/smoke_test.py` against the new implementation is the minimum acceptance bar.
