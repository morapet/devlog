#!/usr/bin/env python3
"""Devlog desktop app for Linux (GTK3 + WebKit2GTK).

The Linux analog of the macOS app: a real window embedding the devlog web UI
via a WebKit2 web view, with the same two backend modes:

    - connect : thin client to a backend you already run (systemd service,
                Docker, or `devlog` in a terminal). Default.
    - managed : the app spawns and supervises its own backend, picking a free
                port and tearing it down on quit.

Configuration (first match wins):
    env DEVLOG_APP_MODE = connect | managed
    env DEVLOG_BASE_URL = http://host:port        (connect mode target)
    env DEVLOG_PORT     = 8765                     (managed preferred port; 0=auto)
    ~/.config/devlog/app.json  { "mode", "connect_url", "managed_port", "dev_repo" }

Dependencies (apt): python3-gi, gir1.2-gtk-3.0, and gir1.2-webkit2-4.1
(or 4.0 on older Ubuntu). See install.sh.
"""
from __future__ import annotations

import json
import os
import shutil
import signal
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import gi

gi.require_version("Gtk", "3.0")
# WebKit2GTK ships as 4.1 on Ubuntu 23.10+ and 4.0 on 22.04. Try newest first.
WebKit2 = None
for _v in ("4.1", "4.0"):
    try:
        gi.require_version("WebKit2", _v)
        from gi.repository import WebKit2 as _WK  # type: ignore
        WebKit2 = _WK
        break
    except (ValueError, ImportError):
        continue

from gi.repository import Gdk, Gio, GLib, Gtk  # noqa: E402

CONFIG_PATH = Path(
    os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))
) / "devlog" / "app.json"

DEFAULT_URL = "http://127.0.0.1:8765"


# ---------- configuration ----------
def load_config() -> dict:
    cfg = {"mode": "connect", "connect_url": DEFAULT_URL, "managed_port": 8765, "dev_repo": ""}
    try:
        cfg.update(json.loads(CONFIG_PATH.read_text()))
    except (OSError, ValueError):
        pass
    # Environment overrides.
    if v := os.environ.get("DEVLOG_APP_MODE"):
        cfg["mode"] = v
    if v := os.environ.get("DEVLOG_BASE_URL"):
        cfg["connect_url"] = v
    if v := os.environ.get("DEVLOG_PORT"):
        try:
            cfg["managed_port"] = int(v)
        except ValueError:
            pass
    if v := os.environ.get("DEVLOG_DEV_REPO"):
        cfg["dev_repo"] = v
    return cfg


def save_config(cfg: dict) -> None:
    try:
        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        CONFIG_PATH.write_text(json.dumps(cfg, indent=2))
    except OSError:
        pass


# ---------- backend supervisor (managed mode) ----------
class Supervisor:
    """Spawns and babysits a local devlog backend."""

    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.proc: subprocess.Popen | None = None
        self.port: int | None = None

    def _resolve_port(self) -> int:
        pref = int(self.cfg.get("managed_port") or 0)
        if pref > 0 and self._free(pref):
            return pref
        # Ask the OS for any free port.
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]

    @staticmethod
    def _free(port: int) -> bool:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", port))
                return True
            except OSError:
                return False

    def _command(self, port: int) -> list[str]:
        # Prefer a `devlog` on PATH (installed backend); fall back to a dev
        # checkout via uv.
        exe = shutil.which("devlog")
        if exe:
            return [exe, "--host", "127.0.0.1", "--port", str(port)]
        repo = self.cfg.get("dev_repo") or ""
        uv = shutil.which("uv")
        if repo and uv:
            return [uv, "run", "--directory", repo, "devlog", "--host", "127.0.0.1", "--port", str(port)]
        raise RuntimeError(
            "No backend found. Install the devlog package (so `devlog` is on "
            "PATH), or set dev_repo in the config to run it via uv, or use "
            "connect mode."
        )

    def start(self) -> str:
        """Blocking: launch the backend and wait for /health. Returns base URL."""
        self.port = self._resolve_port()
        env = dict(os.environ)
        env.setdefault("DEVLOG_DATA_DIR", str(Path.home() / ".local/share/devlog"))
        env["DEVLOG_HOST"] = "127.0.0.1"
        env["DEVLOG_PORT"] = str(self.port)
        self.proc = subprocess.Popen(self._command(self.port), env=env)
        base = f"http://127.0.0.1:{self.port}"
        if not self._wait_health(base, timeout=20):
            self.stop()
            raise RuntimeError(f"Backend did not become healthy on port {self.port}.")
        return base

    @staticmethod
    def _wait_health(base: str, timeout: float) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(f"{base}/health", timeout=2) as r:
                    if r.status == 200:
                        return True
            except (urllib.error.URLError, OSError):
                pass
            time.sleep(0.4)
        return False

    def stop(self) -> None:
        p = self.proc
        self.proc = None
        if not p or p.poll() is not None:
            return
        p.terminate()
        try:
            p.wait(timeout=3)
        except subprocess.TimeoutExpired:
            p.kill()


