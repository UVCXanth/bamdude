"""Products and variants respect what the stock holds (spec workshop-finished-goods, rules 14–15)."""

import pytest
from sqlalchemy import func, select

from backend.app.models.finished_stock import StockItem, StockItemChoice, StockItemMovement
from backend.app.models.product import Product, ProductPart
from backend.app.models.product_variant import ProductVariantGroup, ProductVariantOption
from backend.app.services import finished_stock

pytestmark = pytest.mark.integration


@pytest.fixture
async def pipe(db_session):
    product = Product(name="Pipe")
    db_session.add(product)
    await db_session.flush()
    group = ProductVariantGroup(product_id=product.id, name="Tail")
    db_session.add(group)
    await db_session.flush()
    straight = ProductVariantOption(group_id=group.id, name="straight", position=0)
    angled = ProductVariantOption(group_id=group.id, name="angled", position=1)
    db_session.add_all([straight, angled])
    await db_session.flush()
    group.default_option_id = straight.id
    db_session.add(ProductPart(product_id=product.id, kind="printed", name="flask", name_key="flask", qty_per_unit=1))
    await db_session.commit()
    return {"product": product, "group": group, "straight": straight, "angled": angled}


async def _count(db, model):
    return (await db.execute(select(func.count()).select_from(model))).scalar()


@pytest.mark.asyncio
async def test_a_product_with_goods_in_stock_is_not_deleted(committing_client, db_session, pipe):
    item = await finished_stock.item_for(db_session, pipe["product"].id, {}, create=True)
    await finished_stock.receive(db_session, item, 2)
    await db_session.commit()
    r = await committing_client.delete(f"/api/v1/products/{pipe['product'].id}")
    assert r.status_code == 409
    assert r.json()["detail"] == "The product has finished goods in stock"


@pytest.mark.asyncio
async def test_empty_positions_go_with_the_product(committing_client, db_session, pipe):
    item = await finished_stock.item_for(db_session, pipe["product"].id, {}, create=True)
    await finished_stock.receive(db_session, item, 2)
    await finished_stock.issue(db_session, item, 2)
    await db_session.commit()
    r = await committing_client.delete(f"/api/v1/products/{pipe['product'].id}")
    assert r.status_code == 200, r.text
    for model in (StockItem, StockItemChoice, StockItemMovement):
        assert await _count(db_session, model) == 0


@pytest.mark.asyncio
async def test_an_option_a_position_holds_is_not_deleted(committing_client, db_session, pipe):
    await finished_stock.item_for(db_session, pipe["product"].id, {pipe["group"].id: pipe["angled"].id}, create=True)
    await db_session.commit()
    base = f"/api/v1/products/{pipe['product'].id}/variant-groups/{pipe['group'].id}"
    r = await committing_client.delete(f"{base}/options/{pipe['angled'].id}")
    assert r.status_code == 409
    assert r.json()["detail"] == "Option held by 1 stock positions"
    r = await committing_client.delete(base)
    assert r.status_code == 409
    assert r.json()["detail"] == "Group held by 1 stock positions"
    product = (await committing_client.get(f"/api/v1/products/{pipe['product'].id}")).json()
    angled = next(o for o in product["variant_groups"][0]["options"] if o["id"] == pipe["angled"].id)
    assert angled["stock_count"] == 1
