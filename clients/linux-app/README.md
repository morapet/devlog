# Devlog desktop app — Linux (GTK3 + WebKit2GTK)

The Linux counterpart of the macOS app: a real window embedding the devlog web
UI in a WebKit2 web view, with the same two backend modes.

This is distinct from the other Linux clients:
- **`linux-server`** — runs the backend as a systemd `--user` service.
- **`linux-app`** (this) — the windowed WebKit app you look at and work in.

## Install

```bash
bash clients/linux-app/install.sh      # or: make app-linux
```

Installs (per-user, no root beyond `apt`):
- deps via apt (`python3-gi`, `gir1.2-gtk-3.0`, `gir1.2-webkit2-4.1`/`4.0`),
- a launcher at `~/.local/bin/devlog-app`,
- an app icon and a `.desktop` entry (shows as **Devlog** in the app grid).

## Modes

| Mode | What it does |
|---|---|
| **connect** (default) | Thin client to a backend you already run — the systemd service, Docker, or `devlog` in a terminal. Target URL defaults to `http://127.0.0.1:8765`. |
| **managed** | The app spawns and supervises its own backend, picks a free port, and stops it on quit. Needs `devlog` on `PATH` (or `dev_repo` set — see below). |

Switch modes from the app's **Settings** (gear icon in the header bar).

## Configuration

Environment (highest priority) or `~/.config/devlog/app.json`:

```json
{ "mode": "connect", "connect_url": "http://127.0.0.1:8765",
  "managed_port": 8765, "dev_repo": "" }
```

- `DEVLOG_APP_MODE=connect|managed`
- `DEVLOG_BASE_URL=http://host:port` (connect target)
- `DEVLOG_PORT=8765` (managed preferred port; `0` = auto)
- `DEVLOG_DEV_REPO=/path/to/devlog` (managed fallback: runs the backend via
  `uv run --directory <repo> devlog` when `devlog` isn't on `PATH`)

## Notes

- Managed mode uses the backend's single-writer data-dir lock, so it will refuse
  to start a second backend on `~/.local/share/devlog` if the systemd service is
  already running — switch to connect mode in that case.
- WebKit2GTK package names vary by Ubuntu release; the installer tries `4.1`
  then `4.0`. If the window shows a "WebKit2GTK is not installed" message,
  install the matching package for your release and relaunch.
