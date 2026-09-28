"""The final review of WS-11a (spec workshop-order-issue-followups) — one test per finding."""

import pytest

from backend.app.models.archive import PrintArchive
from backend.app.models.archive_part import PrintArchivePart
from backend.app.models.customer import Customer
from backend.app.models.finished_stock import StockItem
from backend.app.models.product import Product, ProductPart
from backend.app.models.project import Project
from backend.app.models.project_line import ProjectLine
from backend.app.services import finished_stock, line_config, order_fulfilment, part_stock
from backend.app.services.order_fulfilment import FulfilmentError, LineRequest
from backend.app.services.stock_issues import Recipient

pytestmark = pytest.mark.integration


@pytest.fixture
async def shop(db_session):
    """Pipe (flask ×1, cap ×1, a zero «handle» out of the kit, a marked «cube»): 5 of each
    kit part free, 2 ready pipes; an order for Acme and one without a customer."""
    pipe = Product(name="Pipe")
    acme = Customer(name="Acme")
    db_session.add_all([pipe, acme])
    await db_session.flush()
    flask = ProductPart(product_id=pipe.id, kind="printed", name="flask", name_key="flask", qty_per_unit=1)
    cap = ProductPart(product_id=pipe.id, kind="printed", name="cap", name_key="cap", qty_per_unit=1)
    handle = ProductPart(product_id=pipe.id, kind="printed", name="handle", name_key="handle", qty_per_unit=0)
    cube = ProductPart(product_id=pipe.id, kind="printed", name="cube", name_key="cube", qty_per_unit=0, ignored=True)
    screw = ProductPart(product_id=pipe.id, kind="purchased", name="screw", name_key="purchased:screw", qty_per_unit=0)
    db_session.add_all([flask, cap, handle, cube, screw])
    await db_session.flush()
    for part in (flask, cap):
        await part_stock.move(db_session, part_id=part.id, delta=5, reason="manual", note="seed")
    position = await finished_stock.item_for(db_session, pipe.id, {}, create=True)
    await finished_stock.receive(db_session, position, 2)
    order = Project(name="O", customer_id=acme.id)
    stock_order = Project(name="S")
    db_session.add_all([order, stock_order])
    await db_session.commit()
    return {
        "pipe": pipe,
        "flask": flask,
        "cap": cap,
        "handle": handle,
        "cube": cube,
        "screw": screw,
        "order": order,
        "stock_order": stock_order,
        "position": position,
    }


async def _line(db, shop, order, *, quantity=4, mode="product", counts=None):
    line = ProjectLine(project_id=order.id, product_id=shop["pipe"].id, quantity=quantity, mode=mode)
    db.add(line)
    await db.flush()
    await line_config.seed_line(db, line, choices=None, counts=counts)
    return line


