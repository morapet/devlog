"""Private VPN mode: trust requests by who the VPN says they come from.

Enabled with DEVLOG_AUTH=private-vpn. A request from a VPN peer is allowed
without the shared secret when either:

  * its source address is a Tailscale peer whose user login is listed in
    DEVLOG_VPN_USERS (or which carries a tag listed in DEVLOG_VPN_TAGS) — the
    local tailscaled is asked who owns the address, so this is per-user; or
  * its source address falls inside a network listed in DEVLOG_VPN_CIDRS — for
    VPNs that have no notion of identity (plain WireGuard, ZeroTier, …). Every
    device on that network is trusted, so keep the range tight.

Anything else falls through to the normal shared-secret check, so a device
outside the VPN can still log in with the token.

Config (all comma-separated):
    DEVLOG_VPN_USERS          Tailscale logins, e.g. "alice@github,bob@example.com"
    DEVLOG_VPN_TAGS           Tailscale tags, e.g. "tag:laptop"
    DEVLOG_VPN_CIDRS          networks, e.g. "10.8.0.0/24"
    DEVLOG_TAILSCALE_SOCKET   tailscaled socket path (default: the Linux paths)
    DEVLOG_TAILSCALE_BIN      tailscale CLI path (default: found on PATH)
"""

import ipaddress
import json
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path

import httpx

_SOCKETS = ("/var/run/tailscale/tailscaled.sock", "/run/tailscale/tailscaled.sock")
_MAC_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
_LOOKUP_TIMEOUT = 3.0
_HIT_TTL = 60.0   # how long a successful whois is reused
_MISS_TTL = 10.0  # how long "not a peer / lookup failed" is reused
_CACHE_MAX = 512

# ip -> (expires_at, identity or None)
_cache: dict[str, tuple[float, tuple[str, frozenset[str]] | None]] = {}
_cache_lock = threading.Lock()


def _csv(name: str) -> list[str]:
    return [p.strip() for p in os.environ.get(name, "").split(",") if p.strip()]


def allowed_users() -> set[str]:
    return {u.lower() for u in _csv("DEVLOG_VPN_USERS")}


def allowed_tags() -> set[str]:
    return {t.lower() for t in _csv("DEVLOG_VPN_TAGS")}


def allowed_networks() -> list[ipaddress.IPv4Network | ipaddress.IPv6Network]:
    nets = []
    for raw in _csv("DEVLOG_VPN_CIDRS"):
        try:
            nets.append(ipaddress.ip_network(raw, strict=False))
        except ValueError:
            print(f"[auth] ignoring invalid DEVLOG_VPN_CIDRS entry: {raw!r}")
    return nets


def _socket_path() -> str | None:
    env = os.environ.get("DEVLOG_TAILSCALE_SOCKET")
    if env:
        return env
    return next((p for p in _SOCKETS if Path(p).exists()), None)


def _cli_path() -> str | None:
    env = os.environ.get("DEVLOG_TAILSCALE_BIN")
    if env:
        return env
    found = shutil.which("tailscale")
    if found:
        return found
    return _MAC_CLI if Path(_MAC_CLI).exists() else None


def _whois_raw(ip: str) -> dict | None:
    """Ask the local tailscaled who owns ``ip``. None if unknown / unavailable."""
    sock = _socket_path()
    if sock:
        try:
            with httpx.Client(transport=httpx.HTTPTransport(uds=sock), timeout=_LOOKUP_TIMEOUT) as cx:
                r = cx.get("http://local-tailscaled.sock/localapi/v0/whois", params={"addr": ip})
            return r.json() if r.status_code == 200 else None
        except (httpx.HTTPError, ValueError):
            return None
    cli = _cli_path()
    if not cli:
        return None
    try:
        out = subprocess.run(
            [cli, "whois", "--json", ip],
            capture_output=True, text=True, timeout=_LOOKUP_TIMEOUT, check=False,
        )
        return json.loads(out.stdout)
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def _parse(data: dict | None) -> tuple[str, frozenset[str]] | None:
    if not isinstance(data, dict):
        return None
    node = data.get("Node") or {}
    profile = data.get("UserProfile") or {}
    tags = frozenset(str(t).lower() for t in (node.get("Tags") or []))
    # A tagged device has no owner; Tailscale reports a placeholder login for it.
    login = "" if tags else str(profile.get("LoginName") or "").lower()
    if not login and not tags:
        return None
    return login, tags


def whois(ip: str) -> tuple[str, frozenset[str]] | None:
    """(login, tags) of the Tailscale peer at ``ip``, cached briefly."""
    now = time.monotonic()
    with _cache_lock:
        hit = _cache.get(ip)
        if hit and hit[0] > now:
            return hit[1]
    ident = _parse(_whois_raw(ip))
    with _cache_lock:
        if len(_cache) >= _CACHE_MAX:
            _cache.clear()
        _cache[ip] = (now + (_HIT_TTL if ident else _MISS_TTL), ident)
    return ident


def vpn_allowed(client_host: str | None) -> bool:
    """Whether this source address is a trusted private-VPN peer."""
    if not client_host:
        return False
    try:
        addr = ipaddress.ip_address(client_host)
    except ValueError:
        return False
    if any(addr in net for net in allowed_networks()):
        return True
    users, tags = allowed_users(), allowed_tags()
    if not users and not tags:
        return False
    ident = whois(str(addr))
    if not ident:
        return False
    login, peer_tags = ident
    return (bool(login) and login in users) or bool(peer_tags & tags)


def describe() -> str:
    """One-line summary of the configured trust, for the startup log."""
    parts = []
    if allowed_users():
        parts.append("Tailscale users: " + ", ".join(sorted(allowed_users())))
    if allowed_tags():
        parts.append("Tailscale tags: " + ", ".join(sorted(allowed_tags())))
    nets = allowed_networks()
    if nets:
        parts.append("networks: " + ", ".join(str(n) for n in nets))
    if not parts:
        return ("private-vpn mode has nothing to trust — set DEVLOG_VPN_USERS, "
                "DEVLOG_VPN_TAGS or DEVLOG_VPN_CIDRS (falling back to the token)")
    if (allowed_users() or allowed_tags()) and not (_socket_path() or _cli_path()):
        parts.append("WARNING: no tailscaled socket or tailscale CLI found, Tailscale lookups will fail")
    return "private-vpn mode trusts " + "; ".join(parts)
