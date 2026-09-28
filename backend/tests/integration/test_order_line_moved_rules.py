"""A line whose stock has moved is only added to; cancel, delete and reactivation after it
(spec workshop-order-issue, rules 13–15)."""

import pytest
from sqlalchemy import func, select

from backend.app.models.archive import PrintArchive
from backend.app.models.archive_part import PrintArchivePart
from backend.app.models.customer import Customer
from backend.app.models.finished_stock import StockItem
from backend.app.models.part_stock import ProductPartStockMovement
from backend.app.models.product import Product, ProductOrigin, ProductPart
from backend.app.models.project import Project
from backend.app.models.project_line import ProjectLine, ProjectLinePartStock
from backend.app.models.stock_issue import StockIssue
from backend.app.services import finished_stock, line_config, part_stock

pytestmark = pytest.mark.integration


@pytest.fixture
async def shop(db_session):
    """Pipe (flask ×1, cap ×1): 5 of each free, 2 ready pipes; an active order for Acme."""
    pipe = Product(name="Pipe")
    acme = Customer(name="Acme")
    db_session.add_all([pipe, acme])
    await db_session.flush()
    flask = ProductPart(product_id=pipe.id, kind="printed", name="flask", name_key="flask", qty_per_unit=1)
    cap = ProductPart(product_id=pipe.id, kind="printed", name="cap", name_key="cap", qty_per_unit=1)
    db_session.add_all([flask, cap])
    await db_session.flush()
    for part in (flask, cap):
        await part_stock.move(db_session, part_id=part.id, delta=5, reason="manual", note="seed")
    position = await finished_stock.item_for(db_session, pipe.id, {}, create=True)
    await finished_stock.receive(db_session, position, 2)
    order = Project(name="O", customer_id=acme.id)
    db_session.add(order)
    await db_session.commit()
    return {"pipe": pipe, "flask": flask, "cap": cap, "order": order, "acme": acme, "position": position}


async def _line(db, shop, *, quantity=6, mode="product", counts=None):
    line = ProjectLine(project_id=shop["order"].id, product_id=shop["pipe"].id, quantity=quantity, mode=mode)
    db.add(line)
    await db.flush()
    await line_config.seed_line(db, line, choices=None, counts=counts)
    return line


async def _print(db, shop, line, **parts):
    archive = PrintArchive(
        project_id=shop["order"].id,
        project_line_id=line.id,
        filename="pipe",
        file_path="",
        file_size=0,
        status="completed",
        quantity=1,
    )
    db.add(archive)
    await db.flush()
    db.add_all([PrintArchivePart(archive_id=archive.id, name=n, name_key=n, quantity=q) for n, q in parts.items()])
    await db.flush()


async def _moved_line(client, db, shop):
    """6 ordered: 2 ready + 3 kits + 1 printed; 1 kit assembled, 1 received, 2 issued —
    issued 2, held 2 (2 ready + 1 assembled + 1 received − 2), 2 kits still reserved."""
    line = await _line(db, shop)
    assert await finished_stock.reserve_for_line(db, line, 2) == 2
    assert await part_stock.reserve_for_line(db, line, 3) == 3
    await _print(db, shop, line, flask=1, cap=1)
    await db.commit()
    body = {"lines": [{"line_id": line.id, "assemble": 1, "receive": 1, "issue": 2}]}
    r = await client.post(f"/api/v1/projects/{shop['order'].id}/fulfilment", json=body)
    assert r.status_code == 200, r.text
    return line.id


async def _position(db, shop):
    return await db.get(StockItem, shop["position"].id, populate_existing=True)


async def _free(db, part):
    return await db.scalar(
        select(func.coalesce(func.sum(ProductPartStockMovement.delta), 0)).where(
            ProductPartStockMovement.product_part_id == part.id
        )
    )


def _line_url(shop, line_id):
    return f"/api/v1/projects/{shop['order'].id}/lines/{line_id}"


async def _set_status(client, shop, status):
    return await client.patch(f"/api/v1/projects/{shop['order'].id}", json={"status": status})


MOVED = "This line's stock has moved; take more from stock instead"


@pytest.mark.asyncio
@pytest.mark.parametrize("body", [{"from_finished": 3}, {"from_stock_units": 3}, {"quantity": 6, "from_finished": 2}])
async def test_a_moved_lines_stock_numbers_are_refused(committing_client, db_session, shop, body):
    line_id = await _moved_line(committing_client, db_session, shop)
    r = await committing_client.patch(_line_url(shop, line_id), json=body)
    assert (r.status_code, r.json()["detail"]) == (409, MOVED)


