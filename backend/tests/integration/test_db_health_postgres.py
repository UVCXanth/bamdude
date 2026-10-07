"""Real SQL failures must not poison the remaining database-health probes.

Uses TEST_POSTGRES_URL (also supplied by CI). Each test owns a schema and
leaves the server's extension configuration alone.
"""

import os
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from backend.app.services import db_health

pytestmark = [pytest.mark.postgres, pytest.mark.asyncio]


@pytest.fixture
async def health_engine(monkeypatch):
    url = os.environ.get("TEST_POSTGRES_URL")
    if not url:
        pytest.skip("TEST_POSTGRES_URL not set")
    url = url.replace("postgresql://", "postgresql+asyncpg://", 1)
    schema = f"health_{uuid4().hex}"
    admin = create_async_engine(url)
    engine = create_async_engine(url, connect_args={"server_settings": {"search_path": schema}})
    monkeypatch.setattr(db_health, "is_postgres", lambda: True)
    try:
        async with admin.begin() as conn:
            await conn.execute(text(f'CREATE SCHEMA "{schema}"'))
        async with engine.begin() as conn:
            await conn.execute(text("CREATE TABLE caller_work (value integer)"))
            # No visible extension view even if another test installed it in public.
            assert (await conn.execute(text("SELECT to_regclass('pg_stat_statements')"))).scalar() is None
        yield engine
    finally:
        await engine.dispose()
        async with admin.begin() as conn:
            await conn.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        await admin.dispose()


async def test_missing_statements_preserves_other_probes_and_callers_transaction(health_engine):
    async with AsyncSession(health_engine) as db:
        await db.execute(text("INSERT INTO caller_work VALUES (42)"))
        result = await db_health.collect(db)

        assert result["instrumentation"]["source"] == "pg_stat_statements"
        assert result["instrumentation"]["reason"]
        assert result["instrumentation"]["slowest"] == []
        assert result["probes_failed"] == []
        for field in ("version", "size_bytes", "postgres", "largest_tables", "scans"):
            assert result[field] is not None
        assert (await db.execute(text("SELECT value FROM caller_work"))).scalar_one() == 42
        # A diagnostic call must neither roll back nor commit the caller's work.
        async with health_engine.connect() as other:
            assert (await other.execute(text("SELECT count(*) FROM caller_work"))).scalar_one() == 0
        await db.rollback()
        assert (await db.execute(text("SELECT count(*) FROM caller_work"))).scalar_one() == 0


@pytest.mark.parametrize("failed", ["version", "size_bytes", "postgres", "largest_tables", "scans"])
async def test_each_sql_probe_failure_is_isolated(health_engine, monkeypatch, failed):
    async def sql_error(db):
        await db.execute(text("SELECT 1 / 0"))

    monkeypatch.setattr(db_health, f"probe_{failed}", sql_error)
    async with AsyncSession(health_engine) as db:
        result = await db_health.collect(db)
        assert result["probes_failed"] == [failed]
        assert result[failed] is None
        for field in {"version", "size_bytes", "postgres", "largest_tables", "scans"} - {failed}:
            assert result[field] is not None
        assert result["pool"] is not None
        assert (await db.execute(text("SELECT 42"))).scalar_one() == 42


async def test_extension_installed_without_preload_is_also_isolated(health_engine):
    async with AsyncSession(health_engine) as db:
        preload = (await db.execute(text("SHOW shared_preload_libraries"))).scalar_one()
        installed = (
            await db.execute(text("SELECT count(*) FROM pg_extension WHERE extname = 'pg_stat_statements'"))
        ).scalar_one()
        if installed or "pg_stat_statements" in preload:
            pytest.skip("requires a scratch server without statistics already enabled")
        # The view exists, but querying it raises an SQL error when not preloaded.
        # The extension is transactional and disappears when this session closes.
        await db.execute(text("CREATE EXTENSION pg_stat_statements"))
        result = await db_health.collect(db)
        assert result["instrumentation"]["reason"]
        assert result["probes_failed"] == []
        assert result["version"]
        assert result["postgres"] is not None
        assert (await db.execute(text("SELECT 42"))).scalar_one() == 42
