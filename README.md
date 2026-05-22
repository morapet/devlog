# devlog

Local-first developer task / note / link tracker. Single SQLite file, FastAPI backend, vanilla-JS web UI, a SwiftUI macOS menu-bar tray, and an MCP server so an LLM can drive everything.

- **Tasks · notes · links** scoped to projects, with cross-refs (`#42`, `[[Title]]`), tags, full-text search, and a rich markdown editor.
- **Time tracking** with single-doing invariant, editable sessions, end-of-workday auto-pause.
- **Drawings** via a vendored drawio webapp — fully offline; tokens like `![[drawing:N]]` render inline.
- **Markdown** via markdown-it with footnotes, task lists, anchors, a custom MkDocs-style admonition rule, highlight.js, and Mermaid.
- **MCP server** (`devlog-mcp`) exposing 18 tools so Claude can create projects/tasks/notes/links/sessions and search.

## Quick start

### Option A — Docker (one command, no Python install)

```bash
git clone https://github.com/morapet/devlog.git
cd devlog
make docker-up        # builds the image (includes drawio) and starts the container
open http://localhost:8765
```

Data persists in `./data/` (a SQLite WAL file). Stop with `make docker-down`.

### Option B — Local Python (with [uv](https://docs.astral.sh/uv/))

```bash
git clone https://github.com/morapet/devlog.git
cd devlog
make install          # uv sync
make drawio           # download + install the drawio webapp (~120 MB, one-time)
make dev              # uv run devlog
open http://127.0.0.1:8765
```

Data goes to `~/.local/share/devlog/devlog.db` (or `$XDG_DATA_HOME/devlog/` if set).

### Option C — Install as a CLI tool

```bash
uv tool install git+https://github.com/morapet/devlog.git
devlog                # starts the backend
bash $(uv tool dir)/devlog/scripts/install-drawio.sh   # if you want drawings
```

## macOS menu-bar tray (optional)

Native SwiftUI menu-bar app. Requires Swift / CommandLineTools.

```bash
make tray
# or:
cd clients/mac-tray && ./build.sh && open .build/Devlog.app
```

The icon in the menu bar shows the currently-doing task or today's count. Capture window has Task/Note/Link tabs.

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

## License

[MIT](LICENSE)
