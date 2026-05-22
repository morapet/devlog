import os
from pathlib import Path


def data_dir() -> Path:
    base = os.environ.get("DEVLOG_DATA_DIR")
    if base:
        return Path(base)
    xdg = os.environ.get("XDG_DATA_HOME")
    root = Path(xdg) if xdg else Path.home() / ".local" / "share"
    return root / "devlog"


def db_path() -> Path:
    return data_dir() / "devlog.db"


HOST = os.environ.get("DEVLOG_HOST", "127.0.0.1")
PORT = int(os.environ.get("DEVLOG_PORT", "8765"))
