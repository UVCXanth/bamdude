"""Short-lived process-bound previews, distinct from authentication tokens."""

import base64
import hashlib
import hmac
import json
import secrets
import time
from datetime import datetime

_KEY = secrets.token_bytes(32)
_INCARNATION = secrets.token_hex(16)
TTL = 300
clock = time.monotonic


def json_value(value):
    if isinstance(value, datetime):
        from backend.app.services.print_state_recovery import utc

        return utc(value).isoformat()
    raise TypeError(type(value).__name__)


def canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=json_value, allow_nan=False).encode()


def digest(value) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def sign(payload: dict) -> str:
    data = canonical({**payload, "incarnation": _INCARNATION, "expires": clock() + TTL})
    encoded = base64.urlsafe_b64encode(data).rstrip(b"=")
    return (encoded + b"." + hmac.new(_KEY, encoded, hashlib.sha256).hexdigest().encode()).decode()


def verify(token: str) -> dict:
    if not isinstance(token, str) or len(token) > 8192:
        raise ValueError("recovery_preview_expired")
    try:
        encoded, signature = token.encode("ascii").split(b".")
        if not hmac.compare_digest(hmac.new(_KEY, encoded, hashlib.sha256).hexdigest().encode(), signature):
            raise ValueError
        payload = json.loads(base64.urlsafe_b64decode(encoded + b"=" * (-len(encoded) % 4)))
        if payload["incarnation"] != _INCARNATION or clock() > payload["expires"]:
            raise ValueError
        return payload
    except (ValueError, KeyError, TypeError, UnicodeError):
        raise ValueError("recovery_preview_expired") from None
