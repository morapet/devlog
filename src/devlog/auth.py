"""Optional single-user password auth.

Set DEVLOG_PASSWORD to enable. When unset (the default), devlog behaves as
before — no login, intended for localhost / trusted-LAN use. When set, every
request must carry a valid session cookie (browser, via /login) or an
`Authorization: Bearer <password>` header (MCP server, scripts).

Sessions are `<expiry>.<hmac>` tokens signed with a random per-install secret
kept next to the database, so restarting the server doesn't log anyone out.
"""
import hashlib
import hmac
import os
import secrets
import time

from fastapi import APIRouter, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse

from .config import data_dir

PASSWORD = os.environ.get("DEVLOG_PASSWORD", "")

COOKIE = "devlog_session"
SESSION_DAYS = 90

# Paths that must work without auth: the login flow itself, health checks,
# and the static app shell (no user data lives there; the login page and the
# PWA bootstrap need it).
_OPEN_PREFIXES = ("/auth/", "/static/")
_OPEN_PATHS = ("/login", "/health", "/sw.js", "/manifest.json")


def _secret() -> bytes:
    """Random per-install signing key, created on first use."""
    path = data_dir() / "session-secret"
    try:
        return path.read_bytes()
    except FileNotFoundError:
        path.parent.mkdir(parents=True, exist_ok=True)
        key = secrets.token_bytes(32)
        path.write_bytes(key)
        try:
            path.chmod(0o600)
        except OSError:
            pass
        return key


def _sign(expiry: int) -> str:
    mac = hmac.new(_secret(), str(expiry).encode(), hashlib.sha256).hexdigest()
    return f"{expiry}.{mac}"


def _valid_session(token: str | None) -> bool:
    if not token or "." not in token:
        return False
    expiry_s, _, mac = token.partition(".")
    try:
        expiry = int(expiry_s)
    except ValueError:
        return False
    if expiry < time.time():
        return False
    expected = hmac.new(_secret(), expiry_s.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(mac, expected)


def _valid_bearer(request: Request) -> bool:
    header = request.headers.get("authorization", "")
    scheme, _, value = header.partition(" ")
    return scheme.lower() == "bearer" and hmac.compare_digest(value, PASSWORD)


def _is_navigation(request: Request) -> bool:
    """Browser address-bar / link navigation, as opposed to fetch/XHR/SW.

    Redirecting only navigations to /login keeps the service worker from ever
    caching the login page under "/", and gives API callers a clean 401.
    """
    mode = request.headers.get("sec-fetch-mode")
    if mode is not None:
        return mode == "navigate"
    return "text/html" in request.headers.get("accept", "")


async def middleware(request: Request, call_next):
    if not PASSWORD:
        return await call_next(request)
    path = request.url.path
    if path in _OPEN_PATHS or path.startswith(_OPEN_PREFIXES):
        return await call_next(request)
    if _valid_session(request.cookies.get(COOKIE)) or _valid_bearer(request):
        return await call_next(request)
    if request.method == "GET" and _is_navigation(request):
        return RedirectResponse("/login", status_code=302)
    return JSONResponse({"detail": "Not authenticated"}, status_code=401)


def _set_session_cookie(request: Request, response: Response) -> None:
    expiry = int(time.time()) + SESSION_DAYS * 86400
    secure = (
        request.url.scheme == "https"
        or request.headers.get("x-forwarded-proto", "").startswith("https")
    )
    response.set_cookie(
        COOKIE,
        _sign(expiry),
        max_age=SESSION_DAYS * 86400,
        httponly=True,
        samesite="lax",
        secure=secure,
    )


router = APIRouter()


@router.post("/auth/login")
async def login(request: Request) -> Response:
    body = await request.json()
    supplied = str(body.get("password", ""))
    if not PASSWORD or not hmac.compare_digest(supplied, PASSWORD):
        time.sleep(0.5)  # slow down brute force
        return JSONResponse({"detail": "Wrong password"}, status_code=401)
    response = Response(status_code=204)
    _set_session_cookie(request, response)
    return response


@router.post("/auth/logout")
def logout() -> Response:
    response = Response(status_code=204)
    response.delete_cookie(COOKIE)
    return response


@router.get("/auth/status")
def status(request: Request) -> dict:
    return {
        "auth_enabled": bool(PASSWORD),
        "authenticated": not PASSWORD or _valid_session(request.cookies.get(COOKIE)),
    }


_LOGIN_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Devlog — sign in</title>
<link rel="icon" type="image/svg+xml" href="/static/icon.svg" />
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #f8fafc; color: #0f172a;
         font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  form { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 2rem;
         width: min(20rem, calc(100vw - 3rem)); box-shadow: 0 10px 25px rgb(0 0 0 / 0.06);
         display: flex; flex-direction: column; gap: 0.75rem; }
  img  { width: 48px; height: 48px; border-radius: 10px; margin: 0 auto 0.25rem; }
  h1   { font-size: 1.05rem; font-weight: 600; text-align: center; margin: 0 0 0.5rem; }
  input { font-size: 16px; padding: 0.6rem 0.75rem; border: 1px solid #cbd5e1; border-radius: 8px; }
  input:focus { outline: 2px solid #bfdbfe; border-color: #93c5fd; }
  button { font-size: 0.95rem; font-weight: 500; padding: 0.6rem; border: 0; border-radius: 8px;
           background: #0f172a; color: #fff; cursor: pointer; }
  button:hover { background: #1e293b; }
  #err { color: #b91c1c; font-size: 0.85rem; min-height: 1.1em; text-align: center; margin: 0; }
</style>
</head>
<body>
<form id="f">
  <img src="/static/icon.svg" alt="" />
  <h1>Sign in to devlog</h1>
  <input id="pw" type="password" placeholder="Password" autofocus autocomplete="current-password" />
  <button type="submit">Sign in</button>
  <p id="err"></p>
</form>
<script>
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("err");
  err.textContent = "";
  const r = await fetch("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: document.getElementById("pw").value }),
  });
  if (r.ok) location.href = "/";
  else err.textContent = r.status === 401 ? "Wrong password." : "Login failed (" + r.status + ").";
});
</script>
</body>
</html>
"""


@router.get("/login", include_in_schema=False)
def login_page() -> Response:
    if not PASSWORD:
        return RedirectResponse("/")  # auth disabled — nothing to sign in to
    return HTMLResponse(_LOGIN_PAGE)
