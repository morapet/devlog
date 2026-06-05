# devlog

Local-first developer task / note / link tracker. Single SQLite file, FastAPI backend, vanilla-JS web UI, a SwiftUI macOS menu-bar tray, and an MCP server so an LLM can drive everything.

- **Tasks · notes · links** scoped to projects, with cross-refs (`#42`, `[[Title]]`), tags, full-text search, and a rich markdown editor.
- **Time tracking** with single-doing invariant, editable sessions, end-of-workday auto-pause.
- **Drawings** via a vendored drawio webapp — fully offline; tokens like `![[drawing:N]]` render inline.
- **Markdown** via markdown-it with footnotes, task lists, anchors, a custom MkDocs-style admonition rule, highlight.js, and Mermaid.
- **MCP server** (`devlog-mcp`) exposing 18 tools so Claude can create projects/tasks/notes/links/sessions and search.

## Quick start

### Option A — Pull the prebuilt image from GHCR (fastest, no build, no clone)

GitHub Actions publishes a multi-arch image (`linux/amd64` + `linux/arm64`) to **`ghcr.io/morapet/devlog`** on every push to `main` and on `v*.*.*` tags. drawio is baked in.

```bash
# one-shot run with a host volume for data
mkdir -p ~/devlog-data
docker run -d --name devlog \
    -p 8765:8765 \
    -v ~/devlog-data:/data \
    --restart unless-stopped \
    ghcr.io/morapet/devlog:latest
open http://localhost:8765
```

Update later:
```bash
docker pull ghcr.io/morapet/devlog:latest
docker rm -f devlog
# …then re-run the docker run command above
```

Or use `docker compose` with the published image (drop into a new dir as `docker-compose.yml`):
```yaml
services:
  devlog:
    image: ghcr.io/morapet/devlog:latest
    container_name: devlog
    ports: ["8765:8765"]
    volumes: ["./data:/data"]
    restart: unless-stopped
```

```bash
docker compose up -d
```

Available tags:

| Tag | Source |
|---|---|
| `latest` | most recent push to `main` |
| `main` | most recent push to `main` |
| `v1.2.3`, `1.2`, `1` | semver from a `v*.*.*` git tag |
| `sha-abc1234` | a specific commit |

> Note: GHCR packages start as private. After the first publish, go to https://github.com/users/morapet/packages/container/devlog → Package settings → "Change visibility" → Public, so others can `docker pull` without auth.

### Option B — Build the Docker image from source

```bash
git clone https://github.com/morapet/devlog.git
cd devlog
make docker-up        # builds the image (includes drawio) and starts the container
open http://localhost:8765
```

Data persists in `./data/` (a SQLite WAL file). Stop with `make docker-down`.

### Option C — Local Python (with [uv](https://docs.astral.sh/uv/))

```bash
git clone https://github.com/morapet/devlog.git
cd devlog
make install          # uv sync
make drawio           # download + install the drawio webapp (~120 MB, one-time)
make dev              # uv run devlog
open http://127.0.0.1:8765
```

Data goes to `~/.local/share/devlog/devlog.db` (or `$XDG_DATA_HOME/devlog/` if set).

### Option D — Install as a CLI tool

```bash
uv tool install git+https://github.com/morapet/devlog.git
devlog                # starts the backend
bash $(uv tool dir)/devlog/scripts/install-drawio.sh   # if you want drawings
```

### Option E — Ubuntu / Debian, run on every login (systemd user service)

```bash
# From a repo checkout
make install-linux      # backend service + tray, all-in-one

# Or piecewise
bash clients/linux-server/install.sh   # backend via pipx/uv + systemd --user
bash clients/linux-tray/install.sh     # tray indicator + autostart

# Or from anywhere, no checkout
curl -sLf https://raw.githubusercontent.com/morapet/devlog/main/clients/linux-server/install.sh \
    | bash -s -- --from-github --linger
```

The server script:
- Installs the `devlog` package (via `uv tool` → `pipx` → `pip --user`, whichever exists; bootstraps `pipx` via apt if none).
- Downloads the drawio webapp into the installed package (skip with `--no-drawio`).
- Writes `~/.config/systemd/user/devlog.service` and runs `systemctl --user enable --now devlog`.
- With `--linger`, runs `sudo loginctl enable-linger $USER` so the backend keeps running after logout.

