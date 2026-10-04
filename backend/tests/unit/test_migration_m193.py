"""m193: the Workshop's own right to file prints under orders (WS-13 E13, owner's ruling 2026-10-04).

Filing a print under an order (or taking it out) asked for the right to edit THAT archive
(E13 B03). A print started from the printer's screen or a slicer has no owner, so
``archives:update_own`` never reaches it — and the default Operators held only that, which
took filing external prints away from them. ``archives:update_all`` would have opened other
people's photos and files too (upstream security #5), so the owner chose a Workshop right of
its own, ``projects:file_prints``: seeded to Administrators (O2 discipline) and Operators.
m194 later carried it over as ``orders:file_prints``; the defaults hold the successor, and
m193's own seed still writes the string it shipped with.
"""

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.core.permissions import DEFAULT_GROUPS, Permission
from backend.app.migrations import m193_projects_file_prints as m193

FILE_PRINTS = "projects:file_prints"
SUCCESSOR = Permission.ORDERS_FILE_PRINTS.value


def test_a_fresh_install_gives_the_successor_to_administrators_and_operators_only():
    assert SUCCESSOR in DEFAULT_GROUPS["Administrators"]["permissions"]
    assert SUCCESSOR in DEFAULT_GROUPS["Operators"]["permissions"]
    assert SUCCESSOR not in DEFAULT_GROUPS["Viewers"]["permissions"]
    assert Permission.ARCHIVES_UPDATE_ALL.value not in DEFAULT_GROUPS["Operators"]["permissions"]


@pytest.mark.asyncio
async def test_seed_grants_the_right_to_the_two_system_groups_once(test_engine):
    from backend.app.migrations.m001_bamdude_baseline import _seed_default_groups
    from backend.app.models.group import Group

    factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    await _seed_default_groups(factory)
    async with factory() as db:
        # An install from before the right: nobody holds it; a custom group of the same name
        # is kept apart by ``is_system``.
        for row in (await db.execute(select(Group.id, Group.permissions))).all():
            stripped = [p for p in (row.permissions or []) if p != FILE_PRINTS]
            await db.execute(update(Group).where(Group.id == row.id).values(permissions=stripped))
        db.add(Group(name="Operators (custom)", is_system=False, permissions=[]))
        await db.commit()

    await m193.seed(factory)
    await m193.seed(factory)

    async with factory() as db:
        rows = (await db.execute(select(Group.name, Group.permissions))).all()
    by_name = {r.name: r.permissions for r in rows}
    assert by_name["Administrators"].count(FILE_PRINTS) == 1
    assert by_name["Operators"].count(FILE_PRINTS) == 1
    assert FILE_PRINTS not in by_name["Viewers"]
    assert FILE_PRINTS not in by_name["Operators (custom)"]
