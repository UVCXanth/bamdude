"""Two issue windows open on one order (spec workshop-order-issue, acceptance: the second «Execute»
gets 409 and writes nothing). File-backed SQLite so the two sessions hold two real connections —
the harness's in-memory StaticPool shares one, and nothing could race on it."""

import asyncio

import pytest
from sqlalchemy import event, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from backend.app.core.database import Base, configure_sqlite_connection, import_all_models
from backend.app.models.customer import Customer
from backend.app.models.finished_stock import StockItem, StockItemMovement
from backend.app.models.product import Product, ProductPart
from backend.app.models.project import Project
from backend.app.models.project_line import ProjectLine
from backend.app.models.stock_issue import StockIssue
from backend.app.services import finished_stock, line_config, order_fulfilment
from backend.app.services.order_fulfilment import FulfilmentError, LineRequest
from backend.app.services.stock_issues import Recipient

pytestmark = pytest.mark.integration


@pytest.fixture
async def maker(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'issue.db'}", connect_args={"timeout": 15})
    event.listen(engine.sync_engine, "connect", configure_sqlite_connection)
    import_all_models()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_two_windows_issuing_everything_issue_it_once(maker, monkeypatch):
    async with maker() as db:
        lamp = Product(name="Lamp")
        acme = Customer(name="Acme")
        db.add_all([lamp, acme])
        await db.flush()
        db.add(ProductPart(product_id=lamp.id, kind="printed", name="shade", name_key="shade", qty_per_unit=1))
        item = await finished_stock.item_for(db, lamp.id, {}, create=True)
        await finished_stock.receive(db, item, 3)
        order = Project(name="O", customer_id=acme.id)
        db.add(order)
        await db.flush()
        line = ProjectLine(project_id=order.id, product_id=lamp.id, quantity=3)
        db.add(line)
        await db.flush()
        await line_config.seed_line(db, line, choices=None, counts=None)
        assert await finished_stock.reserve_for_line(db, line, 3) == 3
        await db.commit()
        order_id, line_id, item_id = order.id, line.id, item.id

    original = finished_stock.lock_item

    async def slow(*args, **kwargs):
        result = await original(*args, **kwargs)
        await asyncio.sleep(0.3)
        return result

    monkeypatch.setattr(finished_stock, "lock_item", slow)

    async def issue_all():
        async with maker() as db:
            project = await db.get(Project, order_id)
            await db.refresh(project, ["lines"])
            try:
                await order_fulfilment.apply(
                    db,
                    project,
                    [LineRequest(line_id, issue=3)],
                    recipient=Recipient(),
                    waybill=None,
                    note=None,
                    complete=False,
                    actor=None,
                )
            except FulfilmentError as refused:
                await db.rollback()
                return refused.status
            await db.commit()
            return 200

    answers = await asyncio.gather(issue_all(), issue_all())
    assert sorted(answers) == [200, 409]
    async with maker() as db:
        row = await db.get(StockItem, item_id)
        ledger = await db.scalar(
            select(func.sum(StockItemMovement.delta_reserved)).where(StockItemMovement.item_id == item_id)
        )
        assert (row.on_hand, row.reserved, ledger) == (0, 0, 0)
        assert await db.scalar(select(func.count()).select_from(StockIssue)) == 1
        assert (await db.get(ProjectLine, line_id)).issued == 3
