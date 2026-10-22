"""m207/m208 add the dispatch phase and a failed row's class to an existing database, once.

Fresh installs get the columns from ``create_all``; an existing database gets them
here. Both are nullable and NOT backfilled: an old archive's phase and an old failed
row's class are unknown, and nothing guesses them (post-rebuild D-R3, D-R6).
"""

from __future__ import annotations

import pytest
from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.migrations import m207_archive_dispatch_phase as m207, m208_queue_error_code as m208

pytestmark = pytest.mark.asyncio


async def columns(conn, table: str) -> dict[str, dict]:
    return await conn.run_sync(lambda sync: {c["name"]: c for c in inspect(sync).get_columns(table)})


async def test_an_older_database_gains_both_columns_once_and_keeps_its_rows_unknown(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'old.db'}")
    try:
        async with engine.begin() as conn:
            await conn.execute(text("CREATE TABLE print_archives (id INTEGER PRIMARY KEY, status VARCHAR(20))"))
            await conn.execute(text("CREATE TABLE print_queue (id INTEGER PRIMARY KEY, status VARCHAR(20))"))
            await conn.execute(text("INSERT INTO print_archives (id, status) VALUES (1, 'printing')"))
            await conn.execute(text("INSERT INTO print_queue (id, status) VALUES (1, 'failed')"))

        for _ in range(2):  # idempotent, as the DEBUG-startup re-run of the latest migration needs
            async with engine.begin() as conn:
                await m207.upgrade(conn)
                await m208.upgrade(conn)

        async with engine.begin() as conn:
            archive = await columns(conn, "print_archives")
            queue = await columns(conn, "print_queue")
            assert archive["dispatch_phase"]["nullable"] and archive["dispatch_boot_id"]["nullable"]
            assert queue["error_code"]["nullable"]
            row = (await conn.execute(text("SELECT dispatch_phase, dispatch_boot_id FROM print_archives"))).one()
            assert tuple(row) == (None, None)
            assert (await conn.execute(text("SELECT error_code FROM print_queue"))).scalar_one() is None
    finally:
        await engine.dispose()
