#!/usr/bin/env python3
"""Devlog tray for GNOME / Ubuntu via libayatana-appindicator.

Tested on Ubuntu 22.04 + GNOME 42 (X11). Mirrors the macOS tray's menu:

    ▶ <doing task>                ▸ ⏸ Pause | ✓ Done
    ─────
    Bookmarks
      <project> ▸ <link …>
    ─────
    Today (N)
      <project> ▸ <task> ▸ ▶ Start | ✓ Done
    ─────
    Capture / New project / Open Web UI
    ─────
    Refresh / Quit

Polls the local devlog backend every 5 s. Override the URL with DEVLOG_BASE_URL.
"""
from __future__ import annotations

import json
import os
import subprocess
import threading
import urllib.error
import urllib.parse
import urllib.request
from urllib.parse import urlparse

import gi

gi.require_version("Gtk", "3.0")
try:
    gi.require_version("AyatanaAppIndicator3", "0.1")
    from gi.repository import AyatanaAppIndicator3 as AppIndicator
except (ValueError, ImportError):
    # Fall back to the legacy AppIndicator3 binding if Ayatana isn't installed.
    gi.require_version("AppIndicator3", "0.1")
    from gi.repository import AppIndicator3 as AppIndicator  # type: ignore

from gi.repository import GLib, Gtk  # noqa: E402

BASE = os.environ.get("DEVLOG_BASE_URL", "http://127.0.0.1:8765")
HERE = os.path.dirname(os.path.abspath(__file__))

# Symbolic icon name (resolved via the XDG icon theme so the panel auto-recolors
# it on dark/light themes). install.sh drops the SVG at
# ~/.local/share/icons/hicolor/symbolic/apps/devlog-tray-symbolic.svg so this
# name resolves locally; otherwise we fall back to a system theme icon.
ICON_NAME = os.environ.get("DEVLOG_TRAY_ICON", "devlog-tray-symbolic")
ICON_FALLBACK_NAME = "task-due-symbolic"
ICON_PATH_FALLBACK = os.path.join(HERE, "devlog-symbolic.svg")

REFRESH_SECONDS = 5


