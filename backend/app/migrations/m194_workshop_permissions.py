"""The Workshop's domain rights replace ``projects:*`` (WS-13 E13 T14).

One family — ``projects:read/create/update/delete`` plus ``projects:file_prints`` (m193) —
governed orders, the product catalog, customers and finished stock alike. The split gives each
domain its own rights: ``orders:*`` (+ ``orders:file_prints``), ``products:*``,
``customers:*`` and ``stock:read/move/adjust``.

Every group gets the IMAGE of what it held:

* ``projects:read``   → ``orders:read``, ``products:read``, ``customers:read``, ``stock:read``
* ``projects:create`` → ``orders:create``, ``products:create``, ``customers:create``
* ``projects:update`` → ``orders:update``, ``products:update``, ``customers:update``,
  ``stock:move``, ``stock:adjust``
* ``projects:delete`` → ``orders:delete``, ``products:delete``, ``customers:delete``
* ``projects:file_prints`` → ``orders:file_prints`` — but only in a group that also held
  ``projects:update``. The old right acted only beside ``projects:update``; the new one acts
  alone, so carrying it over from a group without update would widen that group from nothing
  to "file anyone's print" (consilium R13). Such a group is named in the log.

Every image but ``orders:file_prints`` has one source, so for a user in several groups the
result is the image of the old union; the per-group condition on ``orders:file_prints`` can
only narrow (update in one group, file_prints in another) and is logged.

The system groups — which the group API refuses to edit — end with exactly their default
Workshop set, which also heals one whose rights an older m046 had already dropped. The old
strings leave EVERY group, custom ones included: the group editor re-sends the whole list on
save, and the API refuses strings that are no longer permissions (the m112 precedent).
Unknown strings are not ours to drop (that is m046's job). Idempotent.

The sets are frozen here, not read from ``core.permissions``: a later change to the defaults
is a later migration's business.
"""

import json
import logging

from sqlalchemy import select, update

logger = logging.getLogger(__name__)

version = 194
name = "workshop_permissions"

_READS = ["orders:read", "products:read", "customers:read", "stock:read"]
_IMAGES: dict[str, list[str]] = {
    "projects:read": _READS,
    "projects:create": ["orders:create", "products:create", "customers:create"],
    "projects:update": ["orders:update", "products:update", "customers:update", "stock:move", "stock:adjust"],
    "projects:delete": ["orders:delete", "products:delete", "customers:delete"],
}
_FILE_PRINTS_OLD = "projects:file_prints"
_FILE_PRINTS_NEW = "orders:file_prints"
_OLD = set(_IMAGES) | {_FILE_PRINTS_OLD}
_WORKSHOP = [p for images in _IMAGES.values() for p in images] + [_FILE_PRINTS_NEW]
_WORKSHOP_SET = set(_WORKSHOP)
_DOMAINS = ("orders:", "products:", "customers:", "stock:")

_SYSTEM_DEFAULTS: dict[str, list[str]] = {
    "Administrators": _WORKSHOP,
    "Operators": _WORKSHOP,
    "Viewers": _READS,
}


async def upgrade(conn):
    """No schema change."""


def _as_list(raw) -> list | None:
    if raw is None:
        return None
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return None
    return list(raw) if isinstance(raw, list) else None


def _map_custom(perms: list) -> list:
    """Each old string replaced in place by its image; ``orders:file_prints`` only beside update."""
    keeps_file_prints = _FILE_PRINTS_OLD in perms and "projects:update" in perms
    out: list = []
    for key in perms:
        if key in _IMAGES:
            images = _IMAGES[key] + ([_FILE_PRINTS_NEW] if key == "projects:update" and keeps_file_prints else [])
            out.extend(p for p in images if p not in out)
        elif key == _FILE_PRINTS_OLD:
            continue
        elif key not in out:
            out.append(key)
    return out


def _set_system(perms: list, defaults: list[str]) -> list:
    """Drop every old and new Workshop string, then the group's default Workshop set."""
    out = [p for p in perms if p not in _OLD and not (isinstance(p, str) and p in _WORKSHOP_SET)]
    return out + [p for p in defaults if p not in out]


async def seed(session_factory):
    from backend.app.models.group import Group

    table = Group.__table__
    async with session_factory() as db:
        rows = (await db.execute(select(table.c.id, table.c.name, table.c.is_system, table.c.permissions))).all()
        changed = 0
        for row in rows:
            perms = _as_list(row.permissions)
            if perms is None:
                continue
            if row.is_system and row.name in _SYSTEM_DEFAULTS:
                new = _set_system(perms, _SYSTEM_DEFAULTS[row.name])
            else:
                new = _map_custom(perms)
                if _FILE_PRINTS_OLD in perms and "projects:update" not in perms:
                    logger.warning(
                        "m194: group %r held projects:file_prints without projects:update — "
                        "orders:file_prints is not carried over; grant it by hand if intended",
                        row.name,
                    )
            if new == perms and not isinstance(row.permissions, str):
                continue
            await db.execute(update(table).where(table.c.id == row.id).values(permissions=new))
            changed += 1
            old_workshop = sorted(p for p in perms if p in _OLD)
            new_workshop = sorted(p for p in new if isinstance(p, str) and p.startswith(_DOMAINS))
            logger.info("m194: group %r Workshop rights %s → %s", row.name, old_workshop, new_workshop)
        if changed:
            await db.commit()
            logger.info("m194: %d group(s) moved to the Workshop's domain rights", changed)
