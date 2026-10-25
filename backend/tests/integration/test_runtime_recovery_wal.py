import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


@pytest.mark.asyncio
async def test_independent_wal_sessions_keep_the_runtime_repair_serialized(tmp_path, monkeypatch):
    from backend.app.core import database
    from backend.tests.integration.runtime_recovery_scenarios import run

    database.import_all_models()
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'runtime.db'}", connect_args={"timeout": 15})
    async with engine.begin() as conn:
        await conn.execute(text("PRAGMA journal_mode=WAL"))
        await conn.run_sync(database.Base.metadata.create_all)
    monkeypatch.setattr(database, "engine", engine)
    monkeypatch.setattr(database, "async_session", async_sessionmaker(engine, expire_on_commit=False))
    try:
        result = await run()
        assert result == dict.fromkeys(
            ("new_start_sees_the_pause", "one_clear_per_token", "b_between_commits_untouched"), True
        )
    finally:
        await engine.dispose()