# ---------- main window ----------
class DevlogWindow(Gtk.ApplicationWindow):
    def __init__(self, app: "DevlogApp"):
        super().__init__(application=app, title="Devlog")
        self.app = app
        self.set_default_size(1100, 720)
        self.set_icon_name("devlog")

        header = Gtk.HeaderBar(title="Devlog", show_close_button=True)
        self.set_titlebar(header)

        reload_btn = Gtk.Button.new_from_icon_name("view-refresh-symbolic", Gtk.IconSize.BUTTON)
        reload_btn.set_tooltip_text("Reload (Ctrl+R)")
        reload_btn.connect("clicked", lambda *_: self.reload())
        header.pack_start(reload_btn)

        browser_btn = Gtk.Button.new_from_icon_name("web-browser-symbolic", Gtk.IconSize.BUTTON)
        browser_btn.set_tooltip_text("Open in web browser")
        browser_btn.connect("clicked", lambda *_: self.open_external())
        header.pack_end(browser_btn)

        settings_btn = Gtk.Button.new_from_icon_name("emblem-system-symbolic", Gtk.IconSize.BUTTON)
        settings_btn.set_tooltip_text("Settings")
        settings_btn.connect("clicked", lambda *_: self.app.open_settings(self))
        header.pack_end(settings_btn)

        if WebKit2 is None:
            self.add(_missing_webkit_view())
            return

        self.webview = WebKit2.WebView()
        self.webview.connect("decide-policy", self._on_decide_policy)
        self.add(self.webview)

        # Ctrl+R reload.
        accels = Gtk.AccelGroup()
        self.add_accel_group(accels)
        accels.connect(Gdk.KEY_r, Gdk.ModifierType.CONTROL_MASK,
                       Gtk.AccelFlags.VISIBLE, lambda *_: bool(self.reload()) or True)

    def load(self, base_url: str) -> None:
        self.app.base_url = base_url
        if WebKit2 is not None:
            self.webview.load_uri(base_url)

    def reload(self) -> None:
        if WebKit2 is not None and self.app.base_url:
            self.webview.load_uri(self.app.base_url)

    def open_external(self) -> None:
        if self.app.base_url:
            Gtk.show_uri_on_window(self, self.app.base_url, Gtk.get_current_event_time())

    def _on_decide_policy(self, webview, decision, decision_type):
        # Open off-origin link clicks in the system browser; keep same-origin in-app.
        if decision_type != WebKit2.PolicyDecisionType.NAVIGATION_ACTION:
            return False
        nav = decision.get_navigation_action()
        req = nav.get_request()
        uri = req.get_uri() or ""
        base = self.app.base_url or ""
        if uri.startswith(base) or uri.startswith("about:") or uri.startswith("data:"):
            return False  # allow default
        if nav.get_navigation_type() == WebKit2.NavigationType.LINK_CLICKED:
            Gtk.show_uri_on_window(self, uri, Gtk.get_current_event_time())
            decision.ignore()
            return True
        return False


def _missing_webkit_view() -> Gtk.Widget:
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
    box.set_margin_top(40)
    box.set_margin_bottom(40)
    box.set_margin_start(40)
    box.set_margin_end(40)
    lbl = Gtk.Label()
    lbl.set_markup(
        "<b>WebKit2GTK is not installed.</b>\n\n"
        "Install it and relaunch:\n"
        "<tt>sudo apt install gir1.2-webkit2-4.1</tt>\n"
        "(or <tt>gir1.2-webkit2-4.0</tt> on Ubuntu 22.04)"
    )
    lbl.set_justify(Gtk.Justification.CENTER)
    box.pack_start(lbl, True, True, 0)
    return box