See [clients/linux-server/README.md](clients/linux-server/README.md) for status / upgrade / uninstall.

## Menu-bar tray (optional)

### macOS — native SwiftUI

```bash
make tray
# or:
cd clients/mac-tray && ./build.sh && open .build/Devlog.app
```

Requires Swift / CommandLineTools. The menu-bar icon shows the currently-doing task or today's count; the menu has the doing task at top, then bookmarks grouped per project, then today's tasks grouped per project.

### Linux — GNOME / Ubuntu (PyGObject + libayatana-appindicator)

```bash
make tray-linux
# or:
bash clients/linux-tray/install.sh
```

Tested on Ubuntu 22.04 + GNOME 42 (X11). The installer apt-installs `python3-gi`, `gir1.2-ayatanaappindicator3-0.1` and friends, drops a launcher at `~/.local/bin/devlog-tray`, and enables autostart. Same menu layout as the macOS tray. See [clients/linux-tray/README.md](clients/linux-tray/README.md).

## MCP server

Exposes the HTTP API as 18 MCP tools for use from Claude Desktop / Claude Code.

Add to your client config (e.g. `~/.claude.json` or `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "devlog": {
      "command": "uv",
      "args": ["run", "--directory", "/path/to/devlog", "devlog-mcp"]
    }
  }
}
```

Override the backend URL with `DEVLOG_BASE_URL`. See [src/devlog/mcp_server.py](src/devlog/mcp_server.py) for the full tool list.

## Make targets

```
make help               # list every target
make install            # install python deps via uv
make drawio             # download drawio webapp
make dev                # run the backend
make tray               # build and launch the Mac tray
make mcp                # run devlog-mcp (stdio)
make docker-build       # docker compose build
make docker-up          # docker compose up -d
make docker-down        # docker compose down
make docker-logs        # follow container logs
make clean              # remove build artifacts (keeps data + db)
```

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `DEVLOG_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` in Docker) |
| `DEVLOG_PORT` | `8765` | Bind port |
| `DEVLOG_DATA_DIR` | `$XDG_DATA_HOME/devlog` or `~/.local/share/devlog` | Where the SQLite file lives |
| `DEVLOG_BASE_URL` | `http://127.0.0.1:8765` | Used by `devlog-mcp` to reach the backend |

## Project layout

```
.
├── src/devlog/           # FastAPI app + web assets
│   ├── api/              # routers: projects, items, sessions, attachments, search, stats, settings
│   ├── web/              # index.html, app.js, style.css, vendor/drawio/ (ignored)
│   ├── db.py             # schema + thread-local connections + migrations
│   ├── autostop.py       # background loop pausing 'doing' tasks at end of workday
│   ├── stats.py          # raw per-day session time math
│   └── mcp_server.py     # FastMCP wrapper exposing 18 tools
├── clients/mac-tray/     # SwiftUI menu-bar app (Swift Package Manager)
├── scripts/              # helpers (install-drawio.sh)
├── Dockerfile            # python:3.13-slim base, uv, optional drawio install
├── docker-compose.yml    # `make docker-up`
├── Makefile              # convenience targets
└── pyproject.toml        # uv-managed; entry points: devlog, devlog-mcp
```

## Stack

- **Backend**: FastAPI · SQLite (WAL + FTS5) · httpx · selectolax
- **Web UI**: vanilla JS · Tailwind via CDN · markdown-it + custom plugins · highlight.js · Mermaid · drawio (vendored)
- **macOS tray**: SwiftUI MenuBarExtra · NSStatusItem · async/await URLSession client
- **MCP**: `mcp` Python SDK (FastMCP, stdio transport)

## Documentation

Three layers, each at a different scope:

- [ARCHITECTURE.md](ARCHITECTURE.md) — big picture: system diagram, process model, rendering pipeline, what each client does, what's new recently.
- [AGENTS.md](AGENTS.md) — operating guide for LLMs: how to connect via MCP, common workflows mapped to tool calls, the drawio recipe with a Python helper.
- [SPECIFICATION.md](SPECIFICATION.md) — exhaustive contract suitable for full reimplementation. Domain model, every endpoint, every invariant.

## License

[MIT](LICENSE)
