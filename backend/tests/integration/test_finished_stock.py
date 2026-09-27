"""The finished-goods writer (spec workshop-finished-goods, rules 7–13)."""

import pytest
from sqlalchemy import func, select

from backend.app.models.customer import Customer
from backend.app.models.finished_stock import StockItem, StockItemMovement
from backend.app.models.product import Product, ProductOrigin
from backend.app.models.user import User
from backend.app.services import finished_stock

pytestmark = pytest.mark.integration


@pytest.fixture
async def lamp(db_session):
    product = Product(name="Lamp")
    db_session.add(product)
    await db_session.commit()
    return product


@pytest.fixture
async def adhoc_product(db_session):
    product = Product(name="Job", origin=ProductOrigin.ADHOC_JOB.value)
    db_session.add(product)
    await db_session.commit()
    return product


@pytest.fixture
async def user(db_session):
    person = User(username="stocker", password_hash="x", role="user")
    db_session.add(person)
    await db_session.commit()
    return person


@pytest.fixture
async def customer(db_session):
    row = Customer(name="Acme")
    db_session.add(row)
    await db_session.commit()
    return row


async def _item(db, product):
    item = await finished_stock.item_for(db, product.id, {}, create=True)
    await db.flush()
    return item


@pytest.mark.asyncio
async def test_a_receipt_creates_the_position_and_its_row(db_session, lamp, user):
    item = await _item(db_session, lamp)
    move = await finished_stock.receive(db_session, item, 5, note="from partner", actor=user)
    assert (item.on_hand, item.reserved) == (5, 0)
    assert (move.kind, move.delta_on_hand, move.created_by, move.note) == ("receipt", 5, user.id, "from partner")
    assert await finished_stock.item_for(db_session, lamp.id, {}, create=False) is item


@pytest.mark.asyncio
async def test_a_missing_position_is_not_invented(db_session, lamp):
    assert await finished_stock.item_for(db_session, lamp.id, {}, create=False) is None


@pytest.mark.asyncio
async def test_a_stocktake_writes_the_difference(db_session, lamp):
    item = await _item(db_session, lamp)
    await finished_stock.stocktake(db_session, item, 7)
    assert item.on_hand == 7
    assert await finished_stock.stocktake(db_session, item, 7) is None  # no change, no row
    with pytest.raises(finished_stock.FinishedStockError) as e:
        await finished_stock.stocktake(db_session, item, 5)
    assert e.value.status == 422  # a decrease needs a note
    await finished_stock.reserve(db_session, item, 6)
    with pytest.raises(finished_stock.FinishedStockError) as e:
        await finished_stock.stocktake(db_session, item, 5, note="lost")
    assert e.value.status == 409  # below the reserved
    move = await finished_stock.stocktake(db_session, item, 6, note="one broken")
    assert move.delta_on_hand == -1 and item.on_hand == 6
    rows = (await db_session.execute(select(func.count(StockItemMovement.id)))).scalar()
    assert rows == 3  # stocktake 7, reserve 6, stocktake −1


@pytest.mark.asyncio
async def test_reserve_release_and_issue_stay_within_the_shelf(db_session, lamp, customer):
    item = await _item(db_session, lamp)
    await finished_stock.receive(db_session, item, 4)
    await finished_stock.reserve(db_session, item, 3)
    with pytest.raises(finished_stock.FinishedStockError):
        await finished_stock.reserve(db_session, item, 2)  # only 1 available
    with pytest.raises(finished_stock.FinishedStockError):
        await finished_stock.issue(db_session, item, 2)  # only 1 available
    move = await finished_stock.issue(db_session, item, 2, from_reserve=True, customer_id=customer.id)
    assert (move.delta_on_hand, move.delta_reserved, move.customer_id) == (-2, -2, customer.id)
    assert (item.on_hand, item.reserved) == (2, 1)
    with pytest.raises(finished_stock.FinishedStockError):
        await finished_stock.release(db_session, item, 2)
    await finished_stock.release(db_session, item, 1)
    assert item.reserved == 0
    assert await finished_stock.unassigned_reserved(db_session, item) == 0


@pytest.mark.asyncio
async def test_quantities_below_one_are_refused(db_session, lamp):
    item = await _item(db_session, lamp)
    for op in ("receive", "reserve", "release", "issue"):
        with pytest.raises(finished_stock.FinishedStockError) as e:
            await getattr(finished_stock, op)(db_session, item, 0)
        assert e.value.status == 422
    with pytest.raises(finished_stock.FinishedStockError) as e:
        await finished_stock.stocktake(db_session, item, -1)
    assert e.value.status == 422


@pytest.mark.asyncio
async def test_columns_equal_the_sum_of_the_ledger(db_session, lamp):
    item = await _item(db_session, lamp)
    ops = [("receive", 5), ("reserve", 2), ("issue", 1), ("stocktake", 9), ("release", 1), ("issue", 2)]
    for op, n in ops:
        if op == "stocktake":
            await finished_stock.stocktake(db_session, item, n, note="count")
        else:
            await getattr(finished_stock, op)(db_session, item, n)
    sums = (
        await db_session.execute(
            select(func.sum(StockItemMovement.delta_on_hand), func.sum(StockItemMovement.delta_reserved)).where(
                StockItemMovement.item_id == item.id
            )
        )
    ).one()
    assert (item.on_hand, item.reserved) == tuple(sums)


@pytest.mark.asyncio
async def test_only_catalogue_products_are_kept(db_session, adhoc_product):
    with pytest.raises(finished_stock.FinishedStockError) as e:
        await finished_stock.item_for(db_session, adhoc_product.id, {}, create=True)
    assert e.value.status == 422


@pytest.mark.asyncio
async def test_params(db_session, lamp):
    item = await _item(db_session, lamp)
    await finished_stock.set_params(db_session, item, {"location": " B-02 ", "min_qty": 10})
    assert (item.location, item.min_qty) == ("B-02", 10)
    await finished_stock.set_params(db_session, item, {"location": ""})
    assert item.location is None
    with pytest.raises(finished_stock.FinishedStockError) as e:
        await finished_stock.set_params(db_session, item, {"min_qty": -1})
    assert e.value.status == 422
    rows = (await db_session.execute(select(func.count(StockItemMovement.id)))).scalar()
    assert rows == 0  # parameters are not stock


@pytest.mark.asyncio
async def test_a_user_leaving_keeps_the_rows(db_session, lamp, user):
    item = await _item(db_session, lamp)
    move = await finished_stock.receive(db_session, item, 1, actor=user)
    await finished_stock.detach_user(db_session, user.id)
    await db_session.refresh(move)
    assert move.created_by is None


@pytest.mark.asyncio
async def test_a_position_holds_one_configuration_per_product(db_session, lamp):
    first = await _item(db_session, lamp)
    again = await finished_stock.item_for(db_session, lamp.id, {}, create=True)
    assert again is first
    assert (await db_session.execute(select(func.count(StockItem.id)))).scalar() == 1
