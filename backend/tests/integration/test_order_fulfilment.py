"""An order's goods assembled, received and issued in batches (spec workshop-order-issue, rules 11, 12, 24)."""

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
from backend.app.services import archive_defects, finished_stock, line_config, order_fulfilment, part_stock
from backend.app.services.order_fulfilment import FulfilmentError, LineRequest
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


async def _line(db, shop, *, quantity=10, mode="product", counts=None):
    line = ProjectLine(project_id=shop["order"].id, product_id=shop["pipe"].id, quantity=quantity, mode=mode)
    db.add(line)
    await db.flush()
    await line_config.seed_line(db, line, choices=None, counts=counts)
    await db.refresh(shop["order"], ["lines"])
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
    return archive


async def _acceptance_line(db, shop):
    """The spec's line: 10 ordered — 2 ready off the shelf, 3 kits, 5 printed."""
    line = await _line(db, shop)
    assert await finished_stock.reserve_for_line(db, line, 2) == 2
    assert await part_stock.reserve_for_line(db, line, 3) == 3
    await _print(db, shop, line, flask=5, cap=5)
    return line


async def _apply(db, shop, requests, *, complete=False, waybill=None):
    # A separate request, as in the app: the setup's locks are not the door's (WS-13 E1 BL2).
    await db.commit()
    return await order_fulfilment.apply(
        db,
        shop["order"],
        requests,
        recipient=Recipient(name="Ivan", phone="+380"),
        waybill=waybill,
        note=None,
        complete=complete,
        actor=None,
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
async def test_the_specs_line_goes_out_in_two_issues(db_session, shop):
    line = await _acceptance_line(db_session, shop)
    row = _only(await order_fulfilment.state(db_session, shop["order"]), line)
    assert (row.ordered, row.from_finished, row.kits_reserved, row.can_assemble) == (10, 2, 3, 3)
    assert (row.can_receive, row.held, row.issued) == (5, 2, 0)

    first = await _apply(db_session, shop, [LineRequest(line.id, assemble=3, receive=5, issue=4)], waybill="TTN-1")
    assert (first.project_id, first.customer_id, first.waybill, first.recipient_name) == (
        shop["order"].id,
        shop["acme"].id,
        "TTN-1",
        "Ivan",
    )
    state = await order_fulfilment.state(db_session, shop["order"])
    row = _only(state, line)
    assert (row.can_assemble, row.can_receive, row.held, row.issued) == (0, 0, 6, 4)
    assert (state.ordered, state.issued, state.held, state.fully_issued) == (10, 4, 6, False)
    assert finished_stock.held_units(line) == await _held_by_ledger(db_session, line) == 6
    out = await db_session.scalar(
        select(func.sum(StockItemMovement.delta_on_hand)).where(StockItemMovement.stock_issue_id == first.id)
    )
    assert out == -4

    second = await _apply(db_session, shop, [LineRequest(line.id, issue=6)], complete=True)
    assert second is not None and second.id != first.id
    assert shop["order"].status == "completed"
    issues = (await db_session.execute(select(StockIssue).order_by(StockIssue.id))).scalars().all()
    assert [(i.customer_id, i.project_id) for i in issues] == [(shop["acme"].id, shop["order"].id)] * 2
    assert (line.issued, finished_stock.held_units(line), await _held_by_ledger(db_session, line)) == (10, 0, 0)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("request_", "sentence"),
    [
        ({"assemble": 4}, "«Pipe»: only 3 can be assembled"),
        ({"receive": 6}, "«Pipe»: only 5 can be received"),
        ({"issue": 3}, "«Pipe»: only 2 can be issued"),
        ({"assemble": 1, "receive": 2, "issue": 6}, "«Pipe»: only 5 can be issued"),
    ],
)
async def test_a_number_above_what_is_possible_is_refused_and_writes_nothing(db_session, shop, request_, sentence):
    line = await _acceptance_line(db_session, shop)
    before = await _written(db_session)
    with pytest.raises(FulfilmentError) as refused:
        await _apply(db_session, shop, [LineRequest(line.id, **request_)])
    assert (refused.value.status, str(refused.value)) == (409, sentence)
    assert await _written(db_session) == before


@pytest.mark.asyncio
async def test_nothing_asked_is_nothing_to_do(db_session, shop):
    line = await _acceptance_line(db_session, shop)
    with pytest.raises(FulfilmentError) as refused:
        await _apply(db_session, shop, [LineRequest(line.id)])
    assert (refused.value.status, str(refused.value)) == (422, "Nothing to do")


@pytest.mark.asyncio
async def test_completing_before_everything_is_issued_is_refused_and_writes_nothing(db_session, shop):
    line = await _acceptance_line(db_session, shop)
    before = await _written(db_session)
    with pytest.raises(FulfilmentError) as refused:
        await _apply(db_session, shop, [LineRequest(line.id, assemble=3, receive=5, issue=9)], complete=True)
    assert (refused.value.status, str(refused.value)) == (409, "Issue everything the order holds before completing it")
    assert await _written(db_session) == before
    assert shop["order"].status == "active"


@pytest.mark.asyncio
async def test_an_issue_needs_the_orders_customer(db_session, shop):
    line = await _acceptance_line(db_session, shop)
    shop["order"].customer_id = None
    before = await _written(db_session)
    with pytest.raises(FulfilmentError) as refused:
        await _apply(db_session, shop, [LineRequest(line.id, issue=1)])
    assert (refused.value.status, str(refused.value)) == (
        409,
        "An issue names its customer — set the order's customer first",
    )
    assert await _written(db_session) == before


