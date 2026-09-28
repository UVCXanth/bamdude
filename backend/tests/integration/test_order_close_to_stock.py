"""An order without a customer closes into free stock once everything is received
(spec workshop-order-issue-followups, rules 35–41)."""

import pytest
from sqlalchemy import func, select

from backend.app.models.archive import PrintArchive
from backend.app.models.archive_part import PrintArchivePart
from backend.app.models.customer import Customer
from backend.app.models.finished_stock import StockItem
from backend.app.models.part_stock import ProductPartStockMovement
from backend.app.models.product import Product, ProductPart
from backend.app.models.project import Project, ProjectEvent
from backend.app.models.project_line import ProjectLine
from backend.app.services import finished_stock, line_config, part_stock

pytestmark = pytest.mark.integration


@pytest.fixture
async def shop(db_session):
    """Pipe (flask ×1, cap ×1): 5 of each free, 2 ready pipes; an active order with NO customer."""
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
    order = Project(name="O")
    db_session.add(order)
    await db_session.commit()
    return {"pipe": pipe, "flask": flask, "cap": cap, "order": order, "acme": acme, "position": position}


async def _line(db, shop, *, quantity=3, mode="product", counts=None):
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


async def _received_line(db, shop, quantity=3):
    line = await _line(db, shop, quantity=quantity)
    await _print(db, shop, line, flask=quantity, cap=quantity)
    await db.commit()
    return line


async def _position(db, shop):
    return await db.get(StockItem, shop["position"].id, populate_existing=True)


async def _free(db, part):
    return await db.scalar(
        select(func.coalesce(func.sum(ProductPartStockMovement.delta), 0)).where(
            ProductPartStockMovement.product_part_id == part.id
        )
    )


@pytest.mark.asyncio
async def test_an_order_without_a_customer_closes_to_stock(committing_client, db_session, shop):
    line = await _received_line(db_session, shop)
    url = f"/api/v1/projects/{shop['order'].id}/fulfilment"
    state = (await committing_client.get(url)).json()
    assert (state["closes_to_stock"], state["can_complete"]) == (True, False)
    r = await committing_client.post(url, json={"lines": [{"line_id": line.id, "receive": 2}], "complete": True})
    assert (r.status_code, r.json()["detail"]) == (409, "Receive everything the order needs before closing it to stock")
    position = await _position(db_session, shop)
    free_before = position.on_hand - position.reserved
    r = await committing_client.post(url, json={"lines": [{"line_id": line.id, "receive": 3}], "complete": True})
    assert r.status_code == 200, r.text
    assert (r.json()["order"]["status"], r.json()["issue_id"]) == ("completed", None)
    position = await _position(db_session, shop)
    assert position.on_hand - position.reserved == free_before + 3  # the three are free stock now
    await db_session.refresh(line)
    assert (line.received, line.returned, line.issued) == (3, 3, 0)
    kinds = [e.kind for e in (await db_session.execute(select(ProjectEvent).order_by(ProjectEvent.id))).scalars()]
    assert kinds[-2:] == ["goods_stocked", "status_changed"]


@pytest.mark.asyncio
async def test_patch_closes_to_stock_by_the_same_rule(committing_client, db_session, shop):
    line = await _received_line(db_session, shop, quantity=2)
    order_url = f"/api/v1/projects/{shop['order'].id}"
    r = await committing_client.patch(order_url, json={"status": "completed"})
    assert (r.status_code, r.json()["detail"]) == (409, "Receive everything the order needs before closing it to stock")
    r = await committing_client.post(f"{order_url}/fulfilment", json={"lines": [{"line_id": line.id, "receive": 2}]})
    assert r.status_code == 200, r.text
    r = await committing_client.patch(order_url, json={"status": "completed"})
    assert r.status_code == 200, r.text
    await db_session.refresh(line)
    assert (line.returned, finished_stock.held_units(line)) == (2, 0)


@pytest.mark.asyncio
async def test_a_closed_to_stock_order_is_not_reactivated(committing_client, db_session, shop):
    line = await _received_line(db_session, shop, quantity=1)
    order_url = f"/api/v1/projects/{shop['order'].id}"
    body = {"lines": [{"line_id": line.id, "receive": 1}], "complete": True}
    assert (await committing_client.post(f"{order_url}/fulfilment", json=body)).status_code == 200
    r = await committing_client.patch(order_url, json={"status": "active"})
    assert (r.status_code, r.json()["detail"]) == (409, "This order's goods went to free stock; duplicate it instead")


@pytest.mark.asyncio
async def test_the_customer_the_patch_ends_with_decides(committing_client, db_session, shop):
    # Review focus 3: one body removes the customer and completes — judged as closing to stock.
    shop["order"].customer_id = shop["acme"].id
    line = await _received_line(db_session, shop, quantity=1)
    order_url = f"/api/v1/projects/{shop['order'].id}"
    r = await committing_client.post(f"{order_url}/fulfilment", json={"lines": [{"line_id": line.id, "receive": 1}]})
    assert r.status_code == 200, r.text
    r = await committing_client.patch(order_url, json={"status": "completed"})
    assert (r.status_code, r.json()["detail"]) == (409, "Issue everything the order holds before completing it")
    r = await committing_client.patch(order_url, json={"status": "completed", "customer_id": None})
    assert r.status_code == 200, r.text
    await db_session.refresh(line)
    assert line.returned == 1


@pytest.mark.asyncio
async def test_a_parts_line_closes_to_the_free_parts_shelf(committing_client, db_session, shop):
    flask = shop["flask"]
    line = await _line(db_session, shop, quantity=1, mode="parts", counts={flask.id: 2})
    await _print(db_session, shop, line, flask=2)
    await db_session.commit()
    free = await _free(db_session, flask)
    body = {"lines": [{"line_id": line.id, "parts": [{"part_id": flask.id, "receive": 2}]}], "complete": True}
    r = await committing_client.post(f"/api/v1/projects/{shop['order'].id}/fulfilment", json=body)
    assert r.status_code == 200, r.text
    assert await _free(db_session, flask) == free + 2
