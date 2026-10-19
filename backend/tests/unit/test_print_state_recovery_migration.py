from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.migrations.m204_print_state_recovery import upgrade


@pytest.mark.asyncio
async def test_legacy_backfill_is_unique_idempotent_and_preserves_history(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'legacy.db'}")
    try:
        async with engine.begin() as conn:
            for table in ("printer_queues", "print_queue", "print_archives"):
                await conn.exec_driver_sql(
                    f"CREATE TABLE {table} (id INTEGER PRIMARY KEY, status TEXT, started_at TEXT)"
                )
                await conn.exec_driver_sql(
                    f"INSERT INTO {table} VALUES (1, 'printing', '2026-10-01 10:00:00'), (2, 'completed', NULL)"
                )
            await upgrade(conn)
            first = {}
            for table in ("printer_queues", "print_queue", "print_archives"):
                rows = (await conn.execute(text(f"SELECT * FROM {table} ORDER BY id"))).mappings().all()
                assert rows[0]["status"] == "printing" and rows[1]["status"] == "completed"
                assert rows[0]["started_at"] == "2026-10-01 10:00:00"
                values = [row["recovery_identity"] for row in rows]
                assert len(set(values)) == 2
                for value in values:
                    UUID(value)
                first[table] = values
            await upgrade(conn)
            for table, expected in first.items():
                assert (
                    await conn.execute(text(f"SELECT recovery_identity FROM {table} ORDER BY id"))
                ).scalars().all() == expected
            assert await conn.scalar(text("SELECT count(*) FROM print_state_recovery_actions")) == 0
    finally:
        await engine.dispose()
