#!/usr/bin/env bash
# Install devlog as a per-user systemd service on Ubuntu / Debian / any
# systemd-based Linux. Steps:
#
#   1. Make sure a Python package installer is present (prefers uv, falls
#      back to pipx, then pip --user).
#   2. Install / upgrade the devlog package from this checkout (default) or
#      from the GitHub repo (with --from-github).
#   3. Optionally download the drawio webapp (so the inline drawing editor
#      works) into the installed package's web/vendor/ dir.
#   4. Install ~/.config/systemd/user/devlog.service, enable + start it.
#   5. Optionally enable linger so the service keeps running after logout
#      (requires sudo for `loginctl enable-linger`).
#
# Usage:
#   bash clients/linux-server/install.sh                  # from repo checkout
#   bash clients/linux-server/install.sh --from-github    # from latest main
#   bash clients/linux-server/install.sh --no-drawio      # skip drawio
#   bash clients/linux-server/install.sh --linger         # also enable linger
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
SOURCE="$REPO_ROOT"
INSTALL_DRAWIO=1
ENABLE_LINGER=0

while [ $# -gt 0 ]; do
    case "$1" in
        --from-github) SOURCE="git+https://github.com/morapet/devlog.git"; shift ;;
        --no-drawio)   INSTALL_DRAWIO=0; shift ;;
        --linger)      ENABLE_LINGER=1; shift ;;
        -h|--help)
            sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//;/^set -euo/d'
            exit 0 ;;
        *) echo "unknown arg: $1" >&2; exit 1 ;;
    esac
done

# ---------- 1. installer ----------
INSTALLER=""
if   command -v uv    >/dev/null 2>&1; then INSTALLER="uv"
elif command -v pipx  >/dev/null 2>&1; then INSTALLER="pipx"
elif command -v pip3  >/dev/null 2>&1; then INSTALLER="pip"
else
    echo "==> no installer found; installing pipx via apt"
    sudo apt-get update -qq
    sudo apt-get install -y --no-install-recommends pipx python3-venv
    pipx ensurepath
    export PATH="$HOME/.local/bin:$PATH"
    INSTALLER="pipx"
fi
echo "==> using $INSTALLER to install devlog"

# ---------- 2. install devlog ----------
case "$INSTALLER" in
    uv)
        uv tool install --force "$SOURCE"
        ;;
    pipx)
        pipx install --force "$SOURCE"
        ;;
    pip)
        pip3 install --user --upgrade "$SOURCE"
        ;;
esac

BIN="$HOME/.local/bin/devlog"
if [ ! -x "$BIN" ]; then
    echo "ERROR: expected the installer to put 'devlog' on PATH at $BIN" >&2
    exit 1
fi
echo "    installed: $BIN"

# ---------- 3. drawio ----------
if [ "$INSTALL_DRAWIO" = "1" ]; then
    # uv/pipx install devlog into their own isolated venv; system python3 can't
    # see it. The console script's shebang points at the right interpreter —
    # extract it and ask that python where the package lives.
    SHEBANG="$(head -1 "$BIN")"
    DEVLOG_PY="${SHEBANG#\#!}"
    if [ ! -x "$DEVLOG_PY" ]; then
        echo "ERROR: could not extract the python interpreter from $BIN" >&2
        echo "  shebang line was: $SHEBANG" >&2
        exit 1
    fi
    PKG_DIR="$("$DEVLOG_PY" -c '
import importlib.util, pathlib, sys
spec = importlib.util.find_spec("devlog")
if not spec or not spec.submodule_search_locations:
    sys.exit("could not locate devlog package")
print(pathlib.Path(spec.submodule_search_locations[0]))
')"
    if [ -z "$PKG_DIR" ]; then
        echo "ERROR: devlog package not importable via $DEVLOG_PY" >&2
        exit 1
    fi
    DEST="$PKG_DIR/web/vendor/drawio"
    if [ -d "$DEST" ] && [ -f "$DEST/index.html" ]; then
        echo "==> drawio already present at $DEST (skipping)"
    else
        echo "==> downloading drawio into $DEST"
        bash "$REPO_ROOT/scripts/install-drawio.sh" "$DEST"
    fi
else
    echo "==> skipping drawio (--no-drawio); drawing modal will 404 until you run install-drawio.sh"
fi

# ---------- 4. systemd user service ----------
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
cp "$HERE/devlog.service" "$UNIT_DIR/devlog.service"

echo "==> reloading systemd user units"
systemctl --user daemon-reload
echo "==> enabling + starting devlog.service"
systemctl --user enable --now devlog.service
sleep 1
systemctl --user --no-pager --lines=5 status devlog.service || true

# ---------- 5. linger (optional) ----------
if [ "$ENABLE_LINGER" = "1" ]; then
    if ! loginctl show-user "$USER" 2>/dev/null | grep -q '^Linger=yes'; then
        echo "==> enabling lingering so the service survives logout (requires sudo)"
        sudo loginctl enable-linger "$USER"
    else
        echo "==> linger already enabled"
    fi
fi

# ---------- 6. report ----------
echo
echo "──────────────────────────────────────────────────"
echo " devlog backend is up at: http://127.0.0.1:8765"
echo
echo " Logs:        journalctl --user -u devlog -f"
echo " Status:      systemctl --user status devlog"
echo " Stop:        systemctl --user stop devlog"
echo " Disable:     systemctl --user disable --now devlog"
echo " Upgrade:     bash $0   (re-run this script)"
echo
echo " Tray (optional):  bash clients/linux-tray/install.sh"
echo "──────────────────────────────────────────────────"
