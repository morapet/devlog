"""Optional at-rest encryption for export files.

An export can be encrypted with a token so the JSON dump isn't left in plaintext.
The token is a random secret stored *in the exporting app* (``<data_dir>/export.token``,
like the auth token). Encryption uses AES-256-GCM with a key derived from the
token via scrypt and a random per-file salt, so the same token yields different
ciphertext each time and tampering is detected.

Import always asks the user for the token (even on the same machine) — the app
never silently decrypts, so a shared export file can't be opened without the
secret. A wrong token fails cleanly (``InvalidToken``) rather than producing
garbage.

The encrypted file is a small JSON envelope so it stays a ``.json`` a user can
inspect:

    {"devlog_encrypted": 1, "kdf": "scrypt", "salt": b64, "nonce": b64,
     "ciphertext": b64}
"""

import base64
import json
import os
import secrets
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

from .config import data_dir

# scrypt parameters (n, r, p). n=2**15 is a sensible interactive cost.
_SCRYPT_N = 2**15
_SCRYPT_R = 8
_SCRYPT_P = 1
_KEY_LEN = 32  # AES-256

_token_cache: str | None = None


class InvalidToken(Exception):
    """Raised when decryption fails (wrong token or corrupt/tampered file)."""


def _token_file() -> Path:
    return data_dir() / "export.token"


def get_token() -> str:
    """The app's export token; env wins, else read/create the token file."""
    global _token_cache
    env = os.environ.get("DEVLOG_EXPORT_TOKEN")
    if env:
        return env
    if _token_cache:
        return _token_cache
    f = _token_file()
    try:
        tok = f.read_text().strip()
        if tok:
            _token_cache = tok
            return tok
    except OSError:
        pass
    data_dir().mkdir(parents=True, exist_ok=True)
    tok = secrets.token_urlsafe(24)
    f.write_text(tok)
    try:
        os.chmod(f, 0o600)
    except OSError:
        pass
    _token_cache = tok
    return tok


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


def _unb64(s: str) -> bytes:
    return base64.b64decode(s.encode("ascii"))


def _derive(token: str, salt: bytes) -> bytes:
    kdf = Scrypt(salt=salt, length=_KEY_LEN, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P)
    return kdf.derive(token.encode("utf-8"))


def encrypt(payload: dict[str, Any], token: str) -> dict[str, Any]:
    """Encrypt an export payload with ``token``; returns the JSON envelope."""
    salt = secrets.token_bytes(16)
    nonce = secrets.token_bytes(12)
    key = _derive(token, salt)
    plaintext = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    ciphertext = AESGCM(key).encrypt(nonce, plaintext, None)
    return {
        "devlog_encrypted": 1,
        "kdf": "scrypt",
        "salt": _b64(salt),
        "nonce": _b64(nonce),
        "ciphertext": _b64(ciphertext),
    }


def is_encrypted(doc: Any) -> bool:
    return isinstance(doc, dict) and bool(doc.get("devlog_encrypted"))


def decrypt(envelope: dict[str, Any], token: str) -> dict[str, Any]:
    """Decrypt an envelope produced by :func:`encrypt`. Raises InvalidToken."""
    try:
        salt = _unb64(envelope["salt"])
        nonce = _unb64(envelope["nonce"])
        ciphertext = _unb64(envelope["ciphertext"])
    except (KeyError, ValueError, TypeError) as e:
        raise InvalidToken("malformed encrypted export") from e
    key = _derive(token, salt)
    try:
        plaintext = AESGCM(key).decrypt(nonce, ciphertext, None)
    except InvalidTag as e:
        raise InvalidToken("wrong token or corrupt file") from e
    try:
        return json.loads(plaintext.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as e:
        raise InvalidToken("decrypted content is not valid JSON") from e
