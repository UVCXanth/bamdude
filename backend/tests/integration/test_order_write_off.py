"""A unit held for an order written off — broken on the shelf — and made again
(spec workshop-order-issue-followups, rules 44–48)."""

import pytest
from sqlalchemy import func, select

from backend.app.models.archive import PrintArchive
from backend.app.models.archive_part import PrintArchivePart
from backend.app.models.customer import Customer
from backend.app.models.finished_stock import StockItemMovement
from backend.app.models.part_stock import ProductPartStockMovement
from backend.app.models.product import Product, ProductPart
from backend.app.models.project import Project, ProjectEvent
from backend.app.models.project_line import ProjectLine
from backend.app.models.stock_issue import StockIssue
from backend.app.services import finished_stock, line_config, order_fulfilment, part_stock
from backend.app.services.order_fulfilment import FulfilmentError, LineRequest
from backend.app.services.order_metrics import attribute, load_order_context
from backend.app.services.stock_issues import Recipient

pytestmark = pytest.mark.integration


@pytest.fixture
async def shop(db_session):
    """Pipe (flask ×1, cap ×1): 3 of each on the free shelf, 2 ready pipes; an active order for Acme."""
    pipe = Product(name="Pipe")
    acme = Customer(name="Acme")
    db_session.add_all([pipe, acme])
    await db_session.flush()
    flask = ProductPart(product_id=pipe.id, kind="printed", name="flask", name_key="flask", qty_per_unit=1)
    cap = ProductPart(product_id=pipe.id, kind="printed", name="cap", name_key="cap", qty_per_unit=1)
    db_session.add_all([flask, cap])
    await db_session.flush()
    for part in (flask, cap):
        await part_stock.move(db_session, part_id=part.id, delta=3, reason="manual", note="seed")
    position = await finished_stock.item_for(db_session, pipe.id, {}, create=True)
    await finished_stock.receive(db_session, position, 2)
    order = Project(name="O", customer_id=acme.id)
    db_session.add(order)
    await db_session.commit()
    return {"pipe": pipe, "flask": flask, "cap": cap, "order": order, "acme": acme}


async def _line(db, shop, *, quantity=10, mode="product", counts=None, order=None):
    order = order or shop["order"]
    line = ProjectLine(project_id=order.id, product_id=shop["pipe"].id, quantity=quantity, mode=mode)
    db.add(line)
    await db.flush()
    await line_config.seed_line(db, line, choices=None, counts=counts)
    await db.refresh(order, ["lines"])
    return line


async def _print(db, shop, line, **parts):
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
    return archive


async def _apply(db, shop, requests, *, complete=False, write_off_note=None):
    # A separate request, as in the app: the setup's locks are not the door's (WS-13 E1 BL2).
    await db.commit()
    return await order_fulfilment.apply(
        db,
        shop["order"],
        requests,
        recipient=Recipient(name="Ivan", phone="+380"),
        waybill=None,
        note=None,
        complete=complete,
        actor=None,
        write_off_note=write_off_note,
    )


async def _written(db):
    """Rows in every book the function writes."""
    counts = []
    for model in (StockItemMovement, ProductPartStockMovement, StockIssue, ProjectEvent):
        counts.append(await db.scalar(select(func.count()).select_from(model)))
    return tuple(counts)


async def _held_by_ledger(db, line):
    total = await db.scalar(
        select(func.coalesce(func.sum(StockItemMovement.delta_reserved), 0)).where(
            StockItemMovement.project_line_id == line.id
        )
    )
    return int(total)


async def _free(db, part):
    return await db.scalar(
        select(func.coalesce(func.sum(ProductPartStockMovement.delta), 0)).where(
            ProductPartStockMovement.product_part_id == part.id
        )
    )


def _only(state, line):
    [found] = [row for row in state.lines if row.line_id == line.id]
    return found


@pytest.mark.asyncio
async def test_a_broken_unit_is_written_off_and_made_again(db_session, shop):
    line = await _line(db_session, shop, quantity=5)
    await _print(db_session, shop, line, flask=5, cap=5)
    await _apply(db_session, shop, [LineRequest(line.id, receive=5)])
    position = await finished_stock.position_for_line(db_session, line, create=False)
    on_hand = position.on_hand

    await _apply(db_session, shop, [LineRequest(line.id, write_off=1)], write_off_note="dropped")
    await db_session.refresh(position)
    assert (line.written_off, finished_stock.held_units(line)) == (1, 4)
    assert finished_stock.held_units(line) == await _held_by_ledger(db_session, line)
    assert position.on_hand == on_hand - 1
    move = (
        await db_session.execute(select(StockItemMovement).where(StockItemMovement.kind == "written_off"))
    ).scalar_one()
    assert (move.delta_on_hand, move.delta_reserved, move.note) == (-1, -1, "dropped")

    ctx = await load_order_context(db_session, shop["order"].id)
    figs = attribute(ctx)[0][line.id]
    assert [p.remaining for p in figs.parts] == [1, 1]  # one more to print
    assert figs.covered_units == 4
    await _print(db_session, shop, line, flask=1, cap=1)
    ctx = await load_order_context(db_session, shop["order"].id)
    figs = attribute(ctx)[0][line.id]
    assert [(p.remaining, p.surplus) for p in figs.parts] == [(0, 0), (0, 0)]  # the replacement is not surplus
    row = _only(await order_fulfilment.state(db_session, shop["order"]), line)
    assert (row.can_receive, row.held, row.written_off) == (1, 4, 1)