# ---------- settings dialog ----------
def run_settings_dialog(parent: Gtk.Window, cfg: dict) -> bool:
    dlg = Gtk.Dialog(title="Devlog Settings", transient_for=parent, modal=True)
    dlg.add_button("Cancel", Gtk.ResponseType.CANCEL)
    dlg.add_button("Apply", Gtk.ResponseType.OK)
    box = dlg.get_content_area()
    box.set_spacing(8)
    box.set_margin_top(12)
    box.set_margin_bottom(12)
    box.set_margin_start(12)
    box.set_margin_end(12)

    managed = Gtk.RadioButton.new_with_label_from_widget(None, "Managed (run my own backend)")
    connect = Gtk.RadioButton.new_with_label_from_widget(managed, "Connect to a running backend")
    (managed if cfg.get("mode") == "managed" else connect).set_active(True)
    box.pack_start(managed, False, False, 0)
    box.pack_start(connect, False, False, 0)

    url_row = Gtk.Box(spacing=6)
    url_row.pack_start(Gtk.Label(label="URL"), False, False, 0)
    url_entry = Gtk.Entry(text=cfg.get("connect_url", DEFAULT_URL))
    url_entry.set_hexpand(True)
    url_row.pack_start(url_entry, True, True, 0)
    box.pack_start(url_row, False, False, 0)

    port_row = Gtk.Box(spacing=6)
    port_row.pack_start(Gtk.Label(label="Managed port (0 = auto)"), False, False, 0)
    port_entry = Gtk.Entry(text=str(cfg.get("managed_port", 8765)))
    port_row.pack_start(port_entry, False, False, 0)
    box.pack_start(port_row, False, False, 0)

    dlg.show_all()
    resp = dlg.run()
    changed = False
    if resp == Gtk.ResponseType.OK:
        cfg["mode"] = "managed" if managed.get_active() else "connect"
        cfg["connect_url"] = url_entry.get_text().strip() or DEFAULT_URL
        try:
            cfg["managed_port"] = int(port_entry.get_text())
        except ValueError:
            cfg["managed_port"] = 0
        save_config(cfg)
        changed = True
    dlg.destroy()
    return changed


# ---------- application ----------
class DevlogApp(Gtk.Application):
    def __init__(self):
        super().__init__(application_id="dev.devlog.app",
                         flags=Gio.ApplicationFlags.FLAGS_NONE)
        self.cfg = load_config()
        self.supervisor = Supervisor(self.cfg)
        self.base_url: str | None = None
        self.window: DevlogWindow | None = None

    def do_activate(self):
        if self.window is None:
            self.window = DevlogWindow(self)
            self.window.connect("destroy", lambda *_: self.quit())
            self.window.show_all()
        self.window.present()
        self.connect_backend()

    def connect_backend(self):
        mode = self.cfg.get("mode", "connect")
        if mode == "managed":
            # Resolve off the UI thread; load once healthy.
            def worker():
                try:
                    base = self.supervisor.start()
                except Exception as e:  # noqa: BLE001
                    GLib.idle_add(self._show_error, str(e))
                    return
                GLib.idle_add(self.window.load, base)
            threading.Thread(target=worker, daemon=True).start()
        else:
            self.window.load(self.cfg.get("connect_url", DEFAULT_URL))

    def _show_error(self, msg: str):
        dlg = Gtk.MessageDialog(
            transient_for=self.window, modal=True,
            message_type=Gtk.MessageType.ERROR, buttons=Gtk.ButtonsType.OK,
            text="Backend error",
        )
        dlg.format_secondary_text(msg)
        dlg.run()
        dlg.destroy()

    def open_settings(self, parent: Gtk.Window):
        if run_settings_dialog(parent, self.cfg):
            # Re-apply: stop any managed backend and reconnect per new settings.
            self.supervisor.stop()
            self.supervisor = Supervisor(self.cfg)
            self.connect_backend()

    def do_shutdown(self):
        self.supervisor.stop()
        Gtk.Application.do_shutdown(self)


def main():
    signal.signal(signal.SIGINT, signal.SIG_DFL)
    app = DevlogApp()
    app.run(None)


if __name__ == "__main__":
    main()
