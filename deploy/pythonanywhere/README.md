# devlog on PythonAnywhere

[PythonAnywhere](https://www.pythonanywhere.com) works — including on the
**free tier**: you get HTTPS at `yourusername.pythonanywhere.com` out of the
box, and devlog's `DEVLOG_PASSWORD` login makes it safe to expose. Their
standard web apps speak WSGI while devlog is ASGI (FastAPI), so the deploy
goes through the small [`wsgi.py`](wsgi.py) bridge in this directory
(a2wsgi) — verified against the full API, auth flow, and FTS search.

## Setup (~10 minutes)

**1. In a Bash console** (Consoles tab):

```bash
git clone --depth 1 https://github.com/morapet/devlog.git
pip3 install --user fastapi httpx a2wsgi
mkdir -p ~/devlog-data
python3 -c "import secrets; print('DEVLOG_PASSWORD:', secrets.token_urlsafe(18))"   # note it down
```

**2. Web tab → Add a new web app** → *Manual configuration* → pick the same
Python version `pip3` used above (`pip3 --version` shows it).

**3. Edit the WSGI configuration file** (linked from the Web tab): delete
its contents and paste in [`wsgi.py`](wsgi.py). Adjust `CHECKOUT` if you
cloned somewhere other than `~/devlog`, and set your password — either
uncomment the `DEVLOG_PASSWORD` line, or add it in the Web tab's
environment-variables section if your account has one.

**4. Hit Reload** on the Web tab. Open
`https://yourusername.pythonanywhere.com`, sign in, and on the iPhone:
Share → **Add to Home Screen**.

## Free-tier fine print

- **Set `DEVLOG_PASSWORD`.** The URL is public; without the password anyone
  who finds it can read and write your data.
- **Keep-alive**: free web apps show a "Run until 3 months from today"
  button on the Web tab — click it when you visit, or the app is disabled
  (data is kept; re-enabling brings it back).
- **Outbound requests** from free accounts only reach an allowlist of
  sites, so auto-fetched link titles/favicons will often stay empty. Links
  themselves work fine; paste a title manually.
- **End-of-workday auto-pause** runs as a background loop that the WSGI
  bridge doesn't start. If you use time tracking and want it, add a
  Scheduled Task (free tier includes one daily) run shortly after your
  workday ends:

  ```bash
  DEVLOG_DATA_DIR=~/devlog-data PYTHONPATH=~/devlog/src python3 -c "from devlog.autostop import check_once; check_once()"
  ```

- **Updating**: `cd ~/devlog && git pull`, then Reload on the Web tab.
- **Backup**: your whole state is `~/devlog-data/devlog.db` — download it
  from the Files tab now and then.

A paid account ($5/mo) lifts the outbound allowlist and the 3-month button;
at that price also compare the [VPS + Caddy](../vps-caddy/README.md) route.
