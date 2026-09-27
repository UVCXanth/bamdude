"""Two operators deciding on the same shelf at once (spec workshop-finished-goods,
rules 7–8; final review, Critical 2).

⚠️ Driven over a FILE-backed SQLite database so the two sessions hold two real
connections: the harness's in-memory ``StaticPool`` shares one connection, and
two sessions on it cannot race at all. SQLite's dialect emits no ``FOR UPDATE``,
and pysqlite opens a transaction only at the first write — so a read taken
before it decides against a shelf another connection is about to change. The
writers must take SQLite's write lock BEFORE they read.
"""

import asyncio

import pytest
from sqlalchemy import event, func, select
from sqlalchemy.dialects import postgresql
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from backend.app.core.database import Base, configure_sqlite_connection, import_all_models
from backend.app.models.finished_stock import StockItem, StockItemMovement
from backend.app.models.part_stock import ProductPartStockMovement
from backend.app.models.product import Product, ProductPart
from backend.app.services import finished_stock, part_stock

pytestmark = pytest.mark.integration


@pytest.fixture
async def maker(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'stock.db'}", connect_args={"timeout": 15})
    event.listen(engine.sync_engine, "connect", configure_sqlite_connection)
    import_all_models()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    finally:
        await engine.dispose()


def _slow_after(monkeypatch, module, name):
    """Hold the decision open after the read — the window the review's race lived in."""
    original = getattr(module, name)

    async def slow(*args, **kwargs):
        result = await original(*args, **kwargs)
        await asyncio.sleep(0.3)
        return result

    monkeypatch.setattr(module, name, slow)


@pytest.mark.asyncio
async def test_two_reservations_over_one_shelf_never_both_land(maker, monkeypatch):
    async with maker() as db:
        lamp = Product(name="Lamp")
        db.add(lamp)
        await db.flush()
        item = await finished_stock.item_for(db, lamp.id, {}, create=True)
        await finished_stock.receive(db, item, 4)
        await db.commit()
        item_id = item.id
    _slow_after(monkeypatch, finished_stock, "lock_item")

    async def reserve(qty):
        async with maker() as db:
            try:
                await finished_stock.reserve(db, await db.get(StockItem, item_id), qty)
                await db.commit()
                return True
            except finished_stock.FinishedStockError:
                await db.rollback()
                return False

    results = await asyncio.gather(reserve(3), reserve(2))
    assert sorted(results) == [False, True]
    async with maker() as db:
        row = await db.get(StockItem, item_id)
        ledger = await db.scalar(
            select(func.sum(StockItemMovement.delta_reserved)).where(StockItemMovement.item_id == item_id)
        )
        assert row.reserved == ledger
        assert row.reserved in (2, 3) and row.reserved <= row.on_hand


@pytest.mark.asyncio
async def test_two_hand_corrections_over_one_part_never_overdraw_it(maker, monkeypatch):
    async with maker() as db:
        lamp = Product(name="Lamp")
        db.add(lamp)
        await db.flush()
        shade = ProductPart(product_id=lamp.id, kind="printed", name="shade", name_key="shade", qty_per_unit=1)
        db.add(shade)
        await db.flush()
        await part_stock.move(db, part_id=shade.id, delta=4, reason="manual", note="seed")
        await db.commit()
        shade_id = shade.id
    _slow_after(monkeypatch, part_stock, "lock_part")

    async def take(n):
        async with maker() as db:
            try:
                await part_stock.move(db, part_id=shade_id, delta=-n, reason="manual", note="dropped")
                await db.commit()
                return True
            except part_stock.PartStockError:
                await db.rollback()
                return False

    results = await asyncio.gather(take(3), take(3))
    assert sorted(results) == [False, True]
    async with maker() as db:
        balance = await db.scalar(
            select(func.sum(ProductPartStockMovement.delta)).where(ProductPartStockMovement.product_part_id == shade_id)
        )
        assert balance == 1


def test_postgresql_takes_the_row_lock():
    """On PostgreSQL the SELECT itself is the lock — pinned against the dialect, not trusted."""
    sql = str(finished_stock.lock_item_stmt(1).compile(dialect=postgresql.dialect()))
    assert "FOR UPDATE" in sql
