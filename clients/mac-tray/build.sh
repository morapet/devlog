#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

CONFIG=${CONFIG:-release}
APP_NAME=Devlog
BIN_NAME=DevlogTray
BUILD_DIR=.build
APP_DIR="$BUILD_DIR/$APP_NAME.app"

echo "==> swift build ($CONFIG)"
swift build -c "$CONFIG"

BIN_PATH="$(swift build -c "$CONFIG" --show-bin-path)/$BIN_NAME"
if [[ ! -x "$BIN_PATH" ]]; then
    echo "build produced no binary at $BIN_PATH" >&2
    exit 1
fi

echo "==> assembling $APP_DIR"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources"
cp Info.plist "$APP_DIR/Contents/Info.plist"
cp "$BIN_PATH" "$APP_DIR/Contents/MacOS/$BIN_NAME"

echo "==> ad-hoc codesign"
codesign --force --sign - --timestamp=none --options runtime "$APP_DIR" >/dev/null

echo "==> done: $APP_DIR"
echo "Launch:  open $APP_DIR"
