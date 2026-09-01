"""PythonAnywhere WSGI entry point for devlog.

PythonAnywhere's standard web apps speak WSGI; devlog is ASGI (FastAPI).
a2wsgi bridges the two — it runs the ASGI app on a background event loop,
so the full API and web UI work unchanged.

Copy this file's contents into the WSGI configuration file PythonAnywhere
generates for your web app (linked from the Web tab), adjusting the two
paths / settings below. Full walkthrough: README.md next to this file.
"""
import os
import sys

# --- adjust these two ---------------------------------------------------
CHECKOUT = os.path.expanduser("~/devlog")          # where you cloned the repo
os.environ.setdefault("DEVLOG_DATA_DIR", os.path.expanduser("~/devlog-data"))
# Requests arrive through PythonAnywhere's proxy (a non-loopback client), so
# devlog requires its shared secret. Pin it to a known value here or in the Web
# tab's environment variables; otherwise it's auto-generated (read it with
# `devlog --print-token`).
# os.environ.setdefault("DEVLOG_AUTH_TOKEN", "change-me")
# ------------------------------------------------------------------------

sys.path.insert(0, os.path.join(CHECKOUT, "src"))

from a2wsgi import ASGIMiddleware  # noqa: E402

from devlog.app import app  # noqa: E402
from devlog.db import conn  # noqa: E402

# The WSGI bridge doesn't run FastAPI's startup hooks; create the schema
# eagerly so the first request doesn't race it.
conn()

application = ASGIMiddleware(app)
