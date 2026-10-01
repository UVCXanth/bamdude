"""WS-13 E5 read additions (vault 60-specs/workshop-ui-parity-e05-add-to-order-config, H01–H02).

H01 — a catalog row carries its variant groups with their options, so the add-to-order
dialog shows «group: option / option» for an unpicked row and fills a picked row's
selects without reading every picked product's detail.

H02 — a library list row says whether its TYPE can be planned (the same
``is_plan_eligible`` the batch refuses by). «Sliced» is not a new field: the list
already carries ``file_tags``, and its ``gcode`` tag is pinned here against
``LibraryFile.is_printable()`` so the two cannot drift.
"""

import pytest
from sqlalchemy import select

from backend.app.models.library import LibraryFile
from backend.app.models.product import Product
from backend.app.models.product_variant import ProductVariantGroup, ProductVariantOption
from backend.app.models.project import Project
from backend.app.services.library_helpers import compute_file_tags
from backend.tests.unit.services.test_product_composition import counting_statements

pytestmark = pytest.mark.integration


async def _product_with_groups(db, name: str) -> int:
    """Two groups: «Tail» (standard «straight»; options stored out of position order)
    and «Mount» with no standard option."""
    product = Product(name=name)
    db.add(product)
    await db.flush()
    tail = ProductVariantGroup(product_id=product.id, name="Tail", position=0)
    mount = ProductVariantGroup(product_id=product.id, name="Mount", position=1)
    db.add_all([tail, mount])
    await db.flush()
    angled = ProductVariantOption(group_id=tail.id, name="angled", position=1)
    straight = ProductVariantOption(group_id=tail.id, name="straight", position=0)
    wall = ProductVariantOption(group_id=mount.id, name="wall", position=0)
    din = ProductVariantOption(group_id=mount.id, name="din", position=1)
    db.add_all([angled, straight, wall, din])
    await db.flush()
    tail.default_option_id = straight.id
    await db.flush()
    return product.id


async def _rows(client) -> dict[int, dict]:
    r = await client.get("/api/v1/products", params={"page": 1, "per_page": 50})
    assert r.status_code == 200, r.text
    return {row["id"]: row for row in r.json()["items"]}


@pytest.mark.asyncio
async def test_a_catalog_row_carries_its_groups_and_options_in_order(committing_client, db_session):
    pid = await _product_with_groups(db_session, "Pipe")
    bare = Product(name="Bare")
    db_session.add(bare)
    await db_session.commit()

    rows = await _rows(committing_client)

    groups = rows[pid]["variant_groups"]
    assert [g["name"] for g in groups] == ["Tail", "Mount"]
    assert [o["name"] for o in groups[0]["options"]] == ["straight", "angled"]
    assert [o["name"] for o in groups[1]["options"]] == ["wall", "din"]
    straight = groups[0]["options"][0]["id"]
    assert groups[0]["default_option_id"] == straight
    # A group without a standard option says so — the server leaves it unchosen.
    assert groups[1]["default_option_id"] is None
    assert rows[bare.id]["variant_groups"] == []
    # The old field stays for its readers.
    assert rows[pid]["variant_group_names"] == ["Tail", "Mount"]


@pytest.mark.asyncio
async def test_the_catalog_page_reads_groups_in_a_fixed_number_of_statements(
    committing_client, db_session, test_engine
):
    await _product_with_groups(db_session, "One")
    await db_session.commit()
    # The first request of a session also asks one-off auth questions; warm up first.
    await _rows(committing_client)
    with counting_statements(test_engine) as one:
        await _rows(committing_client)

    for i in range(6):
        await _product_with_groups(db_session, f"More {i}")
    await db_session.commit()
    with counting_statements(test_engine) as seven:
        await _rows(committing_client)

    assert len(seven) == len(one)


def _file(name: str, file_type: str, sliced: bool | None) -> LibraryFile:
    meta = {} if sliced is None else {"has_sliced_gcode": sliced}
    return LibraryFile(
        filename=name,
        file_path=name,
        file_size=1,
        file_type=file_type,
        file_metadata=meta,
        file_tags=compute_file_tags(
            filename=name, file_type=file_type, file_metadata=meta, source_type=None, swap_compatible=False
        ),
    )