@pytest.mark.asyncio
async def test_a_moved_lines_kits_come_down_and_go_back_to_the_shelf(committing_client, db_session, shop):
    # spec workshop-order-issue-followups, rule 42: 2 kits still reserved on the moved line.
    line_id = await _moved_line(committing_client, db_session, shop)
    free = await _free(db_session, shop["flask"])
    r = await committing_client.patch(_line_url(shop, line_id), json={"from_stock_units": 0})
    assert r.status_code == 200, r.text
    line = await db_session.get(ProjectLine, line_id, populate_existing=True)
    assert await part_stock.reserved_units_for_line(db_session, line) == 0
    assert await _free(db_session, shop["flask"]) == free + 2
    state = (await committing_client.get(f"/api/v1/projects/{shop['order'].id}/fulfilment")).json()
    assert state["lines"][0]["can_assemble"] == 0


@pytest.mark.asyncio
async def test_a_moved_line_is_not_reconfigured(committing_client, db_session, shop):
    line_id = await _moved_line(committing_client, db_session, shop)
    url = f"{_line_url(shop, line_id)}/configuration"
    r = await committing_client.put(url, json={"choices": {}, "part_counts": {}})
    assert (r.status_code, r.json()["detail"]) == (409, MOVED)


@pytest.mark.asyncio
async def test_a_moved_lines_quantity_stays_above_what_it_issued_and_holds(committing_client, db_session, shop):
    line_id = await _moved_line(committing_client, db_session, shop)
    r = await committing_client.patch(_line_url(shop, line_id), json={"quantity": 3})
    assert r.status_code == 409
    assert r.json()["detail"] == "The quantity cannot go below what is issued and held for this order (4)"
    assert (await committing_client.patch(_line_url(shop, line_id), json={"quantity": 8})).status_code == 200
    r = await committing_client.patch(_line_url(shop, line_id), json={"quantity": 4})
    assert r.status_code == 200, r.text
    line = await db_session.get(ProjectLine, line_id, populate_existing=True)
    assert await part_stock.reserved_units_for_line(db_session, line) == 0  # no room left for the kits


@pytest.mark.asyncio
async def test_cancelling_after_a_partial_issue_gives_the_shelf_back(committing_client, db_session, shop):
    line_id = await _moved_line(committing_client, db_session, shop)
    assert (await _position(db_session, shop)).on_hand == 2  # 2 ready + 1 assembled + 1 received − 2 issued
    r = await _set_status(committing_client, shop, "cancelled")
    assert r.status_code == 200, r.text
    position = await _position(db_session, shop)
    assert (position.on_hand, position.reserved) == (2, 0)  # free stock now
    assert await _free(db_session, shop["flask"]) == 4  # 5 − 3 reserved + the 2 kits nobody assembled
    line = await db_session.get(ProjectLine, line_id, populate_existing=True)
    assert (line.issued, line.returned, finished_stock.held_units(line)) == (2, 2, 0)


@pytest.mark.asyncio
async def test_a_cancelled_order_whose_stock_moved_does_not_come_back(committing_client, db_session, shop):
    await _moved_line(committing_client, db_session, shop)
    assert (await _set_status(committing_client, shop, "cancelled")).status_code == 200
    r = await _set_status(committing_client, shop, "active")
    assert (r.status_code, r.json()["detail"]) == (409, "This order's stock has moved; duplicate it instead")


@pytest.mark.asyncio
async def test_a_cancelled_order_that_never_moved_comes_back_without_what_it_gave_back(
    committing_client, db_session, shop
):
    line = await _line(db_session, shop, quantity=4)
    assert await finished_stock.reserve_for_line(db_session, line, 2) == 2
    assert await part_stock.reserve_for_line(db_session, line, 2) == 2
    await db_session.commit()
    assert (await _set_status(committing_client, shop, "cancelled")).status_code == 200
    r = await _set_status(committing_client, shop, "active")
    assert r.status_code == 200, r.text
    [row] = r.json()["lines"]
    assert (row["from_finished"], row["from_kit_units"], row["from_stock_units"]) == (0, 0, 0)


@pytest.mark.asyncio
async def test_a_parts_lines_parts_become_free_on_cancel(committing_client, db_session, shop):
    flask = shop["flask"]
    line = await _line(db_session, shop, quantity=1, mode="parts", counts={flask.id: 3})
    await _print(db_session, shop, line, flask=2)
    await db_session.commit()
    body = {"lines": [{"line_id": line.id, "parts": [{"part_id": flask.id, "receive": 2, "issue": 1}]}]}
    assert (
        await committing_client.post(f"/api/v1/projects/{shop['order'].id}/fulfilment", json=body)
    ).status_code == 200
    assert await _free(db_session, flask) == 5  # received and issued: the free balance never saw them
    assert (await _set_status(committing_client, shop, "cancelled")).status_code == 200
    assert await _free(db_session, flask) == 6  # the one left on the shelf is free now
    row = await db_session.get(ProjectLinePartStock, (line.id, flask.id), populate_existing=True)
    assert (row.received, row.issued, row.returned) == (2, 1, 1)


