# devlog backend as a systemd user service

Installs the devlog backend on Ubuntu / Debian / any systemd-based Linux so it auto-starts on login.

## Install (one command)

From a repo checkout:

```bash
cd /path/to/devlog
bash clients/linux-server/install.sh
```

From anywhere, pulling latest main from GitHub:

```bash
curl -sLf https://raw.githubusercontent.com/morapet/devlog/main/clients/linux-server/install.sh \
    | bash -s -- --from-github
```

The script:

1. Picks an installer: `uv` if present, else `pipx`, else `pip --user`. Installs `pipx` via apt if none of those exist.
2. Runs `<installer> install devlog` (from your checkout, or from GitHub with `--from-github`). The package's console-script `devlog` lands at `~/.local/bin/devlog`.
3. Downloads + prunes the drawio webapp into the installed package's `web/vendor/drawio/` (skip with `--no-drawio`).
4. Writes `~/.config/systemd/user/devlog.service` and runs:
   - `systemctl --user daemon-reload`
   - `systemctl --user enable --now devlog.service`
5. Optionally runs `loginctl enable-linger $USER` so the service keeps running after logout (pass `--linger`; needs sudo).

## Verify

```bash
curl -sf http://127.0.0.1:8765/health
# {"ok":true}

systemctl --user status devlog
journalctl --user -u devlog -f
```

## Upgrade

Re-run the installer. It'll `--force` reinstall the package and restart the service.

```bash
bash clients/linux-server/install.sh             # from repo
# or
bash clients/linux-server/install.sh --from-github
```

## Uninstall

```bash
systemctl --user disable --now devlog
rm ~/.config/systemd/user/devlog.service
systemctl --user daemon-reload

# pick the matching one
uv tool uninstall devlog          # if installed via uv
pipx uninstall devlog              # if installed via pipx
pip3 uninstall devlog              # if installed via pip --user
```

The SQLite database in `~/.local/share/devlog/` is left alone — delete it manually if you want to start fresh.

## Configuration

Per-user overrides live in `~/.config/devlog.env` (the unit reads it via `EnvironmentFile=-`). Example:

```bash
# ~/.config/devlog.env
DEVLOG_HOST=0.0.0.0
DEVLOG_PORT=8765
DEVLOG_DATA_DIR=/home/me/projects/devlog-data
```

After editing: `systemctl --user restart devlog`.

## Pair with the tray

```bash
bash clients/linux-tray/install.sh
```

Tray + backend then start together on every login.
