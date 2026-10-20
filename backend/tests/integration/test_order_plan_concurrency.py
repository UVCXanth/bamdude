"""DB-only serialization, independent sessions; optional dedicated PostgreSQL.

ORDER_PLAN_TEST_POSTGRES_URL uses an isolated schema per test, never application
data. Source/authority behavior is covered through actual HTTP writers elsewhere.
"""

import asyncio
import os
import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy import event, func, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.core.database import Base, configure_sqlite_connection, import_all_models
from backend.app.models.auto_queue import AutoQueueItem
from backend.app.models.order_working_plan import OrderPlanReceipt, OrderPlanSubmission, OrderWorkingPlan
from backend.app.models.product import Product
from backend.app.models.project import Project
from backend.app.models.project_line import ProjectLine
from backend.app.services import order_plan_submission as submissions, order_working_plan as working

pytestmark = pytest.mark.integration


@pytest.fixture
async def sessions(tmp_path, monkeypatch):
    import_all_models()
    url = os.environ.get("ORDER_PLAN_TEST_POSTGRES_URL")
    schema = "order_plan_" + uuid.uuid4().hex
    admin = None
    if url:
        admin = create_async_engine(url)
        async with admin.begin() as conn:
            await conn.execute(text(f"CREATE SCHEMA {schema}"))
        engine = create_async_engine(
            url, connect_args={"server_settings": {"search_path": schema, "application_name": schema}}
        )
    else:
        engine = create_async_engine(f"sqlite+aiosqlite:///{(tmp_path / 'plan.db').as_posix()}")
        event.listen(engine.sync_engine, "connect", configure_sqlite_connection)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    entry = {
        "entry_id": "entry",
        "line_id": 1,
        "plate_id": 1,
        "count": 4,
        "target": {"kind": "auto"},
        "source_token": "same",
    }
    async with factory() as db:
        db.add(Project(id=1, name="scratch", status="active"))
        db.add(Product(id=1, name="scratch product"))
        await db.flush()
        db.add(ProjectLine(id=1, project_id=1, product_id=1, quantity=4))
        await db.flush()
        db.add(OrderWorkingPlan(id=1, entries=[entry], active_operation="op"))
        await db.flush()
        db.add(
            OrderPlanSubmission(
                id="op",
                plan_id=1,
                actor="user:1",
                request_digest="x",
                request={"parts": [{"entry": entry, "count": 2, "expected_hash": None}]},
            )
        )
        await db.commit()

    async def authority(*args, **kwargs):
        return None, "all", None

    async def inputs(*args):
        return SimpleNamespace(ctx=SimpleNamespace(project=SimpleNamespace(status="active")))

    monkeypatch.setattr(submissions.authority, "fresh", authority)
    monkeypatch.setattr(submissions.order_draft, "inputs", inputs)
    monkeypatch.setattr(working, "projection", lambda *a, **kw: (None, [], []))
    yield factory, engine, schema
    await engine.dispose()
    if admin:
        async with admin.begin() as conn:
            await conn.execute(text(f"DROP SCHEMA {schema} CASCADE"))
        await admin.dispose()


async def blocked(engine, schema, task):
    if engine.dialect.name == "postgresql":
        for _ in range(150):
            async with engine.connect() as conn:
                waits = await conn.scalar(
                    text(
                        "SELECT count(*) FROM pg_stat_activity WHERE application_name=:name AND wait_event_type='Lock'"
                    ),
                    {"name": schema},
                )
            if waits:
                break
            await asyncio.sleep(0.02)
        else:
            pytest.fail("second database session never waited on a PostgreSQL lock")
    else:
        await asyncio.sleep(0.1)
    assert not task.done()


async def test_same_operation_serializes_and_consumes_once(sessions):
    factory, engine, schema = sessions
    context = submissions.PlanConsumption(1, "op", "entry", SimpleNamespace(identity="user:1"))
    async with factory() as first:
        ticket = await submissions.claim(first, context, "bytes")
        row = AutoQueueItem(project_id=1, position=1)
        first.add(row)
        await first.flush()
        await submissions.consume(first, ticket, [row.id, row.id + 1], "auto")

        async def contender():
            async with factory() as second:
                with pytest.raises(submissions.AlreadyPublished):
                    await submissions.claim(second, context, "bytes")

        task = asyncio.create_task(contender())
        await blocked(engine, schema, task)
        await first.commit()
        await asyncio.wait_for(task, 5)
    async with factory() as db:
        plan = await db.get(OrderWorkingPlan, 1)
        assert plan.entries[0]["count"] == 2 and plan.epoch == 1
        assert await db.scalar(select(func.count()).select_from(OrderPlanReceipt)) == 1


