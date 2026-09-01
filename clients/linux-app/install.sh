#!/usr/bin/env bash
# Installer for the Devlog desktop app (GTK3 + WebKit2GTK) on Ubuntu / Debian.
# Per-user install into ~/.local — no root except the apt step.
set -euo pipefail

echo "== installing system dependencies (apt)"
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends \
    python3-gi \
    python3-gi-cairo \
    gir1.2-gtk-3.0 \
    xdg-utils
# WebKit2GTK: 4.1 on Ubuntu 23.10+, 4.0 on 22.04. Install whichever exists.
sudo apt-get install -y --no-install-recommends gir1.2-webkit2-4.1 \
    || sudo apt-get install -y --no-install-recommends gir1.2-webkit2-4.0 \
    || echo "!! could not install gir1.2-webkit2-4.x — the window needs it."

HERE="$(cd "$(dirname "$0")" && pwd)"
BIN_LINK="${HOME}/.local/bin/devlog-app"
DESKTOP="${HOME}/.local/share/applications/devlog.desktop"
ICON_DIR="${HOME}/.local/share/icons/hicolor/scalable/apps"
ICON_DEST="${ICON_DIR}/devlog.svg"

echo "== installing launcher to ${BIN_LINK}"
mkdir -p "$(dirname "$BIN_LINK")"
cat >"$BIN_LINK" <<EOF
#!/usr/bin/env bash
exec /usr/bin/python3 "${HERE}/devlog-app.py" "\$@"
EOF
chmod +x "$BIN_LINK"

echo "== installing app icon to ${ICON_DEST}"
mkdir -p "$ICON_DIR"
cp "${HERE}/devlog.svg" "$ICON_DEST"
gtk-update-icon-cache -f -t "${HOME}/.local/share/icons/hicolor" 2>/dev/null || true

echo "== installing .desktop entry to ${DESKTOP}"
mkdir -p "$(dirname "$DESKTOP")"
cat >"$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=Devlog
Comment=Local-first task / note / link tracker
Exec=${BIN_LINK}
Icon=devlog
Categories=Utility;Office;
Terminal=false
StartupNotify=true
StartupWMClass=dev.devlog.app
EOF
update-desktop-database "${HOME}/.local/share/applications" 2>/dev/null || true

echo
echo "Done. Launch it from your app grid ('Devlog') or run: devlog-app"
echo
echo "Default mode is 'connect' → ${DEVLOG_BASE_URL:-http://127.0.0.1:8765}."
echo "Run a backend first (systemd: make server-linux, or: devlog), or switch"
echo "to Managed mode via the app's Settings (gear icon)."
if ! command -v devlog >/dev/null 2>&1; then
    echo
    echo "Note: 'devlog' is not on PATH, so Managed mode needs either the devlog"
    echo "package installed, or dev_repo set in ~/.config/devlog/app.json."
fi
