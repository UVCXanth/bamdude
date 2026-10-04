"""m046 → m194 through the real migration runner (WS-13 E13 T14, R09).

m046 normalises every group against the LIVE ``ALL_PERMISSIONS``. Once the split took
``projects:*`` out of the enum, a database that had not yet run m046 — an install from before
v0.4.4, an old backup — would lose every Workshop right before m194 could convert it. m046 now
carries those four keys forward (``_CARRIED_FORWARD``, the owner's narrow exception, N14), so
such a database ends exactly where one that passed m193 does.

The runner is the real one (``_run_pending``): every migration that touches group rights from
m046 on stays pending, every other one is marked applied — the test does not replay the whole
schema history on top of ``create_all``.
"""

import pytest
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.core.permissions import DEFAULT_GROUPS

READS = {"orders:read", "products:read", "customers:read", "stock:read"}
UPDATES = {"orders:update", "products:update", "customers:update", "stock:move", "stock:adjust"}
WORKSHOP_OLD = {"projects:read", "projects:create", "projects:update", "projects:delete", "projects:file_prints"}

# Group rights are touched by these, from m046 on (each imports the Group model).
_RIGHTS_MIGRATIONS = {46, 59, 91, 102, 111, 112, 123, 145, 146, 147, 155, 176, 193, 194}

CUSTOM_BEFORE = {
    "Reader": ["filaments:read", "projects:read"],
    "Editor": ["projects:update", "archives:update_own"],
    "Split A": ["projects:update"],
    "Split B": ["projects:file_prints"],
}
CUSTOM_AFTER = {
    "Reader": {"inventory:read"} | READS,
    "Editor": UPDATES | {"archives:update_own"},
    "Split A": UPDATES,
    "Split B": set(),
}


async def _prepare(test_engine, *, pending_from: int):
    from backend.app.migrations import _discover_migrations, _ensure_migrations_table, _record_migration
    from backend.app.migrations.m001_bamdude_baseline import _seed_default_groups
    from backend.app.models.group import Group

    factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    await _seed_default_groups(factory)
    await _ensure_migrations_table(test_engine)
    async with test_engine.begin() as conn:
        await conn.execute(text("DELETE FROM _migrations"))
    for mig in _discover_migrations():
        if not (mig["version"] in _RIGHTS_MIGRATIONS and mig["version"] >= pending_from):
            await _record_migration(test_engine, mig["version"], mig["name"])

    async with factory() as db:
        for name in ("Administrators", "Operators", "Viewers"):
            perms = list(DEFAULT_GROUPS[name]["permissions"])
            perms = [
                p for p in perms if ":" not in p or p.split(":")[0] not in {"orders", "products", "customers", "stock"}
            ]
            perms += sorted(WORKSHOP_OLD) if name != "Viewers" else ["projects:read"]
            await db.execute(update(Group).where(Group.name == name).values(permissions=perms))
        for name, perms in CUSTOM_BEFORE.items():
            db.add(Group(name=name, is_system=False, permissions=list(perms)))
        await db.commit()
    return factory


async def _groups(factory) -> dict[str, set[str]]:
    from backend.app.models.group import Group

    async with factory() as db:
        rows = (await db.execute(select(Group.name, Group.permissions))).all()
    return {r.name: set(r.permissions or []) for r in rows}


async def _run(test_engine, factory) -> None:
    from backend.app.migrations import _run_pending

    await _run_pending(test_engine, factory)
    # The runner switches SQLite's foreign keys ON after each DDL phase; the test database
    # runs with them off (as the app does), and its teardown drops tables in any order.
    async with test_engine.begin() as conn:
        await conn.execute(text("PRAGMA foreign_keys = OFF"))


@pytest.mark.asyncio
async def test_a_database_from_before_m046_keeps_its_workshop_rights(test_engine):
    factory = await _prepare(test_engine, pending_from=46)

    await _run(test_engine, factory)

    groups = await _groups(factory)
    for name, expected in CUSTOM_AFTER.items():
        assert not WORKSHOP_OLD & groups[name], name
        workshop = {p for p in groups[name] if p.split(":")[0] in {"orders", "products", "customers", "stock"}}
        assert workshop == {p for p in expected if p.split(":")[0] in {"orders", "products", "customers", "stock"}}, (
            name
        )
    assert "inventory:read" in groups["Reader"]  # m046's own rename still applies
    for name in ("Administrators", "Operators", "Viewers"):
        assert not WORKSHOP_OLD & groups[name]


@pytest.mark.asyncio
async def test_the_old_database_ends_where_one_past_m193_does(test_engine):
    factory = await _prepare(test_engine, pending_from=46)
    await _run(test_engine, factory)
    from_old = await _groups(factory)

    from backend.app.models.group import Group

    async with factory() as db:
        for name in CUSTOM_BEFORE:
            await db.execute(Group.__table__.delete().where(Group.__table__.c.name == name))
        await db.commit()

    factory = await _prepare(test_engine, pending_from=194)
    await _run(test_engine, factory)
    from_recent = await _groups(factory)

    def workshop(perms: set[str]) -> set[str]:
        return {p for p in perms if p.split(":")[0] in {"orders", "products", "customers", "stock"}}

    for name in list(CUSTOM_BEFORE) + ["Administrators", "Operators", "Viewers"]:
        assert workshop(from_old[name]) == workshop(from_recent[name]), name


@pytest.mark.asyncio
async def test_a_second_pass_of_the_runner_changes_nothing(test_engine):
    factory = await _prepare(test_engine, pending_from=46)
    await _run(test_engine, factory)
    once = await _groups(factory)

    async with test_engine.begin() as conn:
        await conn.execute(text("DELETE FROM _migrations WHERE version = 194"))
    await _run(test_engine, factory)

    assert await _groups(factory) == once