CASES = [
    # name, file_type, has_sliced_gcode, plan_eligible
    ("a.gcode.3mf", "gcode", True, True),
    ("b.gcode.3mf", "gcode", False, True),
    ("c.gcode", "gcode", None, True),
    ("d.3mf", "3mf", True, True),
    ("e.3mf", "3mf", False, True),
    ("f.stl", "stl", None, False),
    ("g.step", "step", None, False),
]


@pytest.mark.asyncio
async def test_a_library_row_says_whether_its_type_can_be_planned(committing_client, db_session):
    files = [_file(name, file_type, sliced) for name, file_type, sliced, _ in CASES]
    db_session.add_all(files)
    await db_session.commit()

    r = await committing_client.get("/api/v1/library/files", params={"page": 1, "per_page": 50})
    assert r.status_code == 200, r.text
    by_name = {row["filename"]: row for row in r.json()["items"]}

    assert {name: by_name[name]["plan_eligible"] for name, *_ in CASES} == {
        name: eligible for name, _, _, eligible in CASES
    }


@pytest.mark.asyncio
async def test_the_gcode_tag_of_a_library_row_is_is_printable(committing_client, db_session):
    """The frontend's «sliced» is ``isPrintable`` = the ``gcode`` tag of ``file_tags``;
    the server's is ``LibraryFile.is_printable()``. One rule, two readers — pinned."""
    files = [_file(name, file_type, sliced) for name, file_type, sliced, _ in CASES]
    db_session.add_all(files)
    await db_session.commit()

    printable = set(
        (await db_session.execute(select(LibraryFile.filename).where(LibraryFile.is_printable()))).scalars().all()
    )
    r = await committing_client.get("/api/v1/library/files", params={"page": 1, "per_page": 50})
    tagged = {row["filename"] for row in r.json()["items"] if "gcode" in row["file_tags"]}

    assert tagged == printable
    # The cases the rule turns on: content beats the name; an unknown gcode flag is «yes».
    assert printable == {"a.gcode.3mf", "c.gcode", "d.3mf"}


@pytest.mark.asyncio
async def test_a_file_the_list_calls_not_plannable_is_the_one_the_batch_refuses(committing_client, db_session):
    """H02 is the batch's own rule: the STL the list marks ``plan_eligible: false`` is the
    file a plate line of the batch refuses — not a second opinion (review M6)."""
    stl = _file("f.stl", "stl", None)
    order = Project(name="O", status="active")
    db_session.add_all([stl, order])
    await db_session.commit()

    r = await committing_client.get("/api/v1/library/files", params={"page": 1, "per_page": 50})
    (row,) = [row for row in r.json()["items"] if row["id"] == stl.id]
    assert row["plan_eligible"] is False

    refused = await committing_client.post(
        f"/api/v1/projects/{order.id}/lines/batch",
        json={"lines": [{"kind": "plate", "library_file_id": stl.id, "plate_index": 1, "copies": 1}]},
    )
    assert refused.status_code == 400
    assert refused.json()["detail"] == "Only 3MF files can be planned"


@pytest.mark.asyncio
async def test_the_library_list_reads_in_a_fixed_number_of_statements(committing_client, db_session, test_engine):
    """``plan_eligible`` is computed from the row, never read per file (review M6)."""
    db_session.add(_file("one.gcode.3mf", "gcode", True))
    await db_session.commit()

    async def page():
        r = await committing_client.get("/api/v1/library/files", params={"page": 1, "per_page": 50})
        assert r.status_code == 200, r.text

    await page()  # the first request of a session also asks one-off auth questions
    with counting_statements(test_engine) as one:
        await page()

    db_session.add_all([_file(name, file_type, sliced) for name, file_type, sliced, _ in CASES])
    await db_session.commit()
    with counting_statements(test_engine) as eight:
        await page()

    assert len(eight) == len(one)
