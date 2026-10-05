"""m194: the Workshop's domain rights replace ``projects:*`` (WS-13 E13 T14).

Each of ``projects:read/create/update/delete`` becomes its image across orders, products,
customers and stock; ``projects:file_prints`` becomes ``orders:file_prints`` only in a group
that also held ``projects:update`` (R13 — the old right never acted alone). System groups end
with exactly their default Workshop set; old strings leave every group, or the group editor —
which re-sends the whole list — would refuse to save it. Compared by the operations a group
allows, not only by its strings.
"""

import json

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.core.permissions import ALL_PERMISSIONS, DEFAULT_GROUPS, Permission
from backend.app.migrations import m194_workshop_permissions as m194

READS = {"orders:read", "products:read", "customers:read", "stock:read"}
CREATES = {"orders:create", "products:create", "customers:create"}
UPDATES = {"orders:update", "products:update", "customers:update", "stock:move", "stock:adjust"}
DELETES = {"orders:delete", "products:delete", "customers:delete"}
WORKSHOP = READS | CREATES | UPDATES | DELETES | {"orders:file_prints"}
OLD = {"projects:read", "projects:create", "projects:update", "projects:delete", "projects:file_prints"}


# --- the operations a group allows, under the old and the new checker -------------------------
def _old_ops(p: set[str]) -> set[str]:
    ops = set()
    if "projects:read" in p:
        ops |= {"read orders", "read products", "read customers", "read stock"}
    if "projects:create" in p:
        ops |= {"create order", "create product", "create customer"}
    if "projects:update" in p:
        ops |= {"edit order", "edit product", "edit customer", "move stock", "adjust stock"}
        if "projects:file_prints" in p or "archives:update_own" in p or "archives:update_all" in p:
            ops.add("file own print")
        if "projects:file_prints" in p or "archives:update_all" in p:
            ops.add("file anyone's print")
    if "projects:delete" in p:
        ops |= {"delete order", "delete product", "delete customer"}
    return ops


def _new_ops(p: set[str]) -> set[str]:
    named = {
        "orders:read": "read orders",
        "products:read": "read products",
        "customers:read": "read customers",
        "stock:read": "read stock",
        "orders:create": "create order",
        "products:create": "create product",
        "customers:create": "create customer",
        "orders:update": "edit order",
        "products:update": "edit product",
        "customers:update": "edit customer",
        "stock:move": "move stock",
        "stock:adjust": "adjust stock",
        "orders:delete": "delete order",
        "products:delete": "delete product",
        "customers:delete": "delete customer",
    }
    ops = {op for right, op in named.items() if right in p}
    edits_orders = "orders:update" in p
    if "orders:file_prints" in p or (edits_orders and ({"archives:update_own", "archives:update_all"} & p)):
        ops.add("file own print")
    if "orders:file_prints" in p or (edits_orders and "archives:update_all" in p):
        ops.add("file anyone's print")
    return ops


async def _factory(test_engine):
    from backend.app.migrations.m001_bamdude_baseline import _seed_default_groups

    factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    await _seed_default_groups(factory)
    return factory


async def _set(factory, name: str, perms, *, is_system: bool = False) -> None:
    from backend.app.models.group import Group

    async with factory() as db:
        group = (await db.execute(select(Group).where(Group.name == name))).scalar_one_or_none()
        if group is None:
            db.add(Group(name=name, is_system=is_system, permissions=perms))
        else:
            await db.execute(update(Group).where(Group.id == group.id).values(permissions=perms))
        await db.commit()


async def _get(factory) -> dict[str, list[str] | None]:
    from backend.app.models.group import Group

    async with factory() as db:
        rows = (await db.execute(select(Group.name, Group.permissions))).all()
    return {r.name: r.permissions for r in rows}


def _as_before_m194(perms: list[str], old_workshop: list[str]) -> list[str]:
    """A group as it stood before the split: the Workshop part in the old strings."""
    return [p for p in perms if p not in WORKSHOP] + old_workshop


