"""``projects:file_prints`` — the Workshop's own right to file prints under orders (WS-13 E13).

Filing prints under an order and taking them out asked for the right to edit THOSE
archives (E13 B03): ``archives:update_all``, or ``archives:update_own`` for a print the
caller created. A print started from the printer's screen, a slicer or the virtual printer
has no owner, so ``update_own`` never reaches it — and the default Operators hold only
``update_own``: E13 would have taken filing external prints away from the farm's operator
role. ``update_all`` is not the answer — it would also let any operator overwrite other
people's photos, sources and 3D files (upstream security #5). The owner's ruling
(2026-10-04): a Workshop right of its own, checked beside ``projects:update``.

Seeded to the system groups Administrators (O2 discipline — Administrators are not
self-healed at startup) and Operators, append-only and idempotent (the m176 shape); fresh
installs get it from ``core.permissions.DEFAULT_GROUPS``. A custom group is the
administrator's to change.
"""

import logging

from sqlalchemy import select, update

logger = logging.getLogger(__name__)

version = 193
name = "projects_file_prints"

NEW_PERMISSIONS = ["projects:file_prints"]
SEEDED_GROUPS = ("Administrators", "Operators")


async def upgrade(conn):
    """No schema change."""


async def seed(session_factory):
    """Grant ``projects:file_prints`` to the two system groups, once."""
    from backend.app.models.group import Group

    async with session_factory() as db:
        result = await db.execute(select(Group.id, Group.name, Group.is_system, Group.permissions))
        dirty = 0
        for row in result.all():
            if not (row.is_system and row.name in SEEDED_GROUPS):
                continue
            existing = set(row.permissions or [])
            to_add = [p for p in NEW_PERMISSIONS if p not in existing]
            if not to_add:
                continue
            await db.execute(
                update(Group.__table__)
                .where(Group.__table__.c.id == row.id)
                .values(permissions=list(row.permissions or []) + to_add)
            )
            dirty += 1
        if dirty:
            await db.commit()
            logger.info("m193: seeded projects:file_prints into %d group(s)", dirty)
