"""m203: the source's declaration columns, the job incarnations and the audit table (T9 spec r3 §3; plan T9.1).

Additive and safe to rerun: the two declaration columns on archives and library files, a ``swap_declaration_identity``
on the two JOB tables only (never on a source), backfilled once with a unique id per existing job, and the audit
table. No file is read.
"""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from backend.app.migrations import m203_swap_source_declaration as m203


async def columns(conn, table: str) -> set[str]:
    return {row[1] for row in (await conn.execute(text(f"PRAGMA table_info({table})"))).all()}


@pytest.mark.asyncio
async def test_upgrade_adds_the_columns_backfills_each_job_once_and_reruns_safely(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'm203.db'}")
    try:
        async with engine.begin() as conn:
            for table in ("print_archives", "library_files", "print_queue", "auto_queue_items"):
                await conn.execute(text(f"CREATE TABLE {table} (id INTEGER PRIMARY KEY)"))
            await conn.execute(text("INSERT INTO print_queue (id) VALUES (1), (2), (3)"))
            await conn.execute(text("INSERT INTO auto_queue_items (id) VALUES (1), (2)"))
            await m203.upgrade(conn)

        await m203.seed(async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False))

        async with engine.begin() as conn:
            assert "swap_source_declaration" in await columns(conn, "print_archives")
            assert "swap_source_declaration" in await columns(conn, "library_files")
            for table in ("print_archives", "library_files"):
                assert "swap_declaration_identity" not in await columns(conn, table)
            first = {}
            for table in ("print_queue", "auto_queue_items"):
                rows = (await conn.execute(text(f"SELECT id, swap_declaration_identity FROM {table}"))).all()
                assert all(len(identity or "") == 36 for _id, identity in rows), rows
                first[table] = dict(rows)
            everyone = [identity for rows in first.values() for identity in rows.values()]
            assert len(set(everyone)) == len(everyone)

            await m203.upgrade(conn)  # rerun: nothing changes
        await m203.seed(async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False))
        async with engine.begin() as conn:
            for table in ("print_queue", "auto_queue_items"):
                rows = dict((await conn.execute(text(f"SELECT id, swap_declaration_identity FROM {table}"))).all())
                assert rows == first[table]
            with pytest.raises(IntegrityError):  # the identity is unique
                await conn.execute(
                    text("UPDATE print_queue SET swap_declaration_identity = :same WHERE id = 2"),
                    {"same": first["print_queue"][1]},
                )
    finally:
        await engine.dispose()
