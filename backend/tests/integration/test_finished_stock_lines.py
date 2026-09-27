"""Finished goods under order lines (spec workshop-add-to-order, rules 1–9)."""

import pytest
from sqlalchemy import select

from backend.app.models.customer import Customer
from backend.app.models.finished_stock import StockItemMovement
from backend.app.models.product import Product, ProductPart
from backend.app.models.product_variant import ProductVariantGroup, ProductVariantOption
from backend.app.models.project import Project
from backend.app.models.project_line import ProjectLine
from backend.app.services import finished_stock, line_config, stock_issues

pytestmark = pytest.mark.integration


async def _line(db, product, quantity, choices=None):
    order = Project(name="O")
    db.add(order)
    await db.flush()
    line = ProjectLine(project_id=order.id, product_id=product.id, quantity=quantity)
    db.add(line)
    await db.flush()
    await line_config.seed_line(db, line, choices=choices, counts=None)
    return order, line


@pytest.fixture
async def shelf(db_session):
    """Lamp (no variants): a position with 5 on hand; an active order with a line of 4."""
    lamp = Product(name="Lamp")
    db_session.add(lamp)
    await db_session.flush()
    item = await finished_stock.item_for(db_session, lamp.id, {}, create=True)
    await finished_stock.receive(db_session, item, 5)
    order, line = await _line(db_session, lamp, 4)
    await db_session.commit()
    return {"lamp": lamp, "item": item, "order": order, "line": line}


@pytest.mark.asyncio
async def test_a_movement_under_a_line_names_it_and_moves_its_column(db_session, shelf):
    move = await finished_stock._record(
        db_session, shelf["item"], "reserve", 0, 2, note=None, line=shelf["line"], d_line=2
    )
    assert (move.project_id, move.project_line_id) == (shelf["order"].id, shelf["line"].id)
    assert shelf["line"].from_finished == 2
    assert shelf["item"].reserved == 2
    rows = (await db_session.execute(select(StockItemMovement.project_line_id))).scalars().all()
    assert shelf["line"].id in rows


@pytest.fixture
async def customer(db_session):
    row = Customer(name="Acme")
    db_session.add(row)
    await db_session.commit()
    return row


async def _issue(db, shelf, customer):
    return await stock_issues.create(
        db,
        customer_id=customer.id,
        project_id=shelf["order"].id,
        recipient=stock_issues.Recipient(),
        waybill=None,
        note=None,
        actor=None,
    )


@pytest.fixture
async def pipe_shelf(db_session):
    """Pipe (Tail: straight standard / angled): standard position 3 free, angled 1 free;
    an active order line on the standard configuration, quantity 3."""
    pipe = Product(name="Pipe")
    db_session.add(pipe)
    await db_session.flush()
    group = ProductVariantGroup(product_id=pipe.id, name="Tail")
    db_session.add(group)
    await db_session.flush()
    straight = ProductVariantOption(group_id=group.id, name="straight", position=0)
    angled = ProductVariantOption(group_id=group.id, name="angled", position=1)
    db_session.add_all([straight, angled])
    await db_session.flush()
    group.default_option_id = straight.id
    db_session.add(ProductPart(product_id=pipe.id, kind="printed", name="flask", name_key="flask", qty_per_unit=1))
    await db_session.flush()
    standard = await finished_stock.item_for(db_session, pipe.id, {}, create=True)
    await finished_stock.receive(db_session, standard, 3)
    angled_item = await finished_stock.item_for(db_session, pipe.id, {group.id: angled.id}, create=True)
    await finished_stock.receive(db_session, angled_item, 1)
    _order, line = await _line(db_session, pipe, 3)
    await db_session.commit()
    return {"pipe": pipe, "standard": standard, "angled": angled_item, "line": line}


async def _held(db, line):
    return await finished_stock.held_for_line(db, line.id)


@pytest.mark.asyncio
async def test_a_line_takes_what_is_free_up_to_its_quantity(db_session, shelf):
    got = await finished_stock.reserve_for_line(db_session, shelf["line"], 9)
    assert got == 4  # quantity 4, 5 free
    assert shelf["line"].from_finished == 4 and shelf["item"].reserved == 4
    # Rewriting 4 → 4 stays 4: the line's own reservation comes back first.
    assert await finished_stock.reserve_for_line(db_session, shelf["line"], 4) == 4
    assert await _held(db_session, shelf["line"]) == 4
    assert shelf["line"].from_finished == 4


