import asyncio
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .api.attachments import router as attachments_router
from .api.items import router as items_router
from .api.projects import router as projects_router
from .api.search import router as search_router
from .api.sessions import router as sessions_router
from .api.settings import router as settings_router
from .api.stats import router as stats_router
from .autostop import auto_stop_loop
from .autostop import check_once as autostop_check_once
from .db import conn

WEB_DIR = Path(__file__).parent / "web"

app = FastAPI(title="devlog", version="0.1.0")


@app.on_event("startup")
async def _init() -> None:
    conn()  # ensures schema is created
    # one immediate pass cleans up any dangling doing tasks from prior runs
    try:
        autostop_check_once()
    except Exception as e:  # noqa: BLE001
        print(f"[autostop] initial check failed: {e!r}")
    app.state._autostop_task = asyncio.create_task(auto_stop_loop())


@app.get("/health")
def health() -> dict:
    return {"ok": True}


app.include_router(projects_router)
app.include_router(items_router)
app.include_router(sessions_router)
app.include_router(attachments_router)
app.include_router(search_router)
app.include_router(settings_router)
app.include_router(stats_router)

app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")


@app.get("/", include_in_schema=False)
def web_root() -> FileResponse:
    return FileResponse(WEB_DIR / "index.html")


# Service worker has to be served from the root (not from /static/sw.js) so its
# scope can cover the entire origin — that's a hard browser requirement.
@app.get("/sw.js", include_in_schema=False)
def service_worker() -> FileResponse:
    return FileResponse(
        WEB_DIR / "sw.js",
        media_type="application/javascript",
        headers={"Service-Worker-Allowed": "/", "Cache-Control": "no-cache"},
    )


# Manifest at the root too, for clients that don't look under /static/.
@app.get("/manifest.json", include_in_schema=False)
def web_manifest() -> FileResponse:
    return FileResponse(WEB_DIR / "manifest.json", media_type="application/manifest+json")