@pytest.mark.asyncio
async def test_a_write_off_needs_a_note_and_stays_within_what_is_held(db_session, shop):
    line = await _line(db_session, shop, quantity=5)
    await _print(db_session, shop, line, flask=2, cap=2)
    await _apply(db_session, shop, [LineRequest(line.id, receive=2)])
    before = await _written(db_session)
    with pytest.raises(FulfilmentError) as refused:
        await _apply(db_session, shop, [LineRequest(line.id, write_off=1)])
    assert (refused.value.status, str(refused.value)) == (422, "A write-off needs a note")
    with pytest.raises(FulfilmentError) as refused:
        await _apply(db_session, shop, [LineRequest(line.id, write_off=3)], write_off_note="x")
    assert (refused.value.status, str(refused.value)) == (409, "«Pipe»: only 2 can be written off")
    with pytest.raises(FulfilmentError) as refused:
        await _apply(db_session, shop, [LineRequest(line.id, write_off=1, issue=2)], write_off_note="x")
    assert str(refused.value) == "«Pipe»: only 1 can be issued"
    assert await _written(db_session) == before


@pytest.mark.asyncio
async def test_a_write_off_touches_only_this_orders_hold_on_a_shared_position(db_session, shop):
    # Review focus 1: another order holds units of the same position.
    other = Project(name="P", customer_id=shop["acme"].id)
    db_session.add(other)
    await db_session.flush()
    theirs = await _line(db_session, shop, quantity=2, order=other)
    assert await finished_stock.reserve_for_line(db_session, theirs, 2) == 2
    line = await _line(db_session, shop, quantity=3)
    await _print(db_session, shop, line, flask=3, cap=3)
    await _apply(db_session, shop, [LineRequest(line.id, receive=3)])
    await _apply(db_session, shop, [LineRequest(line.id, write_off=2)], write_off_note="cracked")
    assert (finished_stock.held_units(line), finished_stock.held_units(theirs)) == (1, 2)
    assert finished_stock.held_units(theirs) == await _held_by_ledger(db_session, theirs)
    assert finished_stock.held_units(line) == await _held_by_ledger(db_session, line)


@pytest.mark.asyncio
async def test_cancel_after_a_write_off_gives_back_only_what_is_held(committing_client, db_session, shop):
    # Review focus 2.
    line = await _line(db_session, shop, quantity=4)
    await _print(db_session, shop, line, flask=4, cap=4)
    await _apply(db_session, shop, [LineRequest(line.id, receive=4)])
    await _apply(db_session, shop, [LineRequest(line.id, write_off=1)], write_off_note="x")
    await db_session.commit()
    r = await committing_client.patch(f"/api/v1/projects/{shop['order'].id}", json={"status": "cancelled"})
    assert r.status_code == 200, r.text
    await db_session.refresh(line)
    assert (line.returned, line.written_off, finished_stock.held_units(line)) == (3, 1, 0)
    assert await _held_by_ledger(db_session, line) == 0


@pytest.mark.asyncio
async def test_a_parts_line_writes_off_part_by_part(db_session, shop):
    flask = shop["flask"]
    line = await _line(db_session, shop, quantity=1, mode="parts", counts={flask.id: 3})
    await _print(db_session, shop, line, flask=3)
    free = await _free(db_session, flask)
    await _apply(db_session, shop, [LineRequest(line.id, parts={flask.id: (3, 0)})])
    await _apply(db_session, shop, [LineRequest(line.id, parts_write_off={flask.id: 1})], write_off_note="warped")
    row = _only(await order_fulfilment.state(db_session, shop["order"]), line)
    [part] = row.parts
    assert (part.held, part.written_off, part.can_receive) == (2, 1, 0)
    assert await _free(db_session, flask) == free  # the free shelf never saw it
    reasons = (
        await db_session.execute(
            select(ProductPartStockMovement.reason, ProductPartStockMovement.delta).where(
                ProductPartStockMovement.product_part_id == flask.id,
                ProductPartStockMovement.reason.in_(("hold_released", "written_off_for_order")),
            )
        )
    ).all()
    assert sorted(reasons) == [("hold_released", 1), ("written_off_for_order", -1)]
    await _print(db_session, shop, line, flask=1)
    row = _only(await order_fulfilment.state(db_session, shop["order"]), line)
    assert row.parts[0].can_receive == 1


@pytest.mark.asyncio
async def test_the_journal_says_what_was_written_off(db_session, shop):
    line = await _line(db_session, shop, quantity=2)
    await _print(db_session, shop, line, flask=2, cap=2)
    await _apply(db_session, shop, [LineRequest(line.id, receive=2, write_off=1)], write_off_note="dropped")
    events = (await db_session.execute(select(ProjectEvent).order_by(ProjectEvent.id))).scalars().all()
    assert [(e.kind, e.payload) for e in events] == [
        ("goods_received", {"line_id": line.id, "product": "Pipe", "units": 2}),
        ("goods_written_off", {"line_id": line.id, "product": "Pipe", "units": 1, "note": "dropped"}),
    ]


@pytest.mark.asyncio
async def test_the_window_sends_write_offs_and_their_note(committing_client, db_session, shop):
    line = await _line(db_session, shop, quantity=2)
    await _print(db_session, shop, line, flask=2, cap=2)
    await db_session.commit()
    url = f"/api/v1/projects/{shop['order'].id}/fulfilment"
    body = {"lines": [{"line_id": line.id, "receive": 2, "write_off": 1}]}
    r = await committing_client.post(url, json=body)
    assert (r.status_code, r.json()["detail"]) == (422, "A write-off needs a note")
    r = await committing_client.post(url, json={**body, "write_off_note": "dropped"})
    assert r.status_code == 200, r.text
    state = (await committing_client.get(url)).json()
    assert (state["lines"][0]["held"], state["lines"][0]["written_off"]) == (1, 1)
    detail = (await committing_client.get(f"/api/v1/projects/{shop['order'].id}")).json()
    assert detail["lines"][0]["written_off"] == 1