@pytest.mark.asyncio
async def test_a_parts_line_and_a_configuration_without_a_position_take_nothing(db_session, shelf):
    shelf["line"].mode = "parts"
    assert await finished_stock.reserve_for_line(db_session, shelf["line"], 2) == 0
    shelf["line"].mode = "product"
    shelf["line"].config_key = "no-such-key"
    assert await finished_stock.reserve_for_line(db_session, shelf["line"], 2) == 0
    assert shelf["item"].reserved == 0


@pytest.mark.asyncio
async def test_release_gives_back_what_is_held(db_session, shelf):
    await finished_stock.reserve_for_line(db_session, shelf["line"], 3)
    assert await finished_stock.release_for_line(db_session, shelf["line"]) == 3
    assert shelf["line"].from_finished == 0 and shelf["item"].reserved == 0
    assert await finished_stock.release_for_line(db_session, shelf["line"]) == 0  # nothing twice


@pytest.mark.asyncio
async def test_issue_ships_the_reservation_and_keeps_the_count(db_session, shelf, customer):
    await finished_stock.reserve_for_line(db_session, shelf["line"], 3)
    await finished_stock.issue_from_line(
        db_session, shelf["line"], 3, stock_issue=await _issue(db_session, shelf, customer)
    )
    assert (shelf["item"].on_hand, shelf["item"].reserved) == (2, 0)
    assert shelf["line"].from_finished == 3  # coverage of a completed order stays
    issue = (await db_session.execute(select(StockItemMovement).where(StockItemMovement.kind == "issue"))).scalar_one()
    assert issue.customer_id == customer.id and issue.project_line_id == shelf["line"].id


@pytest.mark.asyncio
async def test_a_manual_release_cannot_take_a_lines_reservation(db_session, shelf):
    await finished_stock.reserve_for_line(db_session, shelf["line"], 3)
    assert await finished_stock.unassigned_reserved(db_session, shelf["item"]) == 0
    with pytest.raises(finished_stock.FinishedStockError):
        await finished_stock.release(db_session, shelf["item"], 1)


@pytest.mark.asyncio
async def test_moving_to_a_poorer_position_takes_what_it_has(db_session, pipe_shelf):
    line, standard, angled = pipe_shelf["line"], pipe_shelf["standard"], pipe_shelf["angled"]
    await finished_stock.reserve_for_line(db_session, line, 3)
    line.config_key = angled.config_key  # what line_config writes when the choice changes
    assert await finished_stock.move_for_line(db_session, line) == (3, 1)
    assert (standard.reserved, angled.reserved, line.from_finished) == (0, 1, 1)


@pytest.mark.asyncio
async def test_positions_by_key_are_one_read(db_session, pipe_shelf):
    pipe = pipe_shelf["pipe"]
    found = await finished_stock.free_by_keys(
        db_session, [(pipe.id, pipe_shelf["standard"].config_key), (pipe.id, "nothing")]
    )
    assert list(found) == [(pipe.id, pipe_shelf["standard"].config_key)]


@pytest.mark.asyncio
async def test_detaching_a_line_keeps_the_rows(db_session, shelf):
    await finished_stock.reserve_for_line(db_session, shelf["line"], 2)
    await finished_stock.release_for_line(db_session, shelf["line"])
    await finished_stock.detach_line(db_session, shelf["line"].id)
    rows = (await db_session.execute(select(StockItemMovement.project_line_id))).scalars().all()
    assert rows and all(r is None for r in rows)
    assert await finished_stock.unassigned_reserved(db_session, shelf["item"]) == 0


@pytest.mark.asyncio
async def test_detaching_an_order_clears_both_ids(db_session, shelf):
    await finished_stock.reserve_for_line(db_session, shelf["line"], 1)
    await finished_stock.release_for_line(db_session, shelf["line"])
    await finished_stock.detach_project(db_session, shelf["order"].id)
    rows = (await db_session.execute(select(StockItemMovement.project_id, StockItemMovement.project_line_id))).all()
    assert all(r == (None, None) for r in rows)


@pytest.mark.asyncio
async def test_the_columns_stay_the_sum_of_the_ledger(db_session, shelf, customer):
    line, item = shelf["line"], shelf["item"]
    await finished_stock.reserve_for_line(db_session, line, 2)
    await finished_stock.reserve_for_line(db_session, line, 4)
    await finished_stock.release_for_line(db_session, line)
    await finished_stock.reserve_for_line(db_session, line, 1)
    await finished_stock.issue_from_line(db_session, line, 1, stock_issue=await _issue(db_session, shelf, customer))
    await db_session.flush()
    rows = (await db_session.execute(select(StockItemMovement.delta_on_hand, StockItemMovement.delta_reserved))).all()
    assert item.on_hand == sum(r[0] for r in rows) and item.reserved == sum(r[1] for r in rows)
