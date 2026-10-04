"""The frontend's ``Permission`` type is the backend enum, string for string (WS-13 E13 T14).

``hasPermission`` takes ``Permission``, so a literal outside the type fails the frontend's
typecheck — but only if the type itself follows the backend. It had drifted: retired
``filaments:*`` still in it, newer rights missing. Replacing ``projects:*`` with the Workshop's
domain rights must not leave the two lists apart again.
"""

import re
from pathlib import Path

from backend.app.core.permissions import Permission

CLIENT = Path(__file__).resolve().parents[3] / "frontend" / "src" / "api" / "client.ts"


def _union() -> set[str]:
    source = CLIENT.read_text(encoding="utf-8")
    match = re.search(r"export type Permission =(.*?);", source, re.S)
    assert match, "export type Permission not found in client.ts"
    return set(re.findall(r"'([a-z_]+:[a-z_]+)'", match.group(1)))


def test_the_frontend_permission_type_is_the_backend_enum():
    union = _union()
    enum = {p.value for p in Permission}
    assert sorted(union - enum) == []
    assert sorted(enum - union) == []
