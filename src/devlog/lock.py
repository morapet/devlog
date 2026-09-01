"""Single-writer lock on the data directory.

Two devlog backends pointed at the same data dir would race on schema
migrations (the FTS rebuild in db.py is not idempotent) and fight over the
SQLite WAL. This acquires an exclusive advisory lock on `<data_dir>/devlog.lock`
at startup and refuses to start a second backend on the same dir.

An advisory `flock` is used rather than a bare PID file because the OS releases
it automatically when the process dies — no stale-lock cleanup, no PID-recycling
race. The PID/host/port/started fields are written into the file only so the
error message can name whoever is already holding it.

Caveat: `flock` lives on the file in the data dir, so — like SQLite's own locks
— it is not reliably honored across a Docker/host bind mount. Keeping the native
app and Docker on *different* data dirs is what covers that case; this lock
covers same-host collisions (a second app instance, a stray `uv run devlog`,
both misconfigured to the same dir).
"""

import atexit
import json
import os
import socket

from .config import data_dir
from .db import utcnow

try:
    import fcntl
except ImportError:  # pragma: no cover - non-POSIX platforms
    fcntl = None

# Keep the fd alive for the whole process: closing it releases the lock.
_lock_fd: int | None = None


class DataDirLocked(SystemExit):
    """Raised when another backend already holds the data-dir lock."""


def acquire_datadir_lock(port: int | None = None) -> None:
    """Take the exclusive lock on the data dir, or exit with a clear message.

    Idempotent within a process: calling it again is a no-op.
    """
    global _lock_fd
    if _lock_fd is not None:
        return
    if fcntl is None:  # pragma: no cover - non-POSIX platforms
        return

    d = data_dir()
    d.mkdir(parents=True, exist_ok=True)
    path = d / "devlog.lock"
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o644)

    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        holder = {}
        try:
            holder = json.loads(os.pread(fd, 4096, 0) or b"{}")
        except (ValueError, OSError):
            pass
        os.close(fd)
        pid = holder.get("pid", "?")
        started = holder.get("started", "?")
        held_port = holder.get("port")
        where = f" on port {held_port}" if held_port else ""
        raise DataDirLocked(
            f"devlog: another backend is already using {d} "
            f"(pid {pid}, since {started}{where}). Refusing to start a second "
            f"one on the same data dir — use a different DEVLOG_DATA_DIR or stop "
            f"the other backend."
        )

    payload = json.dumps(
        {
            "pid": os.getpid(),
            "host": socket.gethostname(),
            "port": port,
            "started": utcnow(),
        }
    ).encode()
    os.ftruncate(fd, 0)
    os.pwrite(fd, payload, 0)
    _lock_fd = fd
    atexit.register(_release)


def _release() -> None:
    global _lock_fd
    if _lock_fd is None or fcntl is None:
        return
    try:
        fcntl.flock(_lock_fd, fcntl.LOCK_UN)
    except OSError:
        pass
    finally:
        try:
            os.close(_lock_fd)
        except OSError:
            pass
        _lock_fd = None
