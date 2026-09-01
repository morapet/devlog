"""Lightweight single-secret authentication.

Model: the owner's own machine is trusted (loopback), share links are public,
and everything else requires a shared secret when the request comes from another
device. This protects the API once the backend is bound to the LAN (0.0.0.0)
without adding friction for localhost clients (the browser on this machine, the
MCP server, the native app in Managed mode).

The secret is a random token, taken from DEVLOG_AUTH_TOKEN or auto-generated
once into <data_dir>/auth.token (chmod 600). Retrieve it with `devlog --print-token`.

Modes (env DEVLOG_AUTH):
    auto   (default) trust loopback, require the secret for remote requests
    always require the secret even on loopback
    off    disable auth entirely
"""

import hashlib
import hmac
import os
import secrets
import time
from pathlib import Path

from .config import data_dir

SESSION_COOKIE = "devlog_session"
SESSION_TTL = 30 * 24 * 3600  # 30 days

# Paths reachable without auth: the app shell, health, the PWA bits, static
# assets, the auth endpoints, and — crucially — share links.
_PUBLIC_EXACT = {"/", "/health", "/sw.js", "/manifest.json", "/favicon.ico", "/apple-touch-icon.png"}
_PUBLIC_PREFIX = ("/static/", "/share/", "/shares/", "/auth/")

_secret_cache: str | None = None


def auth_mode() -> str:
    m = os.environ.get("DEVLOG_AUTH", "auto").lower()
    return m if m in ("auto", "always", "off") else "auto"


def _token_file() -> Path:
    return data_dir() / "auth.token"


def get_secret() -> str:
    """The shared secret. Env wins; otherwise read/create the token file."""
    global _secret_cache
    env = os.environ.get("DEVLOG_AUTH_TOKEN")
    if env:
        return env
    if _secret_cache:
        return _secret_cache
    f = _token_file()
    try:
        tok = f.read_text().strip()
        if tok:
            _secret_cache = tok
            return tok
    except OSError:
        pass
    data_dir().mkdir(parents=True, exist_ok=True)
    tok = secrets.token_urlsafe(32)
    f.write_text(tok)
    try:
        os.chmod(f, 0o600)
    except OSError:
        pass
    _secret_cache = tok
    return tok


def _sign(msg: str) -> str:
    return hmac.new(get_secret().encode(), msg.encode(), hashlib.sha256).hexdigest()


def make_session() -> str:
    exp = str(int(time.time()) + SESSION_TTL)
    return f"{exp}.{_sign('session|' + exp)}"


def verify_session(value: str | None) -> bool:
    if not value or "." not in value:
        return False
    exp, sig = value.split(".", 1)
    if not exp.isdigit() or int(exp) < time.time():
        return False
    return hmac.compare_digest(sig, _sign("session|" + exp))


def check_token(token: str | None) -> bool:
    if not token:
        return False
    return hmac.compare_digest(str(token), get_secret())


def is_public(path: str) -> bool:
    return path in _PUBLIC_EXACT or any(path.startswith(p) for p in _PUBLIC_PREFIX)


def is_loopback(host: str | None) -> bool:
    return host in ("127.0.0.1", "::1", "localhost")


def request_allowed(*, path: str, client_host: str | None, cookies, headers) -> bool:
    """Central allow decision used by the HTTP middleware."""
    mode = auth_mode()
    if mode == "off":
        return True
    if is_public(path):
        return True
    if mode != "always" and is_loopback(client_host):
        return True
    if verify_session(cookies.get(SESSION_COOKIE)):
        return True
    authz = headers.get("authorization", "")
    if authz.lower().startswith("bearer ") and check_token(authz[7:].strip()):
        return True
    if check_token(headers.get("x-devlog-token")):
        return True
    return False


def auth_required_for(client_host: str | None) -> bool:
    """Whether a non-public request from this client would need the secret."""
    mode = auth_mode()
    if mode == "off":
        return False
    if mode != "always" and is_loopback(client_host):
        return False
    return True
