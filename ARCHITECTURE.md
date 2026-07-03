# Architecture

Snapshot of how devlog is wired today. Complements [SPECIFICATION.md](SPECIFICATION.md) (exhaustive contract) and [AGENTS.md](AGENTS.md) (how to drive it). This file is the picture; SPEC is the law.

---

## 1. System diagram

```
                              ┌─────────────────────────────────────┐
                              │           Web browser               │
                              │  vanilla JS + Tailwind + markdown-it │
                              │  + highlight.js + mermaid + drawio  │
                              └────────────────┬────────────────────┘
                                               │ HTTP / JSON
                                               │
  ┌──────────────────────┐                     │
  │   macOS menu bar     │                     │       ┌────────────────────────────┐
  │   SwiftUI / SPM      │ ─────────────HTTP ──┼──────►│                            │
  └──────────────────────┘                     │       │       devlog backend       │
                                               │       │   FastAPI (Python ≥ 3.12)  │
  ┌──────────────────────┐                     │       │                            │
  │   Linux tray         │ ─────────────HTTP ──┤       │  • items / projects /      │
  │   PyGObject + GTK    │                     │       │    sessions / attachments  │
  │   AppIndicator       │                     │       │    / search / stats        │
  └──────────────────────┘                     │       │  • autopause loop (60 s)   │
                                               │       │  • link metadata fetcher   │
  ┌──────────────────────┐                     │       │  • refs auto-rebuild       │
  │   MCP server         │ ──────── HTTP ──────┘       │  • FTS5 triggers           │
  │   23 tools (stdio)   │                             │  • version snapshots       │
  │   FastMCP            │                             │                            │
  └────────▲─────────────┘                             └───────────┬────────────────┘
           │ stdio JSON-RPC                                        │ SQLite (WAL)
           │                                                       ▼
  ┌────────┴─────────────┐                             ┌────────────────────────────┐
  │  Claude Code / etc.  │                             │ ~/.local/share/devlog/     │
  │       (LLM)          │                             │   devlog.db  + WAL + SHM   │
  └──────────────────────┘                             │   backups/devlog-*.db      │
                                                       └────────────────────────────┘
```

**Five surfaces, one backend, one SQLite file.** Localhost only by default (`127.0.0.1:8765`). No auth.

---

## 2. Process model

There is exactly one process to run: the FastAPI server. Everything else either *talks to it* or *is part of it*:

| Component | Process | Lifecycle |
|---|---|---|
| Backend HTTP API | `uv run devlog` (or `~/.local/bin/devlog`) | One long-lived process. Bind 127.0.0.1:8765. |
| Web UI | None — served as static files | Loaded into a browser tab on demand. |
| macOS tray | `Devlog.app` (SwiftUI) | One per session. Polls backend every 5 s. |
| Linux tray | `~/.local/bin/devlog-tray` (Python script via `xdg-autostart`) | One per session. Polls every 5 s. |
| MCP server | `devlog-mcp` spawned by the MCP client (stdio) | Per-client subprocess. Translates tool calls to HTTP. |
| Autopause | Asyncio task inside the backend | Fires once at startup, then every 60 s. |
| Backup | `scripts/backup-db.sh` (cron / launchd / one-off) | On demand. Uses SQLite online `.backup`. |

On Linux you typically run the backend as a **systemd user service** (`clients/linux-server/install.sh`). On macOS you `make dev` for now (no launchd plist yet).

---

## 3. Storage

```
items ── kind ─┬─ task
               ├─ note
               └─ link
   project_id ────────► projects ── parent_id ──┐
                                                │ (2-level cap)
                                                ▼
                                          projects (root only)

   id ◄──── from_id ──── refs ──── to_id ────► id   (cross-refs / backlinks)

   id ◄──── item_id ──── work_sessions     (task time tracking)
   id ◄──── item_id ──── item_versions     (title/body history)
   id ◄──── item_id ──── attachments       (drawio XML + SVG)

   items ⤳ items_fts (FTS5 virtual table, kept in sync by triggers
            over title / body / url / link_description / tags)

   settings (k/v: current_project_id, working_hours JSON)
```

