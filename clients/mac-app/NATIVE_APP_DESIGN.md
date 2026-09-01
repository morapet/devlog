# Devlog native macOS app — design doc

Status: implemented (superseded) · `clients/mac-app` is now the native window
app described here. Note: this doc proposed keeping the menu-bar tray; the tray
was **removed** afterwards, so the app is window-only (no `MenuBarExtra`,
no `LSUIElement`). Sections below that discuss keeping the menu bar are
historical.

## Goal

Turn the existing menu-bar tray into a **self-contained Mac app**: the user
double-clicks `Devlog.app`, a backend comes up automatically, and a real
window shows the full devlog UI — no `uv run devlog` in a terminal, no Docker,
no manual setup. Power users who already run the backend (Docker / systemd /
manual) can point the app at it instead.

## Decisions (locked)

| Question | Decision | Why |
|---|---|---|
| Backend runtime | **Supervised sidecar** (child process), not a container | The backend is a plain Python HTTP server. A container on macOS means a Linux VM (~GBs, slow start, external runtime the app can't bundle). A supervised process is native, fast, and ships inside the `.app`. |
| Main UI | **`WKWebView` window** reusing the existing web UI | The web UI is already rich (calendar, focus mode, bookmarks, drawio). Wrapping it gives instant feature parity with near-zero duplication. A native SwiftUI rebuild would double-maintain the whole frontend forever. |
| Container | **Kept, unchanged, for remote/LAN** | `Dockerfile` + compose remain the multi-device / server story. Out of scope for the local app. |

## Implementation status

Landed (backend-only; independent of the Mac app, useful today):

- **Single-writer lock** — `src/devlog/lock.py`, called from `main()`. A second
  backend on the same data dir refuses to start; a different data dir starts
  fine; the lock frees on process death. Verified.
- **Export / import (`replace`)** — `src/devlog/api/portability.py`
  (`GET /export`, `POST /import`) + `src/devlog/backup.py` hot-backup helper.
  Replace requires `confirm=true` and takes a pre-import backup, returning its
  path. Round-trip re-export is byte-identical; DB integrity + FTS verified.
- **Web UI** — a header **⇅ Data** button opens an export/import modal
  (`web/index.html`, `web/app.js`); import requires typing `REPLACE`. The
  service worker (`web/sw.js`) bumped to `v6` and treats `/export`,`/import` as
  network-only. The native WKWebView app will inherit this UI.

- **Mac app shell** — the tray app is now a windowed app:
  - `MainWindow.swift` — a WKWebView window rendering the web UI (external links
    open in the system browser). Verified: shows real data in Connect mode.
  - `BackendSupervisor.swift` — Managed-mode process supervisor (free-port pick,
    data-dir prepare + one-time legacy→App Support seed, spawn, `/health` wait,
    restart-with-backoff, teardown on quit). Compiles; bundled-sidecar path is
    stubbed (falls back to `uv run --directory <repo>` when a dev repo is set).
  - `Settings.swift` / `SettingsWindow.swift` — Managed/Connect toggle, URL +
    port, live status; `UserDefaults`-backed. Verified via Cmd+,.
  - `App.swift` — added the main WindowGroup + Settings scene; dropped
    `LSUIElement` so there's a Dock icon; backend boots on launch, stops on quit.
  - `APIClient.swift` / `AppState.swift` — base URL is now dynamic and rewired
    when the mode/port changes; the web view reloads on switch.
  - **Icon + installer** — `AppIcon.svg` → `AppIcon.icns` via `make-icon.sh`
    (rsvg-convert + iconutil), bundled by `build.sh` and referenced from
    Info.plist. `make-dmg.sh` builds a drag-to-Applications DMG; `install.sh`
    installs `Devlog.app` into `/Applications` (admin-writable, no sudo on stock
    macOS) and re-registers with Launch Services. Makefile: `mac-icon`,
    `mac-dmg`, `mac-install`. Still **ad-hoc signed** (not notarized) — a
    Gatekeeper caveat for distribution, tracked below.

Not yet built: `merge` mode, `/import/pull`, **bundling the backend sidecar into
the .app** (Managed mode currently needs a dev checkout), data-dir migration UI
polish, and code-signing/notarization for distribution — see rollout below.

## What exists today (baseline)

- `clients/mac-app` — SwiftUI `MenuBarExtra` app (`LSUIElement`, menu-bar only).
  - `App.swift` — menu; "Open Web UI" opens the browser; "Capture…" / "New project…" windows.
  - `AppState.swift` — polls the backend every 5s; `connected` flips to false when it's down (shows "Backend offline").
  - `APIClient.swift` — **already takes `baseURL` as an init parameter**, hard-defaulted to `http://127.0.0.1:8765`.
  - `build.sh` — `swift build -c release`, assembles `Devlog.app`, ad-hoc codesign.
  - The app **assumes** the backend is already running. It never launches it.
- Backend — `uv run devlog`; `--host/--port` flags + `DEVLOG_HOST`/`DEVLOG_PORT` env; `DEVLOG_DATA_DIR` for the SQLite dir (default `~/.local/share/devlog`); `GET /health` → `{"ok":true}`. `requires-python >=3.12`.

The gap is small and precise: **(1) supervise a bundled backend, (2) show it in a window, (3) let the URL/port be configured.**

## Architecture

```
Devlog.app
├─ Contents/MacOS/Devlog        Swift app (window + supervisor)
├─ Contents/Resources/
│  └─ backend/                      bundled Python sidecar (see "Packaging")
│     ├─ python (standalone CPython)
│     └─ … relocatable venv + devlog source
└─ Contents/Info.plist
```

Two runtime modes, chosen in Settings, persisted in `UserDefaults`:

- **Managed** (default): the app owns the backend lifecycle.
- **Connect**: the app is a thin client to a URL the user provides.

### Managed mode — the supervisor

New Swift type `BackendSupervisor` (an `ObservableObject` owned by `AppState`):

1. **Pick a port.** Default 8765; if busy (probe by attempting a `bind`), pick a
   free ephemeral port. Store the chosen port for the session.
2. **Resolve the data dir.** Default to a Mac-native location
   `~/Library/Application Support/Devlog` and pass it via `DEVLOG_DATA_DIR`.
   (One-time migration: if `~/.local/share/devlog/devlog.db` exists and the new
   dir doesn't, copy it over so existing users keep their data.)
3. **Spawn** the bundled backend with `Process`:
   `Resources/backend/python -m devlog --host 127.0.0.1 --port <port>`,
   env `DEVLOG_DATA_DIR=<appsupport>`. Bind to `127.0.0.1` only (never expose
   the sidecar on the network — that's the container's job).
4. **Wait for readiness:** poll `GET /health` until `{"ok":true}` (timeout ~15s
   → surface a clear error window with the captured stderr).
5. **Supervise:** if the process exits unexpectedly, restart with backoff
   (cap the retries; after N failures show the error + stderr tail).
6. **Shutdown:** on `applicationWillTerminate`, `terminate()` then `SIGKILL`
   fallback; ensure no orphan on quit. Guard against double-launch of the app.

`APIClient` and the WebView both read the resolved `http://127.0.0.1:<port>`
from `AppState` instead of the hard-coded constant.

### Connect mode

- Settings holds a base URL (default `http://127.0.0.1:8765`).
- Supervisor is idle; `APIClient(baseURL:)` and the WebView use the configured URL.
- Same "Backend offline" banner as today if it's unreachable.

### The window (WKWebView)

- New `MainWindow` scene (a normal `Window`, app becomes a regular app with a
  Dock icon — reconsider `LSUIElement`, see "Open questions").
- `NSViewRepresentable` wrapping `WKWebView`, loading `http://127.0.0.1:<port>/`.
- Only load `127.0.0.1:<port>`; deny navigation elsewhere via
  `decidePolicyFor navigationAction` (open external links in the system browser
  with `NSWorkspace`). Keeps the webview a trusted local surface.
- ~~Menu bar stays for quick Capture + Start/Pause/Done + Bookmarks.~~ (Historical: the menu-bar tray was later removed; the app is window-only.)
- "Open Web UI" can stay (browser) and/or gain "Open Window".

## Packaging the sidecar

The interpreter + deps must ship **inside** the app (no network, no system
Python assumption, works on a fresh Mac). Ranked:

1. **uv relocatable venv (recommended — stays in the current toolchain).**
   At app-build time, `build.sh` creates a relocatable environment with a
   uv-managed standalone CPython and syncs the project into it:
   ```bash
   uv venv --relocatable --python 3.12 "$APP_DIR/Contents/Resources/backend/.venv"
   uv sync --frozen --no-dev \
       --python "$APP_DIR/Contents/Resources/backend/.venv/bin/python"
   ```
   `--relocatable` (confirmed available in the installed uv) rewrites the venv
   so it runs from wherever the `.app` lands. Bundle the drawio webapp too if
   wanted (reuse `scripts/install-drawio.sh`). No new tool beyond uv, which the
   repo already requires.
   - Risk: relocatable venvs can still hard-reference the standalone Python;
     verify the bundled `python` resolves relative paths after the app is moved
     and re-signed. Validate by building, moving the `.app`, and launching.

2. **PyInstaller / PyOxidizer one-dir build** — a `devlog` binary with a frozen
   interpreter. Very robust and self-contained, but adds a build-time dependency
   and a spec file to maintain.

3. **Bundle `uv` + source, build the venv on first run** — smallest artifact,
   but needs network on first launch and is slow/fragile. Rejected for a
   shippable app.

Cross-arch: build on Apple Silicon → arm64 sidecar. A universal build needs an
x86_64 pass too (defer unless needed).

## Code signing / notarization

- Today: ad-hoc sign. Fine for local dev, **not** for distribution.
- A bundled interpreter + native `.so` dylibs means for distribution you need:
  Developer ID signing of **every** Mach-O in the sidecar (`--deep` is
  discouraged — sign inner binaries then the app), the **hardened runtime**, and
  notarization + stapling. Python's hardened-runtime needs entitlements
  (`com.apple.security.cs.allow-jit`, `…allow-unsigned-executable-memory`,
  `…disable-library-validation`) — to be verified against the chosen packager.
- Scope call: keep **ad-hoc for local builds now**; treat signing/notarization
  as a separate follow-up before any public distribution.

## Data safety: dir isolation + single-writer lock

Two backends must never fight over one SQLite file. The DB is WAL +
`busy_timeout=10s` + `BEGIN IMMEDIATE`, so same-host concurrent access won't
*corrupt* — but WAL and advisory locks are **unreliable across a Docker/host
bind mount** (VirtioFS), and double schema migration (the non-idempotent FTS
rebuild in `db.py`) is unsafe. Fix in two layers:

1. **Isolate by default.** Native Managed backend → `~/Library/Application
   Support/Devlog`; Docker → `./data`; Connect mode runs no sidecar. Different
   files ⇒ no competition. (Observed: today's live data is the *local*
   `~/.local/share/devlog/devlog.db`; no `./data` exists on this machine.)
2. **Single-writer lock** in the Python backend (authoritative regardless of
   launcher). `fcntl.flock(LOCK_EX|LOCK_NB)` on `<data_dir>/devlog.lock` at
   startup; write PID/host/port/started into it for a readable message; refuse
   to start if held. Auto-released on crash (beats a bare PID file). Also
   serializes migrations. Caveat: `flock` won't cross the Docker/host FS
   boundary — that case is covered by layer 1.

## Data portability: export / import / cross-backend migration

Because runtimes keep separate data dirs, the user needs a first-class way to
move data between backends (e.g. migrate an existing backend into the native
app, or merge two). **Build it once in the backend API + web UI; the native app
inherits the buttons through the WKWebView** (native adds only an optional
`NSOpenPanel` / "import from URL" convenience). Transport is **file
export/import** (offline, no coupling); a live "pull from URL" is a later
convenience.

### Backend endpoints

- `GET /export` → one schema-versioned JSON document:
  `{ schema, exported_at, source, projects[], items[], refs[], work_sessions[],
  item_versions[], attachments[], settings[] }`. (A raw `.db` download is also
  worth offering for a truly lossless byte-for-byte migrate.)
- `POST /import` — accepts that JSON + `mode`; whole operation in one
  transaction, rollback on any error.

### Import modes

- **`replace`** (build first) — wipe target, load source verbatim (IDs
  preserved). Simple, lossless, **destructive**.
  - **Destructive → must be explicitly, unambiguously confirmed by the user.**
    Never a default, never silent. UI requires a deliberate confirmation
    (e.g. type "REPLACE" or the target's name) after showing exactly what will
    be discarded (current counts) vs. imported.
  - **Auto-backup before wiping.** The endpoint calls the existing hot-backup
    (`scripts/backup-db.sh` / SQLite `.backup`) into `<data_dir>/backups/`
    *before* deleting anything, and reports the backup path in the response so a
    mistaken replace is always recoverable.
- **`merge`** (follow-up) — non-destructive; **remap every ID**: insert source
  rows with new ids, keep an `old→new` map, rewrite all FKs (`items.project_id`,
  `refs.from_id/to_id`, `work_sessions.item_id`, `item_versions.item_id`,
  `attachments.item_id`) **and** the `#42` / `[[Title]]` tokens in item bodies
  so backlinks survive. Handle the **`projects.slug` UNIQUE** collision (fold
  into existing project, or rename) as an explicit UI choice.

### Invariants during import

- Demote any imported `doing` task → `today` (preserve the single-`doing` rule).
- Don't import the source's `current project` / working-hours settings in merge
  mode.

### Live pull (later)

- `POST /import/pull { source_url, mode }` — target backend fetches
  `GET {source_url}/export` itself and imports. The literal "import from another
  backend" button. Explicit user action only; note it's a server-side fetch to a
  user-supplied URL (fine for a single-user localhost tool).

### UI

- **Web (⇒ native for free):** Settings/⋯ area — **Export** (downloads JSON) and
  **Import** (file picker → choose mode → confirmation showing counts + slug
  collisions + the pre-import backup path → go).
- **Native extra (optional):** `NSOpenPanel` "Import file…" and an "Import from
  another backend…" field driving `/import/pull`.

### Build order

export → file-import `replace` (with mandatory confirm + auto-backup) → `merge`
with ID remap → pull-from-URL. Each independently shippable.

## File-level change list

Backend (Python):
- `src/devlog/lock.py` — single-writer data-dir lock (`flock`), called from `main()`.
- `src/devlog/api/portability.py` — `GET /export`, `POST /import` (+ later `/import/pull`); registered in `app.py`.
- `src/devlog/config.py` — default data dir stays overridable; native app passes `DEVLOG_DATA_DIR=~/Library/Application Support/Devlog`.

Native (Swift) — new:
- `Sources/Devlog/BackendSupervisor.swift` — process lifecycle, port pick, health wait, restart, teardown.
- `Sources/Devlog/MainWindow.swift` — `WKWebView` window + navigation policy.
- `Sources/Devlog/SettingsWindow.swift` — mode toggle (Managed/Connect), URL/port, data dir.
- `Sources/Devlog/Settings.swift` — `UserDefaults`-backed config (mode, connectURL, port pref, dataDir).

Changed:
- `App.swift` — add `MainWindow` scene + Settings; drop `LSUIElement` (or make it a preference); wire "Open Window".
- `AppState.swift` — hold the resolved base URL + a `BackendSupervisor`; construct `APIClient(baseURL:)` from it; start/stop the sidecar with app lifecycle.
- `APIClient.swift` — take the base URL from `AppState`/`Settings` rather than the hard-coded default.
- `build.sh` — build + bundle the sidecar into `Resources/backend`; sign inner binaries; verify a moved `.app` still launches.
- `Info.plist` — reconsider `LSUIElement`; bump version; add any needed entitlements when signing is tackled.
- `Makefile` — `mac` target already builds+opens; ensure it triggers the sidecar bundling step.

## Rollout (incremental, each step runnable)

1. **Configurable URL.** Thread `baseURL` from a `Settings`/`UserDefaults` value
   through `APIClient` + AppState. Ships "Connect mode" alone. Lowest risk.
2. **WKWebView window.** Add the window loading the configured URL. Now it's a
   real windowed app against a manually-run backend.
3. **Supervisor.** `BackendSupervisor` spawning `uv run devlog` from a dev
   checkout (not yet bundled) — proves lifecycle/health/teardown end to end.
4. **Bundle the sidecar.** `build.sh` builds the relocatable venv into
   `Resources`; supervisor points at the bundled `python`. Now double-click
   works with nothing installed.
5. **Data-dir migration + polish.** App Support dir, one-time DB copy,
   error/restart UX.
6. **Data safety.** Single-writer `flock` lock in the backend (independent of
   the app work — useful today).
7. **Export / import.** `GET /export` + `POST /import` (`replace`, with
   mandatory explicit confirm + pre-import auto-backup) + web-UI buttons; native
   inherits via the webview. Then `merge`, then `/import/pull`.
8. **Signing/notarization.** Separate track, before distribution.

Steps 6–7 are backend-only and can land before the Mac app.

## Open questions

- **Dock vs menu-bar-only.** A window app usually wants a Dock icon (drop
  `LSUIElement`); some prefer pure menu-bar. Could be a preference.
- **Data dir default.** Move to `~/Library/Application Support/Devlog` (native)
  with migration, or keep `~/.local/share/devlog` for parity with the Linux/
  Docker installs? Migration cost vs. cross-platform consistency.
- **drawio in the bundle.** Include the ~120 MB webapp in the sidecar, or fetch
  on first use? Affects `.app` size.
- **App size budget** — bundled CPython + deps (+ optional drawio) is tens to a
  few hundred MB. Acceptable?
- **Universal binary** — arm64-only first, or ship x86_64 too?

## Why not the container (recorded, since it was the original idea)

Running the backend in a container on the user's Mac requires a container
runtime the app cannot bundle, boots a Linux VM for a single native Python
server, complicates the SQLite data path (bind-mounting `~/Library` into a VM),
and slows startup — all to avoid spawning a child process the app can already
manage directly. The container keeps its place for **remote / LAN / server**
deployment via the existing `Dockerfile` + compose.
