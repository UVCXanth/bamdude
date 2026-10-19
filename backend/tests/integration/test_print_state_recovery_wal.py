import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


@pytest.mark.asyncio
async def test_independent_wal_sessions_preserve_recovery_ownership(tmp_path, monkeypatch):
    from backend.app.core import database
    from backend.tests.integration.print_state_recovery_scenarios import run

    database.import_all_models()
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'recovery.db'}", connect_args={"timeout": 15})
    async with engine.begin() as conn:
        await conn.execute(text("PRAGMA journal_mode=WAL"))
        await conn.run_sync(database.Base.metadata.create_all)
    monkeypatch.setattr(database, "engine", engine)
    monkeypatch.setattr(database, "async_session", async_sessionmaker(engine, expire_on_commit=False))
    try:
        result = await run()
        assert len(result) == 6 and all(result.values())
    finally:
        await engine.dispose()
