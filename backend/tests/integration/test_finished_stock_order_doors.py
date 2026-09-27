"""The finished-goods ledger's order doors (spec workshop-order-issue, rules 5, 7, 8)."""

import pytest
from sqlalchemy import func, select

from backend.app.models.customer import Customer
from backend.app.models.finished_stock import StockItem, StockItemMovement
from backend.app.models.product import Product, ProductOrigin, ProductPart
from backend.app.models.project import Project
from backend.app.models.project_line import ProjectLine
from backend.app.services import finished_stock, line_config, part_stock, stock_issues

pytestmark = pytest.mark.integration


@pytest.fixture
async def shop(db_session):
    """Pipe (flask ×1) with 6 flasks on the free shelf; an active order for Acme."""
    pipe = Product(name="Pipe")
    acme = Customer(name="Acme")
    db_session.add_all([pipe, acme])
    await db_session.flush()
    flask = ProductPart(product_id=pipe.id, kind="printed", name="flask", name_key="flask", qty_per_unit=1)
    db_session.add(flask)
    await db_session.flush()
    await part_stock.move(db_session, part_id=flask.id, delta=6, reason="manual", note="seed")
    order = Project(name="O", customer_id=acme.id)
    db_session.add(order)
    await db_session.commit()
    return {"pipe": pipe, "flask": flask, "order": order, "acme": acme}


async def _line(db, shop, quantity=10, product=None):
    line = ProjectLine(project_id=shop["order"].id, product_id=(product or shop["pipe"]).id, quantity=quantity)
    db.add(line)
    await db.flush()
    await line_config.seed_line(db, line, choices=None, counts=None)
    return line


async def _held_by_ledger(db, line):
    total = await db.scalar(
        select(func.coalesce(func.sum(StockItemMovement.delta_reserved), 0)).where(
            StockItemMovement.project_line_id == line.id
        )
    )
    return int(total)


async def _position(db, shop):
    return (
        await db.execute(
            select(StockItem).where(StockItem.product_id == shop["pipe"].id).execution_options(populate_existing=True)
        )
    ).scalar_one()


async def _issue(db, shop):
    return await stock_issues.create(
        db,
        customer_id=shop["acme"].id,
        project_id=shop["order"].id,
        recipient=stock_issues.Recipient(),
        waybill=None,
        note=None,
        actor=None,
    )


@pytest.mark.asyncio
async def test_received_units_go_on_the_shelf_reserved_for_the_order(db_session, shop):
    line = await _line(db_session, shop)
    await finished_stock.produce_for_line(db_session, line, 3, actor=None)
    move = (await db_session.execute(select(StockItemMovement))).scalar_one()
    assert (move.kind, move.delta_on_hand, move.delta_reserved) == ("produced", 3, 3)
    assert (move.project_id, move.project_line_id) == (shop["order"].id, line.id)
    assert line.received == 3 and finished_stock.moved(line)
    position = await _position(db_session, shop)
    assert (position.on_hand, position.reserved) == (3, 3)
    assert finished_stock.held_units(line) == await _held_by_ledger(db_session, line) == 3


@pytest.mark.asyncio
async def test_assembling_reserved_kits_makes_units_for_the_order(db_session, shop):
    line = await _line(db_session, shop)
    assert await part_stock.reserve_for_line(db_session, line, 2) == 2
    await finished_stock.assemble_for_line(db_session, line, 2, actor=None)
    position = await _position(db_session, shop)  # created in the line's configuration
    assert (position.on_hand, position.reserved, line.assembled) == (2, 2, 2)
    assert await part_stock.reserved_units_for_line(db_session, line) == 0
    assert finished_stock.held_units(line) == await _held_by_ledger(db_session, line) == 2


@pytest.mark.asyncio
async def test_issuing_hands_over_part_of_what_the_line_holds(db_session, shop):
    line = await _line(db_session, shop)
    await finished_stock.produce_for_line(db_session, line, 5, actor=None)
    issue = await _issue(db_session, shop)
    await finished_stock.issue_from_line(db_session, line, 4, stock_issue=issue, actor=None)
    out = (await db_session.execute(select(StockItemMovement).where(StockItemMovement.kind == "issue"))).scalar_one()
    assert (out.delta_on_hand, out.delta_reserved, out.stock_issue_id, out.customer_id) == (
        -4,
        -4,
        issue.id,
        shop["acme"].id,
    )
    assert (line.issued, finished_stock.held_units(line)) == (4, 1)
    assert await _held_by_ledger(db_session, line) == 1
    with pytest.raises(finished_stock.FinishedStockError) as refused:
        await finished_stock.issue_from_line(db_session, line, 2, stock_issue=issue, actor=None)
    assert str(refused.value) == "Only 1 held for this order"


@pytest.mark.asyncio
async def test_giving_back_an_unmoved_line_is_the_ws10_release(db_session, shop):
    line = await _line(db_session, shop, quantity=4)
    position = await finished_stock.item_for(db_session, shop["pipe"].id, {}, create=True)
    await finished_stock.receive(db_session, position, 3)
    assert await finished_stock.reserve_for_line(db_session, line, 3) == 3
    assert await finished_stock.give_back_for_line(db_session, line, actor=None) == 3
    assert (line.from_finished, line.returned) == (0, 0)
    assert (await _position(db_session, shop)).reserved == 0


@pytest.mark.asyncio
async def test_giving_back_a_moved_line_counts_what_went_back(db_session, shop):
    line = await _line(db_session, shop)
    await finished_stock.produce_for_line(db_session, line, 5, actor=None)
    await finished_stock.issue_from_line(db_session, line, 2, stock_issue=await _issue(db_session, shop), actor=None)
    assert await finished_stock.give_back_for_line(db_session, line, actor=None) == 3
    assert (line.received, line.issued, line.returned) == (5, 2, 3)
    position = await _position(db_session, shop)
    assert (position.on_hand, position.reserved) == (3, 0)  # free stock now
    assert finished_stock.held_units(line) == await _held_by_ledger(db_session, line) == 0


@pytest.mark.asyncio
async def test_taking_from_stock_only_adds(db_session, shop):
    line = await _line(db_session, shop, quantity=6)
    position = await finished_stock.item_for(db_session, shop["pipe"].id, {}, create=True)
    await finished_stock.receive(db_session, position, 5)
    assert await finished_stock.reserve_for_line(db_session, line, 2) == 2
    await finished_stock.produce_for_line(db_session, line, 1, actor=None)
    assert await finished_stock.take_for_line(db_session, line, 2, actor=None) == 2
    kinds = [k for (k,) in (await db_session.execute(select(StockItemMovement.kind).order_by(StockItemMovement.id)))]
    assert "release" not in kinds
    assert (line.from_finished, finished_stock.held_units(line)) == (4, 5)
    assert await _held_by_ledger(db_session, line) == 5


@pytest.mark.asyncio
async def test_a_one_off_products_line_has_a_position_too(db_session, shop):
    plate = Product(name="Plate 1 of flask.3mf", origin=ProductOrigin.ADHOC_PLATE.value)
    db_session.add(plate)
    await db_session.flush()
    db_session.add(ProductPart(product_id=plate.id, kind="printed", name="flask", name_key="flask", qty_per_unit=1))
    await db_session.flush()
    line = await _line(db_session, shop, quantity=2, product=plate)
    await finished_stock.produce_for_line(db_session, line, 2, actor=None)
    assert line.received == 2 and finished_stock.held_units(line) == 2
    with pytest.raises(finished_stock.FinishedStockError):
        await finished_stock.item_for(db_session, plate.id, {}, create=True)  # manual stock stays catalogue-only
