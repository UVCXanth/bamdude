"""The parts ledger's order doors (spec workshop-order-issue, rules 6, 7, 9)."""

import pytest
from sqlalchemy import func, select

from backend.app.models.customer import Customer
from backend.app.models.part_stock import ProductPartStockMovement
from backend.app.models.product import Product, ProductPart
from backend.app.models.project import Project
from backend.app.models.project_line import ProjectLine
from backend.app.services import finished_stock, line_config, part_stock, stock_issues

pytestmark = pytest.mark.integration


@pytest.fixture
async def shop(db_session):
    """Pipe (flask ×1, cap ×1) with flask 6 · cap 6 on the free shelf; an active order for Acme."""
    pipe = Product(name="Pipe")
    acme = Customer(name="Acme")
    db_session.add_all([pipe, acme])
    await db_session.flush()
    flask = ProductPart(product_id=pipe.id, kind="printed", name="flask", name_key="flask", qty_per_unit=1)
    cap = ProductPart(product_id=pipe.id, kind="printed", name="cap", name_key="cap", qty_per_unit=1)
    db_session.add_all([flask, cap])
    await db_session.flush()
    for part in (flask, cap):
        await part_stock.move(db_session, part_id=part.id, delta=6, reason="manual", note="seed")
    order = Project(name="O", customer_id=acme.id)
    db_session.add(order)
    await db_session.flush()
    await db_session.commit()
    return {"pipe": pipe, "flask": flask, "cap": cap, "order": order, "acme": acme}


async def _line(db, shop, *, mode="product", quantity=3, counts=None):
    line = ProjectLine(project_id=shop["order"].id, product_id=shop["pipe"].id, quantity=quantity, mode=mode)
    db.add(line)
    await db.flush()
    await line_config.seed_line(db, line, choices=None, counts=counts)
    return line


async def _free(db, part):
    return await db.scalar(
        select(func.coalesce(func.sum(ProductPartStockMovement.delta), 0)).where(
            ProductPartStockMovement.product_part_id == part.id
        )
    )


async def _reasons(db, line):
    rows = await db.execute(
        select(ProductPartStockMovement.reason, ProductPartStockMovement.delta)
        .where(ProductPartStockMovement.project_line_id == line.id)
        .order_by(ProductPartStockMovement.id)
    )
    return [tuple(r) for r in rows.all()]


async def _held_by_ledger(db, line, part):
    total = await db.scalar(
        select(func.coalesce(func.sum(ProductPartStockMovement.delta), 0)).where(
            ProductPartStockMovement.project_line_id == line.id,
            ProductPartStockMovement.product_part_id == part.id,
            ProductPartStockMovement.reason.in_(("held_for_order", "hold_released")),
        )
    )
    return -int(total)


@pytest.mark.asyncio
async def test_assembling_reserved_kits_turns_the_reservation_into_a_write_off(db_session, shop):
    line = await _line(db_session, shop)
    assert await part_stock.reserve_for_line(db_session, line, 3) == 3
    position = await finished_stock.item_for(db_session, shop["pipe"].id, {}, create=True)
    free_before = await _free(db_session, shop["flask"])
    await part_stock.convert_reserved_kits(db_session, line, 2, stock_item_id=position.id, created_by=None)
    assert await _free(db_session, shop["flask"]) == free_before  # the reservation already took them
    assert await part_stock.reserved_units_for_line(db_session, line) == 1
    tail = (await _reasons(db_session, line))[-4:]
    assert sorted(tail) == sorted([("reservation_released", 2), ("assembled", -2)] * 2)
    with pytest.raises(part_stock.PartStockError) as refused:
        await part_stock.convert_reserved_kits(db_session, line, 2, stock_item_id=position.id, created_by=None)
    assert str(refused.value) == "Only 1 reserved kits to assemble"


@pytest.mark.asyncio
async def test_a_parts_line_goes_through_the_shelf_without_the_free_balance_seeing_it(db_session, shop):
    flask, cap = shop["flask"], shop["cap"]
    line = await _line(db_session, shop, mode="parts", quantity=1, counts={flask.id: 3, cap.id: 2})
    free = (await _free(db_session, flask), await _free(db_session, cap))
    await part_stock.receive_parts_for_line(db_session, line, {flask.id: 2}, created_by=None)
    assert (await _free(db_session, flask), await _free(db_session, cap)) == free
    assert await part_stock.reserved_units_for_line(db_session, line) == 0  # a parts line takes no kits
    counters = (await part_stock.line_part_stock(db_session, [line.id]))[line.id]
    assert (counters[flask.id].received, counters[flask.id].issued) == (2, 0)
    assert await _held_by_ledger(db_session, line, flask) == 2

    issue = await stock_issues.create(
        db_session,
        customer_id=shop["acme"].id,
        project_id=shop["order"].id,
        recipient=stock_issues.Recipient(),
        waybill=None,
        note=None,
        actor=None,
    )
    await part_stock.issue_parts_for_line(db_session, line, {flask.id: 1}, stock_issue_id=issue.id, created_by=None)
    assert await _free(db_session, flask) == free[0]
    issued = (
        (
            await db_session.execute(
                select(ProductPartStockMovement.stock_issue_id).where(
                    ProductPartStockMovement.reason == "issued_for_order"
                )
            )
        )
        .scalars()
        .all()
    )
    assert issued == [issue.id]
    assert await _held_by_ledger(db_session, line, flask) == 1
    with pytest.raises(part_stock.PartStockError) as refused:
        await part_stock.issue_parts_for_line(db_session, line, {flask.id: 2}, stock_issue_id=issue.id, created_by=None)
    assert str(refused.value) == "Only 1 of flask on the shelf for this order"

    back = await part_stock.return_parts_for_line(db_session, line, created_by=None)
    assert back == {flask.id: 1}
    assert await _free(db_session, flask) == free[0] + 1  # the one left becomes free stock
    counters = (await part_stock.line_part_stock(db_session, [line.id]))[line.id]
    row = counters[flask.id]
    assert (row.received, row.issued, row.returned) == (2, 1, 1)
    assert row.received - row.issued - row.returned == await _held_by_ledger(db_session, line, flask) == 0


@pytest.mark.asyncio
async def test_taking_more_kits_adds_without_releasing(db_session, shop):
    line = await _line(db_session, shop, quantity=5)
    assert await part_stock.reserve_for_line(db_session, line, 2) == 2
    before = len(await _reasons(db_session, line))
    assert await part_stock.add_kits_for_line(db_session, line, 1, created_by=None) == 1
    rows = await _reasons(db_session, line)
    assert [r for r in rows[before:] if r[0] == "reservation_released"] == []
    assert await part_stock.reserved_units_for_line(db_session, line) == 3
    # never past the line's quantity: 5 − 3 reserved leaves room for 2
    assert await part_stock.add_kits_for_line(db_session, line, 9, created_by=None) == 2