async def _print(db, line, **parts):
    archive = PrintArchive(
        project_id=line.project_id,
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


async def _apply(db, order, requests, *, complete=False, write_off_note=None):
    return await order_fulfilment.apply(
        db,
        order,
        requests,
        recipient=Recipient(name="Ivan"),
        waybill=None,
        note=None,
        complete=complete,
        actor=None,
        write_off_note=write_off_note,
    )


@pytest.mark.asyncio
async def test_a_line_edit_after_a_write_off_keeps_its_kits(committing_client, db_session, shop):
    # I1: the kits the line holds are fitted under what the line still needs — a written-off
    # unit is needed again, so its replacement does not squeeze a kit off the line.
    order = shop["order"]
    line = await _line(db_session, shop, order)
    assert await part_stock.reserve_for_line(db_session, line, 2) == 2
    await _print(db_session, line, flask=2, cap=2)
    await _apply(db_session, order, [LineRequest(line.id, receive=2)])
    await _apply(db_session, order, [LineRequest(line.id, write_off=1)], write_off_note="dropped")
    await _print(db_session, line, flask=1, cap=1)
    await _apply(db_session, order, [LineRequest(line.id, receive=1)])
    await db_session.commit()
    r = await committing_client.patch(f"/api/v1/projects/{order.id}/lines/{line.id}", json={"note": "blue"})
    assert r.status_code == 200, r.text
    line = await db_session.get(ProjectLine, line.id, populate_existing=True)
    assert await part_stock.reserved_units_for_line(db_session, line) == 2


@pytest.mark.asyncio
async def test_a_bought_part_cannot_be_marked_not_counted(committing_client, shop):
    # I3: «не рахувати» is for objects on a plate — a bought part is never on one.
    base = f"/api/v1/products/{shop['pipe'].id}/parts"
    r = await committing_client.patch(f"{base}/{shop['screw'].id}", json={"ignored": True})
    assert (r.status_code, r.json()["detail"]) == (422, "Only a printed part can be marked as not counted")
    r = await committing_client.post(
        base, json={"kind": "purchased", "name": "nut", "qty_per_unit": 0, "ignored": True}
    )
    assert (r.status_code, r.json()["detail"]) == (422, "Only a printed part can be marked as not counted")


@pytest.mark.asyncio
async def test_closing_to_stock_checks_again_under_the_locks(db_session, shop):
    # M4: the PATCH door reads the state before its locks; close() reads it again after them.
    order = shop["stock_order"]
    line = await _line(db_session, shop, order, quantity=2)
    await _print(db_session, line, flask=2, cap=2)
    await _apply(db_session, order, [LineRequest(line.id, receive=1)])
    with pytest.raises(FulfilmentError) as refused:
        await order_fulfilment.close(db_session, order, [line], to_stock=True, actor=None)
    assert (refused.value.status, str(refused.value)) == (
        409,
        "Receive everything the order needs before closing it to stock",
    )


@pytest.mark.asyncio
async def test_a_line_of_ready_units_closed_to_stock_keeps_its_history(committing_client, db_session, shop):
    # M5: rule 37 — returned += held, whatever the line's stock did before.
    order = shop["stock_order"]
    line = await _line(db_session, shop, order, quantity=2)
    assert await finished_stock.reserve_for_line(db_session, line, 2) == 2
    await db_session.commit()
    url = f"/api/v1/projects/{order.id}"
    r = await committing_client.post(f"{url}/fulfilment", json={"lines": [], "complete": True})
    assert r.status_code == 200, r.text
    line = await db_session.get(ProjectLine, line.id, populate_existing=True)
    assert (line.from_finished, line.returned, finished_stock.held_units(line)) == (2, 2, 0)
    position = await db_session.get(StockItem, shop["position"].id, populate_existing=True)
    assert (position.on_hand, position.reserved) == (2, 0)
    r = await committing_client.patch(url, json={"status": "active"})
    assert (r.status_code, r.json()["detail"]) == (409, "This order's goods went to free stock; duplicate it instead")


@pytest.mark.asyncio
async def test_an_ordered_part_is_not_merged_into_a_marked_one(committing_client, db_session, shop):
    # M6: the merge would make a line want a part marked «не рахувати».
    line = await _line(db_session, shop, shop["order"], quantity=1, mode="parts", counts={shop["handle"].id: 2})
    assert line.id
    await db_session.commit()
    r = await committing_client.post(
        f"/api/v1/products/{shop['pipe'].id}/parts/{shop['cube'].id}/merge",
        json={"source_part_id": shop["handle"].id},
    )
    assert (r.status_code, r.json()["detail"]) == (
        409,
        "A part that is ordered cannot be merged into one marked as not counted",
    )


@pytest.mark.asyncio
async def test_a_part_reserved_in_kits_cannot_be_marked(committing_client, db_session, shop):
    # M7: kits reserved for a line hold the part even when the free balance reads zero.
    flask = shop["flask"]
    line = await _line(db_session, shop, shop["order"], quantity=5)
    assert await part_stock.reserve_for_line(db_session, line, 5) == 5
    await db_session.commit()
    url = f"/api/v1/products/{shop['pipe'].id}/parts/{flask.id}"
    assert (await committing_client.patch(url, json={"qty_per_unit": 0})).status_code == 200
    r = await committing_client.patch(url, json={"ignored": True})
    assert (r.status_code, r.json()["detail"]) == (
        409,
        "This part holds stock or is ordered; it cannot be marked as not counted",
    )