def test_the_defaults_carry_the_new_rights_and_no_old_ones():
    assert not [m for m in Permission if m.value.startswith("projects:")]
    assert set(ALL_PERMISSIONS) >= WORKSHOP
    assert set(DEFAULT_GROUPS["Administrators"]["permissions"]) >= WORKSHOP
    assert set(DEFAULT_GROUPS["Operators"]["permissions"]) >= WORKSHOP
    assert set(DEFAULT_GROUPS["Viewers"]["permissions"]) & WORKSHOP == READS
    for group in DEFAULT_GROUPS.values():
        assert not OLD & set(group["permissions"])


@pytest.mark.asyncio
async def test_system_groups_end_with_exactly_their_default_workshop_set(test_engine):
    factory = await _factory(test_engine)
    for name, old in (
        ("Administrators", sorted(OLD)),
        ("Operators", sorted(OLD)),
        ("Viewers", ["projects:read"]),
    ):
        await _set(factory, name, _as_before_m194(DEFAULT_GROUPS[name]["permissions"], old), is_system=True)

    await m194.seed(factory)

    groups = await _get(factory)
    for name in ("Administrators", "Operators", "Viewers"):
        assert not OLD & set(groups[name])
        assert set(groups[name]) & WORKSHOP == set(DEFAULT_GROUPS[name]["permissions"]) & WORKSHOP


@pytest.mark.asyncio
async def test_a_system_group_that_lost_its_workshop_rights_gets_them_back(test_engine):
    """An old database whose groups passed m046 before ``_CARRIED_FORWARD`` existed."""
    factory = await _factory(test_engine)
    stripped = [p for p in DEFAULT_GROUPS["Operators"]["permissions"] if p not in WORKSHOP]
    await _set(factory, "Operators", stripped, is_system=True)

    await m194.seed(factory)

    assert set((await _get(factory))["Operators"]) & WORKSHOP == WORKSHOP


@pytest.mark.parametrize(
    "old, expected_workshop",
    [
        (["projects:read"], READS),
        (["projects:update"], UPDATES),
        (["projects:create", "projects:delete"], CREATES | DELETES),
        (["projects:update", "projects:file_prints"], UPDATES | {"orders:file_prints"}),
        (["projects:file_prints"], set()),
        (["projects:update", "archives:update_own"], UPDATES),
        (["projects:read", "projects:create", "projects:update", "projects:delete"], WORKSHOP - {"orders:file_prints"}),
    ],
)
@pytest.mark.asyncio
async def test_a_custom_group_gets_the_image_of_what_it_held(test_engine, old, expected_workshop):
    factory = await _factory(test_engine)
    await _set(factory, "Custom", old)

    await m194.seed(factory)

    perms = set((await _get(factory))["Custom"])
    assert not OLD & perms
    assert perms & WORKSHOP == expected_workshop
    # The same operations, the new checker against the old one — nothing widens, nothing narrows
    # for a group on its own.
    assert _new_ops(perms) == _old_ops(set(old))


@pytest.mark.asyncio
async def test_other_rights_keep_their_place_and_an_unknown_string_is_left_alone(test_engine):
    factory = await _factory(test_engine)
    await _set(factory, "Custom", ["inventory:read", "unknown:thing", "projects:read", "queue:create"])

    await m194.seed(factory)

    perms = (await _get(factory))["Custom"]
    assert perms[:2] == ["inventory:read", "unknown:thing"]
    assert set(perms[2:-1]) == READS
    assert perms[-1] == "queue:create"


@pytest.mark.asyncio
async def test_a_list_stored_as_a_json_string_and_a_null_list_are_handled(test_engine):
    from backend.app.models.group import Group

    factory = await _factory(test_engine)
    await _set(factory, "Stringly", ["placeholder"])
    await _set(factory, "Empty", None)
    async with factory() as db:
        await db.execute(
            update(Group.__table__)
            .where(Group.__table__.c.name == "Stringly")
            .values(permissions=json.dumps(["projects:read"]))
        )
        await db.commit()

    await m194.seed(factory)

    groups = await _get(factory)
    stringly = groups["Stringly"]
    if isinstance(stringly, str):
        stringly = json.loads(stringly)
    assert set(stringly) == READS
    assert groups["Empty"] in (None, [])


