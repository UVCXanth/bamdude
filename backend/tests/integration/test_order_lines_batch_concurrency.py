"""Two batches racing for the last ready units of one position (spec workshop-add-to-order,
Review Focus 2). File-backed SQLite so the two sessions hold two real connections —
the harness's in-memory StaticPool shares one, and nothing could race on it."""

import asyncio

import pytest
from sqlalchemy import event, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import selectinload

from backend.app.core.database import Base, configure_sqlite_connection, import_all_models
from backend.app.models.finished_stock import StockItem, StockItemMovement
from backend.app.models.product import Product
from backend.app.models.project import Project
from backend.app.models.project_line import ProjectLine
from backend.app.schemas.project import BatchProductLineIn, BatchStockIn
from backend.app.services import finished_stock, line_intake

pytestmark = pytest.mark.integration


@pytest.fixture
async def maker(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'batch.db'}", connect_args={"timeout": 15})
    event.listen(engine.sync_engine, "connect", configure_sqlite_connection)
    import_all_models()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_two_batches_never_take_more_than_the_shelf_holds(maker, monkeypatch):
    async with maker() as db:
        lamp = Product(name="Lamp")
        db.add(lamp)
        await db.flush()
        item = await finished_stock.item_for(db, lamp.id, {}, create=True)
        await finished_stock.receive(db, item, 3)
        orders = [Project(name="A"), Project(name="B")]
        db.add_all(orders)
        await db.commit()
        lamp_id, item_id, order_ids = lamp.id, item.id, [o.id for o in orders]

    original = finished_stock.lock_item

    async def slow(*args, **kwargs):
        result = await original(*args, **kwargs)
        await asyncio.sleep(0.3)
        return result

    monkeypatch.setattr(finished_stock, "lock_item", slow)

    async def add(order_id):
        async with maker() as db:
            project = (
                await db.execute(select(Project).options(selectinload(Project.lines)).where(Project.id == order_id))
            ).scalar_one()
            spec = BatchProductLineIn(
                kind="product", product_id=lamp_id, quantity=3, stock=BatchStockIn(from_finished=3, from_kits=0)
            )
            [intake] = await line_intake.add_lines(db, project, [spec], actor=None)
            await db.commit()
            return intake.got_finished

    got = await asyncio.gather(add(order_ids[0]), add(order_ids[1]))
    assert sum(got) == 3 and sorted(got) == [0, 3]
    async with maker() as db:
        row = await db.get(StockItem, item_id)
        ledger = await db.scalar(
            select(func.sum(StockItemMovement.delta_reserved)).where(StockItemMovement.item_id == item_id)
        )
        assert row.reserved == ledger == 3 and row.reserved <= row.on_hand


@pytest.mark.asyncio
async def test_two_releases_of_one_line_hand_back_once(maker, monkeypatch):
    """Final review M3: two transactions releasing the same line (two PATCHes, a cancel
    beside a delete) — the second finds nothing left, rather than releasing twice."""
    async with maker() as db:
        lamp = Product(name="Lamp")
        db.add(lamp)
        await db.flush()
        item = await finished_stock.item_for(db, lamp.id, {}, create=True)
        await finished_stock.receive(db, item, 3)
        order = Project(name="A")
        db.add(order)
        await db.flush()
        project = (
            await db.execute(select(Project).options(selectinload(Project.lines)).where(Project.id == order.id))
        ).scalar_one()
        spec = BatchProductLineIn(
            kind="product", product_id=lamp.id, quantity=3, stock=BatchStockIn(from_finished=3, from_kits=0)
        )
        [intake] = await line_intake.add_lines(db, project, [spec], actor=None)
        await db.commit()
        item_id, line_id = item.id, intake.line.id

    original = finished_stock.lock_item

    async def slow(*args, **kwargs):
        result = await original(*args, **kwargs)
        await asyncio.sleep(0.3)
        return result

    monkeypatch.setattr(finished_stock, "lock_item", slow)

    async def release():
        async with maker() as db:
            line = await db.get(ProjectLine, line_id)
            back = await finished_stock.release_for_line(db, line)
            await db.commit()
            return back

    got = await asyncio.gather(release(), release())
    assert sorted(got) == [0, 3]
    async with maker() as db:
        row = await db.get(StockItem, item_id)
        ledger = await db.scalar(
            select(func.sum(StockItemMovement.delta_reserved)).where(StockItemMovement.item_id == item_id)
        )
        assert row.reserved == ledger == 0
        assert (await db.get(ProjectLine, line_id)).from_finished == 0
