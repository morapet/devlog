#!/bin/sh
# Run devlog straight from this source checkout, no package install needed.
# Written for iSH on iOS (see README.md next to this file), but works on any
# POSIX system with python3 + fastapi + uvicorn + httpx + pydantic available.
set -e
cd "$(dirname "$0")/../.."

# Bind to localhost only by default — on the phone, Safari talks to the
# server over the loopback interface. Export DEVLOG_HOST=0.0.0.0 before
# running if you also want other devices on the network to connect.
export DEVLOG_HOST="${DEVLOG_HOST:-127.0.0.1}"
export PYTHONPATH="src${PYTHONPATH:+:$PYTHONPATH}"

exec python3 -m devlog
