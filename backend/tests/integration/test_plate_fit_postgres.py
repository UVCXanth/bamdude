"""Real claim/cancel races. Only the explicitly named disposable test database."""

import asyncio
import os
from types import SimpleNamespace

import pytest
from sqlalchemy import update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.core.database import Base, import_all_models
from backend.app.models.auto_queue import AutoQueueItem
from backend.app.models.library import LibraryFile
from backend.app.models.product import Product, ProductPart, ProductPlate
from backend.app.models.project import Project
from backend.app.models.project_line import ProjectLine
from backend.app.services import finished_stock, plate_fit


@pytest.mark.asyncio
async def test_pending_removal_and_quantity_commit_atomically_against_a_real_claim():
    url = os.environ.get("TEST_PLATE_FIT_POSTGRES_URL")
    if not url:
        pytest.skip("Disposable plate-fit PostgreSQL is not configured")
    engine = create_async_engine(url)
    assert engine.url.database == "plate_fit_atomic" and engine.url.host.startswith("plate-fit-")
    import_all_models()
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with sessions() as db:
            product = Product(name="Product A")
            order = Project(name="Product A atomic test", status="active")
            file = LibraryFile(
                filename="Product A.gcode.3mf",
                file_path="synthetic-only",
                file_type="gcode",
                file_size=1,
                file_metadata={
                    "plates": [
                        {
                            "index": 1,
                            "printable_objects": {"1": "Part A", "2": "Part A", "3": "Part A", "4": "Part B"},
                            "print_time_seconds": 60,
                        }
                    ]
                },
            )
            db.add_all([product, order, file])
            await db.flush()
            db.add_all(
                [
                    ProductPart(
                        product_id=product.id, kind="printed", name="Part A", name_key="part a", qty_per_unit=3
                    ),
                    ProductPart(
                        product_id=product.id, kind="printed", name="Part B", name_key="part b", qty_per_unit=1
                    ),
                ]
            )
            plate = ProductPlate(product_id=product.id, library_file_id=file.id, plate_index=0)
            line = ProjectLine(project_id=order.id, product_id=product.id, quantity=10)
            db.add_all([plate, line])
            await db.flush()
            auto = AutoQueueItem(
                project_id=order.id, project_line_id=line.id, library_file_id=file.id, plate_id=1, status="pending"
            )
            db.add(auto)
            await db.commit()
            order_id, line_id, plate_id, auto_id = order.id, line.id, plate.id, auto.id

        started = asyncio.Event()

        async def claim():
            async with sessions() as db:
                started.set()
                changed = await db.execute(
                    update(AutoQueueItem)
                    .where(AutoQueueItem.id == auto_id, AutoQueueItem.status == "pending")
                    .values(status="assigned")
                )
                await db.commit()
                return changed.rowcount

        async with sessions() as db:
            line = await db.get(ProjectLine, line_id)
            await finished_stock.lock_line(db, line)
            snapshot = await plate_fit.load(db, order_id, line_id, [plate_id], replace_pending=True, lock_pending=True)
            confirmation = SimpleNamespace(
                basis=snapshot.basis,
                acknowledge_large_change=False,
                acknowledge_queue_change=True,
                runs=[SimpleNamespace(plate_id=plate_id, count=9)],
            )
            plate_fit.confirm(snapshot, 9, confirmation)
            contender = asyncio.create_task(claim())
            await asyncio.wait_for(started.wait(), 5)
            await asyncio.sleep(0.05)
            assert not contender.done(), "the actual scheduler CAS waits for the reviewed row"
            line.quantity = 9
            await plate_fit.remove_reviewed_pending(db, snapshot)
            await db.commit()
        assert await asyncio.wait_for(contender, 5) == 0
        async with sessions() as db:
            assert (await db.get(ProjectLine, line_id)).quantity == 9
            assert await db.get(AutoQueueItem, auto_id) is None
            auto = AutoQueueItem(
                project_id=order_id, project_line_id=line_id, library_file_id=file.id, plate_id=1, status="pending"
            )
            db.add(auto)
            await db.commit()
            new_id = auto.id
        async with sessions() as db:
            line = await db.get(ProjectLine, line_id)
            await finished_stock.lock_line(db, line)
            snapshot = await plate_fit.load(db, order_id, line_id, [plate_id], replace_pending=True, lock_pending=True)
            line.quantity = 8
            await plate_fit.remove_reviewed_pending(db, snapshot)
            await db.flush()
            await db.rollback()  # Any later validation failure must undo BOTH changes.
        async with sessions() as db:
            assert (await db.get(ProjectLine, line_id)).quantity == 9
            assert (await db.get(AutoQueueItem, new_id)).status == "pending"
    finally:
        # The disposable PostgreSQL container owns cleanup. Application metadata
        # contains unnamed cyclic FKs, so drop_all cannot sort it on PostgreSQL.
        await engine.dispose()