@pytest.mark.asyncio
async def test_only_an_active_order_is_fulfilled(db_session, shop):
    line = await _acceptance_line(db_session, shop)
    shop["order"].status = "cancelled"
    with pytest.raises(FulfilmentError) as refused:
        await _apply(db_session, shop, [LineRequest(line.id, issue=1)])
    assert (refused.value.status, str(refused.value)) == (409, "Only an active order can be fulfilled")


@pytest.mark.asyncio
async def test_receiving_without_issuing_opens_no_issue(db_session, shop):
    line = await _acceptance_line(db_session, shop)
    assert await _apply(db_session, shop, [LineRequest(line.id, receive=5)]) is None
    assert await db_session.scalar(select(func.count()).select_from(StockIssue)) == 0
    assert (line.received, finished_stock.held_units(line)) == (5, 7)


@pytest.mark.asyncio
async def test_a_parts_line_is_received_and_issued_part_by_part(db_session, shop):
    flask, cap = shop["flask"], shop["cap"]
    line = await _line(db_session, shop, quantity=1, mode="parts", counts={flask.id: 3, cap.id: 2})
    await _print(db_session, shop, line, flask=3, cap=1)
    free = (await _free(db_session, flask), await _free(db_session, cap))
    row = _only(await order_fulfilment.state(db_session, shop["order"]), line)
    parts = {p.name: (p.wanted, p.can_receive, p.held, p.issued) for p in row.parts}
    assert parts == {"flask": (3, 3, 0, 0), "cap": (2, 1, 0, 0)}
    assert (row.ordered, row.can_assemble, row.can_receive) == (5, 0, 0)

    with pytest.raises(FulfilmentError) as refused:
        await _apply(db_session, shop, [LineRequest(line.id, parts={cap.id: (2, 0)})])
    assert str(refused.value) == "«Pipe», cap: only 1 can be received"

    issue = await _apply(db_session, shop, [LineRequest(line.id, parts={flask.id: (3, 2), cap.id: (1, 1)})])
    assert issue is not None
    state = await order_fulfilment.state(db_session, shop["order"])
    row = _only(state, line)
    parts = {p.name: (p.can_receive, p.held, p.issued) for p in row.parts}
    assert parts == {"flask": (0, 1, 2), "cap": (0, 0, 1)}
    assert (row.held, row.issued, state.fully_issued) == (1, 3, False)
    assert (await _free(db_session, flask), await _free(db_session, cap)) == free  # the free shelf never saw them

    with pytest.raises(FulfilmentError) as refused:
        await _apply(db_session, shop, [LineRequest(line.id, parts={flask.id: (0, 1)})], complete=True)
    assert str(refused.value) == "Issue everything the order holds before completing it"


@pytest.mark.asyncio
async def test_defects_recorded_after_a_receipt_leave_nothing_more_to_receive(db_session, shop):
    line = await _line(db_session, shop, quantity=5)
    archive = await _print(db_session, shop, line, flask=5, cap=5)
    await _apply(db_session, shop, [LineRequest(line.id, receive=5)])
    rows = (
        (await db_session.execute(select(PrintArchivePart).where(PrintArchivePart.archive_id == archive.id)))
        .scalars()
        .all()
    )
    await archive_defects.record_defects(
        db_session, archive, archive_defects.DefectsWrite(parts=tuple((r.id, 2) for r in rows))
    )
    row = _only(await order_fulfilment.state(db_session, shop["order"]), line)
    assert (row.can_receive, row.held) == (0, 5)


@pytest.mark.asyncio
async def test_completion_gives_the_unassembled_kits_back(db_session, shop):
    # Over-covered, as WS-10 allows: 2 ready units and 3 kits for 3 ordered.
    line = await _line(db_session, shop, quantity=3)
    assert await finished_stock.reserve_for_line(db_session, line, 2) == 2
    assert await part_stock.reserve_for_line(db_session, line, 3) == 3
    assert await _free(db_session, shop["flask"]) == 0
    await _apply(db_session, shop, [LineRequest(line.id, assemble=1, issue=3)], complete=True)
    assert shop["order"].status == "completed"
    assert await part_stock.reserved_units_for_line(db_session, line) == 0
    assert await _free(db_session, shop["flask"]) == 2  # the two kits nobody assembled went back
    notes = (
        await db_session.execute(
            select(ProductPartStockMovement.note).where(ProductPartStockMovement.reason == "reservation_released")
        )
    ).scalars()
    assert set(notes) >= {part_stock.NOTE_ORDER_COMPLETED}


@pytest.mark.asyncio
async def test_the_journal_says_what_happened(db_session, shop):
    line = await _acceptance_line(db_session, shop)
    issue = await _apply(db_session, shop, [LineRequest(line.id, assemble=3, receive=5, issue=10)], complete=True)
    events = (await db_session.execute(select(ProjectEvent).order_by(ProjectEvent.id))).scalars().all()
    assert [(e.kind, e.payload) for e in events] == [
        ("kits_assembled", {"line_id": line.id, "product": "Pipe", "units": 3}),
        ("goods_received", {"line_id": line.id, "product": "Pipe", "units": 5}),
        ("goods_issued", {"issue_id": issue.id, "units": 10, "waybill": None}),
        ("status_changed", {"from": "active", "to": "completed"}),
    ]


@pytest.mark.asyncio
async def test_a_line_of_another_order_is_not_found(db_session, shop):
    stranger = Project(name="X")
    db_session.add(stranger)
    await db_session.flush()
    line = ProjectLine(project_id=stranger.id, product_id=shop["pipe"].id, quantity=1)
    db_session.add(line)
    await db_session.flush()
    with pytest.raises(FulfilmentError) as refused:
        await _apply(db_session, shop, [LineRequest(line.id, issue=1)])
    assert (refused.value.status, str(refused.value)) == (404, "Order line not found")