async def test_cancel_fences_a_capture_that_has_not_claimed(sessions):
    factory, engine, schema = sessions
    access = SimpleNamespace(identity="user:1")
    async with factory() as first:
        await submissions.cancel(first, 1, "op", access)

        async def delayed_capture():
            from fastapi import HTTPException

            async with factory() as second:
                with pytest.raises(HTTPException) as error:
                    await submissions.claim(second, submissions.PlanConsumption(1, "op", "entry", access), "bytes")
                assert error.value.detail["code"] == "submission_cancelled"

        task = asyncio.create_task(delayed_capture())
        await blocked(engine, schema, task)
        await first.commit()
        await asyncio.wait_for(task, 5)
    async with factory() as db:
        plan = await db.get(OrderWorkingPlan, 1)
        assert plan.entries[0]["count"] == 4 and plan.epoch == 0


async def test_edit_waits_for_publication_then_refuses_stale_revision(sessions):
    from fastapi import HTTPException

    factory, engine, schema = sessions
    async with factory() as first:
        ticket = await submissions.claim(
            first, submissions.PlanConsumption(1, "op", "entry", SimpleNamespace(identity="user:1")), "bytes"
        )
        await submissions.consume(first, ticket, [1, 2], "auto")

        async def save():
            async with factory() as second:
                row = await working.lock(second, 1)
                with pytest.raises(HTTPException):
                    working.check(row, 1)

        task = asyncio.create_task(save())
        await blocked(engine, schema, task)
        await first.commit()
        await asyncio.wait_for(task, 5)


async def test_lifecycle_holding_a_line_can_fence_without_fk_deadlock(sessions):
    from fastapi import HTTPException

    from backend.app.core.database import take_write_lock

    factory, engine, schema = sessions
    async with factory() as first:
        await take_write_lock(first, ProjectLine.__table__, 1)
        await first.execute(select(ProjectLine.id).where(ProjectLine.id == 1).with_for_update())

        async def publishing():
            async with factory() as second:
                with pytest.raises(HTTPException) as error:
                    await submissions.claim(
                        second,
                        submissions.PlanConsumption(1, "op", "entry", SimpleNamespace(identity="user:1")),
                        "bytes",
                    )
                assert error.value.detail["code"] == "submission_cancelled"

        task = asyncio.create_task(publishing())
        await blocked(engine, schema, task)
        await asyncio.wait_for(submissions.fence(first, 1), 3)
        await first.commit()
        await asyncio.wait_for(task, 5)


async def test_simultaneous_first_save_uses_the_unique_order_row(sessions, monkeypatch):
    from fastapi import HTTPException

    from backend.app.schemas.order_working_plan import WorkingWrite

    factory, engine, schema = sessions
    async with factory() as setup:
        setup.add(Project(id=2, name="new", status="active"))
        await setup.commit()

    async def inputs(*args):
        return SimpleNamespace(
            ctx=SimpleNamespace(project=SimpleNamespace(id=2, status="active"), lines=[]),
            recipes={},
            source_tokens={},
            token="inputs",
        )

    monkeypatch.setattr(working.draft, "inputs", inputs)
    monkeypatch.setattr(working, "snapshot", lambda *a: {"inputs_token": "inputs", "entries": {}})
    access = SimpleNamespace(actor=SimpleNamespace(label="test"))
    async with factory() as first:
        result = await working.write(first, 2, WorkingWrite(expected_revision=0, entries=[]), access)
        assert result["saved_revision"] == 0

        async def contender():
            async with factory() as second:
                with pytest.raises(HTTPException) as error:
                    await working.write(second, 2, WorkingWrite(expected_revision=0, entries=[]), access)
                assert error.value.status_code == 409

        task = asyncio.create_task(contender())
        await blocked(engine, schema, task)
        await first.commit()
        await asyncio.wait_for(task, 5)
    async with factory() as db:
        row = await db.get(OrderWorkingPlan, 2)
        assert row.revision == 1 and row.saved_revision == 0 and row.saved_entries is None


async def test_upgrade_populates_line_identity_in_this_database(sessions):
    from backend.app.migrations.m206_order_working_plans import upgrade

    factory, engine, _ = sessions
    async with engine.begin() as conn:
        await conn.execute(text("ALTER TABLE project_lines DROP COLUMN plan_identity"))
        await upgrade(conn)
        identity = await conn.scalar(text("SELECT plan_identity FROM project_lines WHERE id=1"))
        assert len(identity) == 36
        await upgrade(conn)
        assert await conn.scalar(text("SELECT plan_identity FROM project_lines WHERE id=1")) == identity
    async with factory() as db:
        assert (await db.get(OrderWorkingPlan, 1)).saved_entries is None