@pytest.mark.asyncio
async def test_deleting_a_moved_line_gives_back_and_forgets_its_counters(committing_client, db_session, shop):
    line_id = await _moved_line(committing_client, db_session, shop)
    flask = shop["flask"]
    parts = await _line(db_session, shop, quantity=1, mode="parts", counts={flask.id: 2})
    await _print(db_session, shop, parts, flask=2)
    await db_session.commit()
    body = {"lines": [{"line_id": parts.id, "parts": [{"part_id": flask.id, "receive": 1}]}]}
    assert (
        await committing_client.post(f"/api/v1/projects/{shop['order'].id}/fulfilment", json=body)
    ).status_code == 200
    for lid in (line_id, parts.id):
        assert (await committing_client.delete(_line_url(shop, lid))).status_code == 200
    position = await _position(db_session, shop)
    assert (position.on_hand, position.reserved) == (2, 0)
    assert await _free(db_session, flask) == 5  # 2 kits back, 1 held part back: 5 − 3 + 2 + 1
    assert await db_session.scalar(select(func.count()).select_from(ProjectLinePartStock)) == 0


@pytest.mark.asyncio
async def test_deleting_the_order_leaves_its_issues_with_the_customer(committing_client, db_session, shop):
    await _moved_line(committing_client, db_session, shop)
    assert (await committing_client.delete(f"/api/v1/projects/{shop['order'].id}")).status_code == 200
    [issue] = (await db_session.execute(select(StockIssue).execution_options(populate_existing=True))).scalars().all()
    assert (issue.project_id, issue.customer_id) == (None, shop["acme"].id)
    assert (await _position(db_session, shop)).reserved == 0


@pytest.mark.asyncio
async def test_a_part_deleted_or_merged_takes_its_line_counters_along(db_session, shop):
    flask, cap = shop["flask"], shop["cap"]
    line = await _line(db_session, shop, quantity=1, mode="parts", counts={flask.id: 2, cap.id: 2})
    await part_stock.receive_parts_for_line(db_session, line, {flask.id: 2, cap.id: 1}, created_by=None)
    await part_stock.repoint(db_session, from_part_id=cap.id, to_part_id=flask.id)
    rows = (await part_stock.line_part_stock(db_session, [line.id]))[line.id]
    assert {pid: row.received for pid, row in rows.items()} == {flask.id: 3}
    await part_stock.delete_for_part(db_session, flask.id)
    assert await db_session.scalar(select(func.count()).select_from(ProjectLinePartStock)) == 0


@pytest.mark.asyncio
async def test_a_one_off_product_with_units_on_the_shelf_outlives_its_deleted_order(
    committing_client, db_session, shop
):
    """A one-off product's printed units went through the shelf (Task 4's ruling); after a
    cancel they are free stock on its position. Deleting the order must not fail on the
    one-off cleanup — the product stays while its units are on the shelf."""
    plate = Product(name="Plate 1 of flask.3mf", origin=ProductOrigin.ADHOC_PLATE.value)
    db_session.add(plate)
    await db_session.flush()
    db_session.add(ProductPart(product_id=plate.id, kind="printed", name="flask", name_key="flask", qty_per_unit=1))
    await db_session.flush()
    line = ProjectLine(project_id=shop["order"].id, product_id=plate.id, quantity=2)
    db_session.add(line)
    await db_session.flush()
    await line_config.seed_line(db_session, line, choices=None, counts=None)
    await _print(db_session, shop, line, flask=2)
    await db_session.commit()
    body = {"lines": [{"line_id": line.id, "receive": 2}]}
    assert (
        await committing_client.post(f"/api/v1/projects/{shop['order'].id}/fulfilment", json=body)
    ).status_code == 200
    assert (await _set_status(committing_client, shop, "cancelled")).status_code == 200
    r = await committing_client.delete(f"/api/v1/projects/{shop['order'].id}")
    assert r.status_code == 200, r.text
    assert await db_session.get(Product, plate.id, populate_existing=True) is not None
    [position] = (
        (
            await db_session.execute(
                select(StockItem).where(StockItem.product_id == plate.id).execution_options(populate_existing=True)
            )
        )
        .scalars()
        .all()
    )
    assert (position.on_hand, position.reserved) == (2, 0)
