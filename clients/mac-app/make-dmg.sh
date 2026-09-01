#!/usr/bin/env bash
# Build a drag-to-Applications DMG installer for Devlog.
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME=Devlog
APP_DIR=".build/$APP_NAME.app"
DMG=".build/$APP_NAME.dmg"

# Ensure a fresh app bundle exists.
./build.sh

STAGE="$(mktemp -d)"
cp -R "$APP_DIR" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

rm -f "$DMG"
hdiutil create \
    -volname "$APP_NAME" \
    -srcfolder "$STAGE" \
    -ov -format UDZO \
    "$DMG" >/dev/null
rm -rf "$STAGE"

echo "==> wrote $DMG"
echo "Install: open '$DMG' and drag Devlog into Applications."
