"""m188 — order stage, responsible user and the order journal."""

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.migrations import m188_order_stage_journal as m188


@pytest_asyncio.fixture
async def engine():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.execute(text("CREATE TABLE users (id INTEGER PRIMARY KEY, username VARCHAR(100))"))
        await conn.execute(
            text("CREATE TABLE projects (id INTEGER PRIMARY KEY, name VARCHAR(255), status VARCHAR(20))")
        )
        await conn.execute(
            text("INSERT INTO projects (id, name, status) VALUES (1, 'A', 'active'), (2, 'B', 'completed')")
        )
    try:
        yield engine
    finally:
        await engine.dispose()


async def _run(engine):
    async with engine.begin() as conn:
        await m188.upgrade(conn)


@pytest.mark.asyncio
async def test_existing_orders_start_in_preparation_with_nobody_responsible(engine):
    await _run(engine)
    async with engine.connect() as conn:
        rows = (await conn.execute(text("SELECT id, stage, responsible_id FROM projects ORDER BY id"))).all()
        assert rows == [(1, "prep", None), (2, "prep", None)]
        indexes = {r[1] for r in (await conn.execute(text("PRAGMA index_list(projects)"))).all()}
        assert "ix_projects_responsible_id" in indexes


@pytest.mark.asyncio
async def test_the_journal_table_never_hands_out_an_id_twice(engine):
    await _run(engine)
    async with engine.begin() as conn:
        insert = "INSERT INTO project_events (project_id, kind, payload) VALUES (1, 'stage_changed', '{}')"
        await conn.execute(text(insert))
        await conn.execute(text("DELETE FROM project_events"))
        await conn.execute(text(insert))
        assert (await conn.execute(text("SELECT id FROM project_events"))).scalar() == 2
        indexes = {r[1] for r in (await conn.execute(text("PRAGMA index_list(project_events)"))).all()}
        assert "ix_project_events_project_created" in indexes


@pytest.mark.asyncio
async def test_the_journal_columns_match_the_model(engine):
    # A migrated database and a fresh install (create_all) must agree: the model
    # declares created_at and payload NOT NULL, and a JSON column is TEXT on SQLite.
    await _run(engine)
    async with engine.connect() as conn:
        cols = {r[1]: r for r in (await conn.execute(text("PRAGMA table_info(project_events)"))).all()}
        assert cols["created_at"][3] == 1 and cols["payload"][3] == 1  # notnull
        assert cols["payload"][2].upper() == "TEXT"


@pytest.mark.asyncio
async def test_a_second_run_changes_nothing(engine):
    await _run(engine)
    await _run(engine)
    async with engine.connect() as conn:
        assert (await conn.execute(text("SELECT COUNT(*) FROM projects"))).scalar() == 2
