#!/usr/bin/env bash
# Build AppIcon.icns from AppIcon.svg using rsvg-convert + iconutil.
# Renders each iconset size directly from the vector for crisp edges and correct
# transparency (no raster padding tricks).
set -euo pipefail
cd "$(dirname "$0")"

SRC=AppIcon.svg
OUT=AppIcon.icns

if ! command -v rsvg-convert >/dev/null 2>&1; then
    echo "rsvg-convert not found (brew install librsvg)" >&2
    exit 1
fi

WORK="$(mktemp -d)"
ICONSET="$WORK/AppIcon.iconset"
mkdir -p "$ICONSET"

render() { rsvg-convert -w "$1" -h "$1" "$SRC" -o "$ICONSET/$2"; }

render 16   icon_16x16.png
render 32   icon_16x16@2x.png
render 32   icon_32x32.png
render 64   icon_32x32@2x.png
render 128  icon_128x128.png
render 256  icon_128x128@2x.png
render 256  icon_256x256.png
render 512  icon_256x256@2x.png
render 512  icon_512x512.png
render 1024 icon_512x512@2x.png

iconutil -c icns "$ICONSET" -o "$OUT"
rm -rf "$WORK"
echo "==> wrote $OUT"
