#!/usr/bin/env bash
# Download and install the drawio webapp into src/devlog/web/vendor/drawio.
# The webapp is too large (~120 MB even pruned) to vendor in git, so we fetch
# it on demand. Re-running is a no-op when the install already exists.
set -euo pipefail

DEST="${1:-src/devlog/web/vendor/drawio}"
VERSION="${DRAWIO_VERSION:-v30.0.2}"

if [ -d "$DEST" ] && [ -f "$DEST/index.html" ]; then
    echo "drawio already installed at $DEST"
    exit 0
fi

mkdir -p "$(dirname "$DEST")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading drawio $VERSION (~60 MB tarball)…"
curl -sLf "https://github.com/jgraph/drawio/archive/refs/tags/${VERSION}.tar.gz" \
    -o "$TMP/drawio.tar.gz"

echo "Extracting…"
tar -xzf "$TMP/drawio.tar.gz" -C "$TMP"
SRC="$(find "$TMP" -maxdepth 3 -type d -path '*/src/main/webapp' | head -1)"
if [ -z "$SRC" ]; then
    echo "Could not find webapp/ inside the archive." >&2
    exit 1
fi

mv "$SRC" "$DEST"

# Prune dispensable parts (cloud integrations, dev sources, templates, math).
cd "$DEST"
rm -rf WEB-INF META-INF connect templates math4
rm -rf js/diagramly js/grapheditor js/dropbox js/onedrive js/jquery js/simplepeer js/dev
rm -f dropbox.html github.html gitlab.html teams.html onedrive3.html monday-app-association.json
rm -f service-worker.js service-worker.js.map
rm -f vsdxImporter.html js/vsdxImporter.js
rm -f export3.html export-fonts.css js/export.js js/export-init.js

echo "drawio installed at $DEST ($(du -sh . | cut -f1))"