# ---------- HTTP helpers (stdlib only — no external deps) ----------
def _request(method: str, path: str, body=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            raw = r.read()
            if not raw:
                return None
            return json.loads(raw)
    except (urllib.error.URLError, TimeoutError, ConnectionError):
        return None


def api_get(path):    return _request("GET", path)
def api_post(path, body=None):  return _request("POST", path, body)
def api_patch(path, body):     return _request("PATCH", path, body)


# ---------- label helpers ----------
def truncate(text: str, n: int) -> str:
    if not text:
        return ""
    return text if len(text) <= n else text[: n - 1] + "…"


def link_label(link: dict) -> str:
    lbl = (link.get("display_label") or "").strip()
    if lbl:
        return lbl
    t = (link.get("title") or "").strip()
    if t:
        return truncate(t, 40)
    url = link.get("url") or ""
    try:
        host = urlparse(url).hostname or url
        return host[4:] if host.startswith("www.") else host
    except Exception:
        return url or "(untitled)"


def task_label(item: dict) -> str:
    return truncate((item.get("title") or "").strip(), 40) or "(untitled)"


def project_sort_key(pid: int, current_id, project_by_id: dict):
    p = project_by_id.get(pid, {})
    return (0 if pid == current_id else 1, (p.get("name") or "").lower())


# ---------- Tray ----------
def _resolve_icon() -> str:
    """Prefer a named symbolic icon (theme-recoloured by GNOME); fall back to
    the bundled SVG file path, then to a guaranteed system icon."""
    from gi.repository import Gtk
    theme = Gtk.IconTheme.get_default()
    for name in (ICON_NAME, ICON_FALLBACK_NAME):
        if theme.has_icon(name):
            return name
    if os.path.isfile(ICON_PATH_FALLBACK):
        return ICON_PATH_FALLBACK
    return "applications-utilities"  # always present


class DevlogTray:
    def __init__(self) -> None:
        icon = _resolve_icon()
        self.ind = AppIndicator.Indicator.new(
            "devlog-tray", icon,
            AppIndicator.IndicatorCategory.APPLICATION_STATUS,
        )
        self.ind.set_status(AppIndicator.IndicatorStatus.ACTIVE)
        self.ind.set_title("Devlog")
        # Keep a strong reference to the current menu (and to all the lambda
        # closures it contains). Without this, the menu can be GC'd shortly
        # after set_menu() and clicks no longer dispatch through dbusmenu.
        self._menu = self._loading_menu()
        self.ind.set_menu(self._menu)
        self.schedule_refresh()
        GLib.timeout_add_seconds(REFRESH_SECONDS, self._tick)

    def _mk_item(self, label: str, action=None):
        """Create a Gtk.MenuItem using the canonical constructor and wire the
        activate signal (more reliable through dbusmenu than the kwarg form)."""
        item = Gtk.MenuItem.new_with_label(label)
        if action is not None:
            item.connect("activate", lambda _w: action())
        return item

    def _loading_menu(self) -> Gtk.Menu:
        m = Gtk.Menu()
        loading = self._mk_item("Connecting…"); loading.set_sensitive(False)
        m.append(loading)
        m.append(Gtk.SeparatorMenuItem())
        m.append(self._mk_item("Quit", Gtk.main_quit))
        m.show_all()
        return m

    def _tick(self) -> bool:
        self.schedule_refresh()
        return True  # keep the GLib timer alive

    def schedule_refresh(self) -> None:
        threading.Thread(target=self._fetch, daemon=True).start()

    def _fetch(self) -> None:
        projects  = api_get("/projects") or []
        current   = api_get("/projects/current/resolve")
        doing     = api_get("/items?kind=task&status=doing&limit=1") or []
        today     = api_get("/items?kind=task&status=today&limit=50") or []
        bookmarks = api_get("/items?kind=link&is_pinned=true&limit=200") or []
        GLib.idle_add(self._rebuild, projects, current, doing, today, bookmarks)

    # ---------- menu construction ----------
    def _rebuild(self, projects, current, doing, today, bookmarks) -> bool:
        connected = projects is not None
        menu = Gtk.Menu()
        proj_by_id = {p["id"]: p for p in (projects or [])}
        cur_id = current["id"] if current else None

        if not connected:
            offline = self._mk_item("Backend offline"); offline.set_sensitive(False)
            menu.append(offline)
            menu.append(Gtk.SeparatorMenuItem())
        else:
            # ── Doing (top-level) ──
            if doing:
                d = doing[0]
                d_id = d["id"]
                top = self._mk_item("▶ " + task_label(d))
                sub = Gtk.Menu()
                sub.append(self._mk_item("⏸ Pause (move to Today)",
                                         lambda did=d_id: self._update_task(did, "today")))
                sub.append(self._mk_item("✓ Mark done",
                                         lambda did=d_id: self._mark_done(did)))
                top.set_submenu(sub)
                menu.append(top)
                menu.append(Gtk.SeparatorMenuItem())

            # ── Bookmarks per project ──
            b_by: dict[int, list] = {}
            for b in bookmarks or []:
                b_by.setdefault(b["project_id"], []).append(b)
            if b_by:
                h = self._mk_item("Bookmarks"); h.set_sensitive(False)
                menu.append(h)
                for pid in sorted(b_by.keys(), key=lambda x: project_sort_key(x, cur_id, proj_by_id)):
                    p = proj_by_id.get(pid)
                    if not p:
                        continue
                    suffix = " (current)" if pid == cur_id else ""
                    pitem = self._mk_item(f"  {p['name']}{suffix} · {len(b_by[pid])}")
                    sub = Gtk.Menu()
                    for link in b_by[pid][:25]:
                        url = link.get("url")
                        sub.append(self._mk_item(link_label(link),
                                                 lambda u=url: self._open(u)))
                    pitem.set_submenu(sub)
                    menu.append(pitem)
                menu.append(Gtk.SeparatorMenuItem())

            # ── Today per project ──
            t_by: dict[int, list] = {}
            for t in today or []:
                t_by.setdefault(t["project_id"], []).append(t)
            if t_by:
                total = sum(len(v) for v in t_by.values())
                h = self._mk_item(f"Today ({total})"); h.set_sensitive(False)
                menu.append(h)
                for pid in sorted(t_by.keys(), key=lambda x: project_sort_key(x, cur_id, proj_by_id)):
                    p = proj_by_id.get(pid)
                    if not p:
                        continue
                    suffix = " (current)" if pid == cur_id else ""
                    pitem = self._mk_item(f"  {p['name']}{suffix} · {len(t_by[pid])}")
                    sub = Gtk.Menu()
                    for task in t_by[pid][:20]:
                        tid = task["id"]
                        ti = self._mk_item(task_label(task))
                        actions = Gtk.Menu()
                        actions.append(self._mk_item("▶ Start (mark doing)",
                                                     lambda t_=tid: self._mark_doing(t_)))
                        actions.append(self._mk_item("✓ Mark done",
                                                     lambda t_=tid: self._mark_done(t_)))
                        ti.set_submenu(actions)
                        sub.append(ti)
                    pitem.set_submenu(sub)
                    menu.append(pitem)
                menu.append(Gtk.SeparatorMenuItem())

        # ── Actions ──
        menu.append(self._mk_item("Capture (Web UI)…",      lambda: self._open(BASE + "/")))
        menu.append(self._mk_item("New project (Web UI)…",  lambda: self._open(BASE + "/")))
        menu.append(self._mk_item("Open Web UI",            lambda: self._open(BASE + "/")))
        menu.append(Gtk.SeparatorMenuItem())
        menu.append(self._mk_item("Refresh",                self.schedule_refresh))
        menu.append(self._mk_item("Quit Devlog",            Gtk.main_quit))

        menu.show_all()
        # Replace the current menu and KEEP A REFERENCE so its handler closures
        # aren't garbage-collected (a common reason indicator clicks silently
        # do nothing after the first refresh cycle).
        self._menu = menu
        self.ind.set_menu(menu)

        # Status-bar label next to the icon (works in Ayatana, ignored elsewhere).
        if doing:
            self.ind.set_label("▶ " + truncate(doing[0].get("title") or "", 24), "")
        elif today:
            self.ind.set_label(f"{len(today)} today", "")
        else:
            self.ind.set_label("", "")
        return False  # idle_add: do not repeat

    # ---------- actions ----------
    def _open(self, url: str) -> None:
        if not url:
            return
        print(f"[devlog-tray] open: {url}", flush=True)
        try:
            subprocess.Popen(["xdg-open", url],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except FileNotFoundError:
            print("[devlog-tray] xdg-open not found — install xdg-utils", flush=True)

    def _update_task(self, task_id: int, status: str) -> None:
        print(f"[devlog-tray] PATCH /tasks/{task_id} status={status}", flush=True)
        threading.Thread(target=lambda: (api_patch(f"/tasks/{task_id}", {"status": status}),
                                         GLib.idle_add(self.schedule_refresh)),
                         daemon=True).start()

    def _mark_done(self, task_id: int) -> None:
        print(f"[devlog-tray] POST /tasks/{task_id}/done", flush=True)
        threading.Thread(target=lambda: (api_post(f"/tasks/{task_id}/done"),
                                         GLib.idle_add(self.schedule_refresh)),
                         daemon=True).start()

    def _mark_doing(self, task_id: int) -> None:
        print(f"[devlog-tray] POST /tasks/{task_id}/doing", flush=True)
        threading.Thread(target=lambda: (api_post(f"/tasks/{task_id}/doing"),
                                         GLib.idle_add(self.schedule_refresh)),
                         daemon=True).start()


def main() -> None:
    DevlogTray()
    Gtk.main()


if __name__ == "__main__":
    main()
