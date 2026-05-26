#!/usr/bin/env bash
# One-shot installer for the devlog Linux tray on Ubuntu / Debian / GNOME.
set -euo pipefail

echo "== installing system dependencies (apt)"
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends \
    python3-gi \
    python3-gi-cairo \
    gir1.2-gtk-3.0 \
    gir1.2-ayatanaappindicator3-0.1 \
    xdg-utils

# Some GNOME Shell installs don't have the AppIndicator extension active.
# Ubuntu's gnome-shell-extension-appindicator is preinstalled and on by default;
# if you're on vanilla GNOME, enable it via:
#   gnome-extensions enable appindicatorsupport@rgcjonas.gmail.com

HERE="$(cd "$(dirname "$0")" && pwd)"
BIN_LINK="${HOME}/.local/bin/devlog-tray"
DESKTOP="${HOME}/.local/share/applications/devlog-tray.desktop"
AUTOSTART="${HOME}/.config/autostart/devlog-tray.desktop"
ICON_DIR="${HOME}/.local/share/icons/hicolor/symbolic/apps"
ICON_DEST="${ICON_DIR}/devlog-tray-symbolic.svg"

echo "== installing launcher to ${BIN_LINK}"
mkdir -p "$(dirname "$BIN_LINK")"
cat >"$BIN_LINK" <<EOF
#!/usr/bin/env bash
exec /usr/bin/python3 "${HERE}/devlog-tray.py" "\$@"
EOF
chmod +x "$BIN_LINK"

echo "== installing symbolic icon to ${ICON_DEST}"
mkdir -p "$ICON_DIR"
cp "${HERE}/devlog-symbolic.svg" "$ICON_DEST"
# Refresh the user-local icon cache so GTK picks it up immediately.
gtk-update-icon-cache -f -t "${HOME}/.local/share/icons/hicolor" 2>/dev/null || true

echo "== installing .desktop entry to ${DESKTOP}"
mkdir -p "$(dirname "$DESKTOP")"
cat >"$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=Devlog Tray
Comment=Devlog menu-bar indicator
Exec=${BIN_LINK}
Icon=${HERE}/devlog.svg
Categories=Utility;Office;
Terminal=false
StartupNotify=false
X-GNOME-Autostart-enabled=true
EOF

echo "== enabling autostart at ${AUTOSTART}"
mkdir -p "$(dirname "$AUTOSTART")"
cp "$DESKTOP" "$AUTOSTART"

echo
echo "Done."
echo "Launch now:   devlog-tray  (or: ${BIN_LINK})"
echo "Autostart:    on (delete ${AUTOSTART} to disable)"
echo
echo "The tray icon is installed as a symbolic SVG, so the panel will"
echo "recolor it to match light/dark themes automatically. To override"
echo "with a different system icon, set: DEVLOG_TRAY_ICON=task-due-symbolic"
echo
echo "If the icon doesn't appear in the top bar on vanilla GNOME, run:"
echo "    gnome-extensions enable appindicatorsupport@rgcjonas.gmail.com"
