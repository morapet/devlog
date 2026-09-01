#!/usr/bin/env bash
# Build Devlog.app and install it into /Applications (system-wide for this Mac).
# On stock macOS /Applications is admin-writable, so no sudo is needed for an
# admin user; if it is not writable, this re-runs the copy under sudo.
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME=Devlog
SRC=".build/$APP_NAME.app"
DEST="/Applications/$APP_NAME.app"

./build.sh

# Replace any running/installed copy.
osascript -e "tell application \"$APP_NAME\" to quit" 2>/dev/null || true
sleep 1

if [[ -w /Applications ]]; then
    rm -rf "$DEST"
    cp -R "$SRC" "$DEST"
else
    echo "==> /Applications needs elevated permission; using sudo"
    sudo rm -rf "$DEST"
    sudo cp -R "$SRC" "$DEST"
fi

# Register with Launch Services so Spotlight / open -a find it and the icon shows.
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
[[ -x "$LSREGISTER" ]] && "$LSREGISTER" -f "$DEST" >/dev/null 2>&1 || true

echo "==> installed $DEST"
echo "Launch:  open -a $APP_NAME"
