# devlog tray for Linux (GNOME / Ubuntu)

Mirror of the macOS tray, written with **PyGObject + libayatana-appindicator**. Tested on Ubuntu 22.04 + GNOME 42 (X11).

Menu structure (same as macOS):

```
▶ <doing task>                ▸ ⏸ Pause | ✓ Done
─────
Bookmarks
  <project> (current) · N    ▸ MCP · markdown-it · …
  <project> · N              ▸ …
─────
Today (N)
  <project> · N              ▸ <task> ▸ ▶ Start | ✓ Done
─────
Capture (Web UI)…
New project (Web UI)…
Open Web UI
─────
Refresh
Quit Devlog
```

The status text next to the icon shows the currently-doing task or `N today`.

## Install (one command)

```bash
cd clients/linux-tray
./install.sh
```

This will:

1. `apt-get install python3-gi python3-gi-cairo gir1.2-gtk-3.0 gir1.2-ayatanaappindicator3-0.1 xdg-utils`
2. Drop a launcher at `~/.local/bin/devlog-tray`
3. Install `~/.local/share/applications/devlog-tray.desktop` for the app launcher
4. Enable autostart via `~/.config/autostart/devlog-tray.desktop`

Run it:

```bash
devlog-tray
```

## Backend address

The tray talks to `http://127.0.0.1:8765` by default. Override:

```bash
DEVLOG_BASE_URL=http://192.168.1.10:8765 devlog-tray
```

Or edit `~/.local/bin/devlog-tray` to set the env var permanently.

## Tray icon

The icon is installed as a **symbolic SVG** at
`~/.local/share/icons/hicolor/symbolic/apps/devlog-tray-symbolic.svg`. GNOME's
panel will recolor it for light or dark themes automatically (the SVG uses the
GTK-symbolic `#bebebe` placeholder color).

Override with any system icon name:

```bash
DEVLOG_TRAY_ICON=task-due-symbolic devlog-tray
DEVLOG_TRAY_ICON=view-list-symbolic devlog-tray
```

If you change the SVG, re-run `install.sh` (or just `cp` it into the icon dir
and `gtk-update-icon-cache -f -t ~/.local/share/icons/hicolor`).

## GNOME without the AppIndicator extension

Ubuntu ships `gnome-shell-extension-appindicator` enabled out of the box. On vanilla GNOME (Fedora, Debian, etc.) install and enable it:

```bash
# Debian/Ubuntu pure GNOME
sudo apt install gnome-shell-extension-appindicator
# any GNOME
gnome-extensions enable appindicatorsupport@rgcjonas.gmail.com
```

Restart GNOME (Alt+F2 → `r` on X11, or log out/in on Wayland) for it to pick up new indicators.

## Why no native capture window?

The macOS tray uses SwiftUI to host a small Task/Note/Link capture window because that's near-free on Apple platforms. The GTK equivalent would be ~300 lines of GObject code for a feature you can hit with one click in the web UI. The tray's `Capture` / `New project` items open the web UI, where `+ New` does the same thing in fewer keystrokes.

If you want a real GTK capture window later, it's a clean addition — say the word.

## Uninstall

```bash
rm ~/.local/bin/devlog-tray
rm ~/.local/share/applications/devlog-tray.desktop
rm ~/.config/autostart/devlog-tray.desktop
# optionally: sudo apt remove gir1.2-ayatanaappindicator3-0.1
```