Single SQLite file, WAL mode. Thread-local connections (FastAPI's threadpool would otherwise interleave cursors). One global writer lock for transactions; readers go straight to the connection.

Schema details: see [SPECIFICATION.md §3](SPECIFICATION.md#3-domain-model).

---

## 4. The hard invariants (and where they're enforced)

| Invariant | Enforced in |
|---|---|
| **Single doing.** At most one task system-wide is `doing`. Transition takes care of close-prev-session + open-new. | `api/items.py::_update`, single tx |
| **2-level project tree.** parent must be a root; project with children can't become a child. | `api/projects.py::_validate_parent`, on both POST and PATCH |
| **End-of-workday autopause.** Open sessions running past `working_hours.end` close at that boundary, not at "now". | `autostop.py::check_once`, run at startup + every 60 s |
| **Refs rebuild on save.** `#N` and `[[Title]]` parsed from `title+body`, edges rewritten in `refs`. | `api/items.py::_update`, after the UPDATE |
| **Version snapshots.** Any PATCH that changes title or body writes an `item_versions` row. | `api/items.py::_update`, after refs |
| **FTS sync.** `items_fts` updated by AFTER INSERT/UPDATE/DELETE triggers in the schema. | `db.py::SCHEMA` |
| **Cascade.** Deleting a project cascades items (and via FK their sessions / versions / attachments / refs); children projects are promoted to roots. | `api/projects.py::delete_project` |

Clients (web, trays, MCP) **never** simulate any of these. They make the call and trust the result.

---

## 5. Request flow (typical task lifecycle)

1. User clicks `▶ Start` in the tray on task #42.
2. Mac/Linux tray hits `POST /tasks/42/doing`.
3. Backend, in one transaction:
   - `UPDATE items SET status = 'today', doing_started_at = NULL WHERE status = 'doing'` (any prior doing)
   - `UPDATE work_sessions SET ended_at = now WHERE ended_at IS NULL` (close prior session)
   - `UPDATE items SET status = 'doing', doing_started_at = now WHERE id = 42`
   - `INSERT INTO work_sessions(item_id, started_at) VALUES (42, now)`
   - returns the updated item
4. Tray polls 5 s later: `GET /items?kind=task&status=doing&limit=1` returns #42. Menu label updates.
5. User does work. Some hours later, end-of-workday fires (18:00 local on a workday):
   - Autopause loop closes the open session at exactly 18:00:00 (not at the tick time).
   - Sets the task back to `today`.
6. Next morning user picks it up again — same `POST /tasks/42/doing` opens a fresh session.

Stats / time totals are always computed from `work_sessions` (with overlapping per-day buckets for cross-midnight sessions). The `doing_started_at` column is a UI hint only.

---

## 6. Web UI rendering pipeline

Body markdown goes through this chain on every keystroke (debounced ~16 ms by the textarea event loop):

```
   raw markdown
        │
        ▼
   markdown-it
   + footnote / task-lists / anchor / custom admonition rule
        │  (HTML)
        ▼
   processMermaidBlocks  ──────► swaps ```mermaid fences for rendered SVG
        │
        ▼
   DOM walker          ──────► replaces #N / [[Title]] / ![[drawing:N]]
                                in text nodes (outside <code>/<pre>/<a>)
                                with real <a> / drawing-host elements
        │
        ▼
   preview pane DOM
```

Cross-ref titles are resolved lazily — first render shows `#42`, the title fetch finishes asynchronously, second render shows `#42 Fix login bug`.

Drawings render in a **Shadow DOM** so drawio's `<foreignObject>` HTML doesn't inherit page CSS. The shadow stylesheet also rewrites `color-scheme: light dark` to `color-scheme: light` so OS dark mode doesn't flip diagram colors. Click → lightbox (focus mode) or drawio editor (edit mode).

The markdown toolbar above the textarea wraps the selection / prefixes lines (Bold, Italic, Strike, Code, H1/H2/H3, Bulleted, Numbered, Task, Quote, Link, Code block, HR, Admonition, Insert drawing). Cmd/Ctrl+B/I/K shortcuts mirror Bold / Italic / Link.

---

## 7. MCP

`devlog-mcp` is a FastMCP stdio server that exposes the REST API as **23 tools** in 6 groups:

| Group | Tools |
|---|---|
| Projects | `list_projects`, `create_project`, `set_current_project`, `get_current_project` |
| Items create | `create_task`, `create_note`, `create_link` |
| Items read / update / delete | `list_items`, `get_item`, `update_task`, `update_note`, `update_link`, `delete_item` |
| Time | `list_sessions`, `add_session`, `task_totals` |
| **Drawings (new)** | `list_attachments`, `get_attachment`, `create_attachment`, `update_attachment`, `delete_attachment` |
| Discovery | `search` (supports `tag:value`), `stats` |

The server ships a **4.2 KB `instructions` string** that compliant MCP clients surface to the LLM at `initialize`. It packs the seven hard invariants, the common workflows mapped to tool calls, the drawing recipe (minimal mxfile skeleton + visual palette), and the "cheapest endpoint per question" table. See [AGENTS.md](AGENTS.md) for the full operating guide.

Project args accept either a slug or a numeric id; the tool resolves slugs internally.

---

## 8. Clients

### 8.1 macOS tray

SwiftUI MenuBarExtra, built via Swift Package Manager (no Xcode). `build.sh` produces `Devlog.app/Contents/{MacOS, Resources}` with a hand-rolled Info.plist (`LSUIElement = true`). Polls every 5 s on the indicator label's `.task` modifier (so polling starts the moment the icon renders).

Menu layout: Doing task at the very top (top-level item, no section header), then Bookmarks grouped per project, then Today grouped per project, then Capture / New project / Web UI / Refresh / Quit. Current project is sorted first in groups and tagged `(current)`.

Edit-menu hack: an `NSApplicationDelegateAdaptor` installs a programmatic `NSMenu` with the standard Edit items at launch. The menu is never shown but Cocoa needs it for Cmd+C/V/X/Z/Shift+Z/A to dispatch through the responder chain.

### 8.2 Linux tray

Single-file Python script using PyGObject + `libayatana-appindicator` (fallback to `AppIndicator3`). Same menu structure as macOS. Two **mandatory** gotchas baked in:

1. Build items with `Gtk.MenuItem.new_with_label(...)` (kwarg form is unreliable through dbusmenu on GNOME).
2. Keep the active `Gtk.Menu` referenced from `self._menu`. Without it, Python GCs the menu's handler closures shortly after `set_menu()` — clicks become silent no-ops.

Icon: symbolic SVG (`#bebebe` fill) installed to `~/.local/share/icons/hicolor/symbolic/apps/devlog-tray-symbolic.svg`, referenced **by name**. GNOME's panel then recolors it per theme.

### 8.3 Linux server (systemd user service)

`clients/linux-server/install.sh` is the one-command Ubuntu/Debian path:

1. Pick installer: `uv tool` → `pipx` → `pip --user`. Bootstrap `pipx` via apt if none.
2. `<installer> install devlog` (from repo or from GitHub with `--from-github`).
3. Download + prune the drawio webapp into the installed package.
4. Drop `~/.config/systemd/user/devlog.service` and `systemctl --user enable --now devlog`.
5. With `--linger`, run `sudo loginctl enable-linger $USER` so it survives logout.

The unit uses `KillSignal=SIGINT` and `TimeoutStopSec=10` so the autopause loop finishes its tick on stop. Per-user env overrides live in `~/.config/devlog.env`.

---

## 9. Deployment

| Path | Use when |
|---|---|
| `make docker-up` (image with drawio baked in) | Self-contained, multi-platform |
| `docker run ghcr.io/morapet/devlog:latest` | Pull the prebuilt image; no clone |
| `make install && make drawio && make dev` (uv local) | Local dev on macOS |
| `uv tool install git+…` | One-off CLI install |
| `make install-linux` (systemd user) | Run on Ubuntu on every login |

CI in `.github/workflows/`:
- `ci.yml` — every push/PR: ruff, Python smoke (boots backend with `DEVLOG_DATA_DIR=$RUNNER_TEMP/...` and runs `scripts/smoke_test.py`), macOS Swift build, Docker build sanity.
- `docker-publish.yml` — multi-arch (amd64 + arm64) push to `ghcr.io/morapet/devlog` on `main` and on `v*.*.*` tags.

---

## 10. What's new since the last spec write-up

For anyone catching up on changes after `SPECIFICATION.md` was first written:

- **2-level project tree** (`parent_id`) — root → child, no grandchildren. Sidebar renders the tree with indentation; project modal has a Parent dropdown.
- **Link display labels** (`display_label`) — overrides the fetched/manual title in tiles, list rows, tray menus, and detail header. Inputs in the link detail meta row and in the New-link tab.
- **Focus mode** — read-only viewer toggle (👁/✏) per item. Hides editor + meta + tags + actions; shows centered max-w-3xl preview. Clicking a drawing in focus mode opens a lightbox (95vw × 95vh) instead of the editor. Persisted in `localStorage["focusMode"]`.
- **Markdown toolbar** — Bold / Italic / Strike / Code / H1-3 / Bullets / Numbered / Task / Quote / Link / Code block / HR / Admonition / Insert drawing. Cmd/Ctrl+B/I/K shortcuts.
- **MCP server enhancements** — added `list_attachments`, `get_attachment`, `create_attachment`, `update_attachment`, `delete_attachment` (drawings are now fully MCP-native); ships a 4.2 KB `instructions` field at `initialize` summarizing invariants + workflows + drawing recipe.
- **Linux server systemd install** — `clients/linux-server/{install.sh, devlog.service}` plus `make server-linux` / `make install-linux`.
- **Linux tray click fix** — keep the `Gtk.Menu` referenced from `self`; use `new_with_label`; ship a symbolic SVG so the icon recolors per theme.
- **Web UI niceties** — Esc closes any modal; Tab/Shift+Tab cycles the New-item tabs when focus is on the strip (not in a form field); resizable sidebar/detail splitter with `localStorage` persistence; render-error fallback in the detail pane.
- **AGENTS.md / SPECIFICATION.md / ARCHITECTURE.md** — three-layer documentation, scoped from how-to-use → what-it-is → big-picture.
- **Phone-usable web UI** — under 768px the three panes collapse to one (sidebar drawer behind a hamburger, full-screen list ↔ detail with a back bar); PNG icons for iOS (`apple-touch-icon` ignores SVG); safe-area insets; 16px form fields to stop Safari's focus zoom.
- **Optional auth** (`DEVLOG_PASSWORD`, spec §4.11) — HMAC-signed 90-day session cookie + `/login` page for browsers, `Authorization: Bearer` for API clients/MCP. Unset = the old no-auth localhost behavior.
- **Hosting recipes** (`deploy/`) — Cloudflare Tunnel (free, no open ports), VPS + Caddy (auto-TLS), PythonAnywhere (free tier, WSGI bridge via `a2wsgi`).
- **Runs on the phone itself** (`clients/ios/`) — iSH walkthrough using Alpine's prebuilt packages; `selectolax` became an optional import with a regex fallback in `link_fetcher.py`, and `python -m devlog` (`__main__.py`) runs straight from a checkout.
