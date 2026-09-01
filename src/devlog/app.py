import asyncio
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .api.attachments import router as attachments_router
from .api.auth import router as auth_router
from .api.backups import router as backups_router
from .api.items import router as items_router
from .api.portability import router as portability_router
from .api.projects import router as projects_router
from .api.search import router as search_router
from .api.sessions import router as sessions_router
from .api.settings import router as settings_router
from .api.shares import router as shares_router
from .api.stats import router as stats_router
from .autostop import auto_stop_loop
from .autostop import check_once as autostop_check_once
from .db import conn

WEB_DIR = Path(__file__).parent / "web"

app = FastAPI(title="devlog", version="0.1.0")


@app.middleware("http")
async def _auth_gate(request: Request, call_next):
    from .auth import request_allowed

    host = request.client.host if request.client else None
    if request_allowed(
        path=request.url.path, client_host=host,
        cookies=request.cookies, headers=request.headers,
    ):
        return await call_next(request)
    return JSONResponse({"detail": "authentication required"}, status_code=401)


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
app.include_router(portability_router)
app.include_router(backups_router)
app.include_router(shares_router)
app.include_router(auth_router)

app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")


@app.get("/", include_in_schema=False)
def web_root() -> FileResponse:
    return FileResponse(WEB_DIR / "index.html")


# Standalone read-only share page. The token is read from the path by share.js,
# which fetches /shares/<token>/data. Served for any token; the page itself shows
# an expired/invalid message when the data call fails.
@app.get("/share/{token}", include_in_schema=False)
def share_page(token: str) -> FileResponse:
    return FileResponse(WEB_DIR / "share.html")


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
