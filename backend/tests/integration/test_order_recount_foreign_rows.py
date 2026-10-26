"""A filed mixed plate still hands its foreign rows out by the lines' need."""

import pytest
from sqlalchemy import select

from backend.app.models.archive_part import PrintArchivePart
from backend.app.models.product import Product, ProductPart, ProductPlate
from backend.app.models.project_line import ProjectLine
from backend.app.services import order_metrics
from backend.tests.integration.test_order_recount import archive, count, read, shop  # noqa: F401

pytestmark = pytest.mark.integration


@pytest.fixture
async def mixed(committing_client, db_session, shop):
    other = await db_session.scalar(select(Product).where(Product.name == "Product B"))
    db_session.add(ProductPlate(product_id=other.id, library_file_id=shop["file"].id, plate_index=0))
    part = ProductPart(product_id=other.id, kind="printed", name="Part C", name_key="part c", qty_per_unit=1)
    db_session.add(part)
    await db_session.commit()
    result = await committing_client.post(
        f"/api/v1/projects/{shop['order']}/lines", json={"product_id": other.id, "quantity": 1}
    )
    assert result.status_code == 200, result.text
    home = next(line["id"] for line in result.json()["lines"] if line["product_id"] == other.id)
    return {"home": home, "part": part.id}


async def file_mixed(client, db, s, mixed, quantities=(30, 10), *, status="completed"):
    made, _ = await archive(db, s, status=status, quantities=quantities)
    db.add(PrintArchivePart(archive_id=made.id, name="Part C", name_key="part c", quantity=1, defective=0))
    await db.commit()
    result = await client.post(
        f"/api/v1/projects/{s['order']}/add-archives",
        json={"archive_ids": [made.id], "project_line_id": mixed["home"]},
    )
    assert result.status_code == 200, result.text
    return made.id


async def total(db, s):
    db.expire_all()  # API writes commit through a different session.
    ctx = await order_metrics.load_order_context(db, s["order"])
    return sum(p.usable for f in order_metrics.attribute(ctx)[0].values() for p in f.parts if p.part_id == s["b"].id)


@pytest.mark.parametrize("corrected", [True, False])
async def test_foreign_rows_of_filed_print_keep_recount(committing_client, db_session, shop, mixed, corrected):
    s = shop
    bid, product_id = s["b"].id, s["b"].product_id
    await file_mixed(committing_client, db_session, s, mixed)
    if corrected:
        result = await count(committing_client, s, {bid: 5})
        assert result.status_code == 200, result.text
    added = await committing_client.post(
        f"/api/v1/projects/{s['order']}/lines", json={"product_id": product_id, "quantity": 10}
    )
    assert added.status_code in (200, 409), added.text
    edited = await committing_client.patch(f"/api/v1/projects/{s['order']}/lines/{s['line']}", json={"quantity": 1})
    assert edited.status_code in (200, 409), edited.text
    assert await total(db_session, s) == (5 if corrected else 10)
    if corrected:
        assert added.status_code == edited.status_code == 409
        assert (await count(committing_client, s, {bid: 10})).status_code == 200
        assert (
            await committing_client.post(
                f"/api/v1/projects/{s['order']}/lines", json={"product_id": product_id, "quantity": 10}
            )
        ).status_code == 200
    else:
        assert added.status_code == edited.status_code == 200


async def test_foreign_pool_with_existing_sibling_refuses_an_initial_recount(
    committing_client, db_session, shop, mixed
):
    s = shop
    await file_mixed(committing_client, db_session, s, mixed)
    added = await committing_client.post(
        f"/api/v1/projects/{s['order']}/lines", json={"product_id": s["b"].product_id, "quantity": 10}
    )
    assert added.status_code == 200, added.text
    current = await read(committing_client, s)
    assert current["blocked"] == "order_recount_shared"
    assert (await count(committing_client, s, {s["b"].id: 5}, snapshot=current)).status_code == 409
    assert await total(db_session, s) == 10


async def test_later_foreign_pool_permits_only_full_reviewed_reversal(committing_client, db_session, shop, mixed):
    s = shop
    bid = s["b"].id
    await archive(db_session, s, status="completed", quantities=(30, 10))
    later_id = await file_mixed(committing_client, db_session, s, mixed, quantities=(6, 2), status="printing")
    assert (await count(committing_client, s, {bid: 5})).status_code == 200
    added = await committing_client.post(
        f"/api/v1/projects/{s['order']}/lines", json={"product_id": s["b"].product_id, "quantity": 10}
    )
    assert added.status_code == 200, added.text
    from backend.app.models.archive import PrintArchive

    later = await db_session.get(PrintArchive, later_id, populate_existing=True)
    later.status = "completed"
    await db_session.commit()
    assert await total(db_session, s) == 7
    current = await read(committing_client, s)
    assert current["blocked"] == "order_recount_shared"
    assert (await count(committing_client, s, {bid: 4}, snapshot=current)).status_code == 409
    raw = {p["part_id"]: p["book"] - p["adjustment"] for p in current["parts"]}
    result = await count(committing_client, s, raw)
    assert result.status_code == 200, result.text
    assert not (await db_session.get(ProjectLine, s["line"], populate_existing=True)).part_count_adjustments
    assert await total(db_session, s) == 12


async def test_a_genuine_home_count_remains_editable_despite_foreign_rows(committing_client, db_session, shop, mixed):
    s = shop
    await file_mixed(committing_client, db_session, s, mixed)
    home = {**s, "line": mixed["home"]}
    assert (await count(committing_client, home, {mixed["part"]: 0})).status_code == 200
    # A sibling of B cannot take C: the explicit home owns C regardless of need.
    line = await db_session.get(ProjectLine, mixed["home"])
    added = await committing_client.post(
        f"/api/v1/projects/{s['order']}/lines", json={"product_id": line.product_id, "quantity": 10}
    )
    assert added.status_code == 200, added.text
    edited = await committing_client.patch(f"/api/v1/projects/{s['order']}/lines/{mixed['home']}", json={"quantity": 2})
    assert edited.status_code == 200, edited.text
    assert (await read(committing_client, home))["blocked"] is None
    assert await total(db_session, s) == 10


@pytest.mark.parametrize("foreign", [False, True])
async def test_a_configured_out_spare_cannot_leave_its_corrected_line(
    committing_client, db_session, shop, mixed, foreign
):
    s = shop
    bid, product_id = s["b"].id, s["b"].product_id
    result = await committing_client.put(
        f"/api/v1/projects/{s['order']}/lines/{s['line']}/configuration",
        json={"choices": {}, "part_counts": {str(bid): 0}},
    )
    assert result.status_code == 200, result.text
    if foreign:
        await file_mixed(committing_client, db_session, s, mixed, quantities=(0, 10))
    else:
        made, _ = await archive(db_session, s, status="completed", quantities=(0, 10))
        made.project_line_id = None
        await db_session.commit()
    assert (await count(committing_client, s, {bid: 5})).status_code == 200
    # A newly added default configuration counts B. It would take the surplus
    # currently held as a per=0 spare and strand the correction on an empty row.
    result = await committing_client.post(
        f"/api/v1/projects/{s['order']}/lines", json={"product_id": product_id, "quantity": 10}
    )
    assert result.status_code == 409, result.text
    assert await total(db_session, s) == 5