@pytest.mark.asyncio
async def test_rights_spread_over_two_groups_narrow_and_never_widen(test_engine):
    """``projects:update`` in A and ``projects:file_prints`` in B let the user file anyone's
    print; per group, B's right does not travel (R13), so the user keeps only own prints."""
    factory = await _factory(test_engine)
    await _set(factory, "A", ["projects:update", "archives:update_own"])
    await _set(factory, "B", ["projects:file_prints"])

    await m194.seed(factory)

    groups = await _get(factory)
    after = set(groups["A"]) | set(groups["B"])
    before = {"projects:update", "archives:update_own", "projects:file_prints"}
    assert _new_ops(after) <= _old_ops(before)
    assert _old_ops(before) - _new_ops(after) == {"file anyone's print"}


@pytest.mark.asyncio
async def test_a_second_run_changes_nothing(test_engine):
    factory = await _factory(test_engine)
    await _set(factory, "Custom", ["projects:update", "projects:file_prints", "library:read_all"])
    await _set(factory, "Viewers", ["projects:read"], is_system=True)

    await m194.seed(factory)
    once = await _get(factory)
    await m194.seed(factory)

    assert await _get(factory) == once


@pytest.mark.asyncio
async def test_a_fresh_chain_ends_with_the_defaults(test_engine):
    """m001 seeds the new defaults, m193 still appends its old string, m194 removes it."""
    from backend.app.migrations import m193_projects_file_prints as m193

    factory = await _factory(test_engine)
    await m193.seed(factory)
    await m194.seed(factory)

    groups = await _get(factory)
    for name, group in DEFAULT_GROUPS.items():
        assert set(groups[name]) == set(group["permissions"]), name


# ---- WS-13 E13 V05 (Codex review): two data states O15 names, both must survive the seed ----


@pytest.mark.asyncio
async def test_a_nested_object_or_list_among_the_rights_neither_stops_the_seed_nor_is_lost(test_engine):
    """A dict or a list inside the stored list is not a right, but it is not the migration's to
    drop: the strings around it are mapped, the foreign elements stay where they were."""
    factory = await _factory(test_engine)
    await _set(factory, "CustomMalformed", ["projects:read", {"legacy": True}, ["legacy"], "library:read_all"])
    await _set(factory, "Viewers", ["projects:read", {"odd": 1}], is_system=True)

    await m194.seed(factory)

    groups = await _get(factory)
    custom = groups["CustomMalformed"]
    assert {p for p in custom if isinstance(p, str)} == READS | {"library:read_all"}
    assert {"legacy": True} in custom and ["legacy"] in custom
    viewers = groups["Viewers"]
    assert {p for p in viewers if isinstance(p, str)} & WORKSHOP == READS
    assert {"odd": 1} in viewers


@pytest.mark.asyncio
@pytest.mark.parametrize("stored", [None, "not json", '{"not": "a list"}'])
async def test_a_system_group_without_a_readable_list_gets_its_defaults(test_engine, stored):
    """NULL, unreadable or non-list permissions on a system group: it gets its default Workshop
    set, as an empty list does; a custom group in the same state is left alone."""
    from backend.app.models.group import Group

    factory = await _factory(test_engine)
    await _set(factory, "Operators", ["placeholder"], is_system=True)
    await _set(factory, "Custom", ["placeholder"])
    async with factory() as db:
        for name in ("Operators", "Custom"):
            await db.execute(update(Group.__table__).where(Group.__table__.c.name == name).values(permissions=stored))
        await db.commit()

    await m194.seed(factory)
    once = await _get(factory)
    await m194.seed(factory)

    assert set(once["Operators"] or []) & WORKSHOP == WORKSHOP
    assert await _get(factory) == once
    custom = once["Custom"]
    assert custom is None or custom == stored or (isinstance(custom, str) and custom == stored)
