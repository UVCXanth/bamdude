"""Finished goods under order lines (spec workshop-add-to-order, rules 1–9)."""

import pytest
from sqlalchemy import select

from backend.app.models.customer import Customer
from backend.app.models.finished_stock import StockItemMovement
from backend.app.models.product import Product, ProductPart
from backend.app.models.product_variant import ProductVariantGroup, ProductVariantOption
from backend.app.models.project import Project
from backend.app.models.project_line import ProjectLine
from backend.app.services import finished_stock, line_config

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
