import asyncio

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


async def _wal_engine(tmp_path, monkeypatch):
    from backend.app.core import database

    database.import_all_models()
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'runtime.db'}", connect_args={"timeout": 15})
    async with engine.begin() as conn:
        await conn.execute(text("PRAGMA journal_mode=WAL"))
        await conn.run_sync(database.Base.metadata.create_all)
    monkeypatch.setattr(database, "engine", engine)
    monkeypatch.setattr(database, "async_session", async_sessionmaker(engine, expire_on_commit=False))
    return engine


@pytest.mark.asyncio
async def test_independent_wal_sessions_keep_the_runtime_repair_serialized(tmp_path, monkeypatch):
    from backend.tests.integration.runtime_recovery_scenarios import run

    engine = await _wal_engine(tmp_path, monkeypatch)
    try:
        result = await run()
        assert result == dict.fromkeys(
            ("new_start_sees_the_pause", "one_clear_per_token", "b_between_commits_untouched"), True
        )
    finally:
        await engine.dispose()


def _a_lock_another_loop_left_behind() -> asyncio.Lock:
    """What an earlier test on the same worker can leave in a process-wide lock registry: a lock that was
    contended -- so bound -- on that test's own event loop, and is still held."""
    lock = asyncio.Lock()

    async def contend():
        await lock.acquire()
        waiter = asyncio.ensure_future(lock.acquire())
        await asyncio.sleep(0)
        lock.release()
        await waiter

    asyncio.run(contend())
    return lock


@pytest.mark.asyncio
async def test_the_scenario_owns_its_lane_locks_whatever_an_earlier_test_left(tmp_path, monkeypatch):
    """Production has one event loop; a test worker has one per test. Queue ids repeat between tests, so the
    scenario must not inherit another loop's lane lock (it did, in a full -n 4 run)."""
    from backend.app.services import queue_ops
    from backend.tests.integration.runtime_recovery_scenarios import run

    stale = await asyncio.to_thread(_a_lock_another_loop_left_behind)
    for queue_id in range(1, 4):
        monkeypatch.setitem(queue_ops._queue_claim_locks, queue_id, stale)
    engine = await _wal_engine(tmp_path, monkeypatch)
    try:
        result = await run()
        assert all(result.values()), result
    finally:
        await engine.dispose()
    assert queue_ops._queue_claim_locks[1] is stale  # restored afterwards
