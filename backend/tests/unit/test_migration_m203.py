"""m203: the source's declaration columns, the job incarnations and the audit table (T9 spec r3 §3; plan T9.1).

Additive and safe to rerun: the two declaration columns on archives and library files, a ``swap_declaration_identity``
on the two JOB tables only (never on a source), backfilled once with a unique id per existing job, the audit table,
and the DB-only backfill of a legacy external default False (plan T9.3). No file is read.
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
            for table in ("print_archives", "print_queue", "auto_queue_items"):
                await conn.execute(text(f"CREATE TABLE {table} (id INTEGER PRIMARY KEY)"))
            # The columns the backfill reads, as every install at m202 has them.
            await conn.execute(
                text(
                    "CREATE TABLE library_files (id INTEGER PRIMARY KEY, file_path TEXT, file_hash VARCHAR(64), "
                    "file_tags TEXT, is_external BOOLEAN, swap_compatible BOOLEAN)"
                )
            )
            await conn.execute(
                text("CREATE TABLE library_tags (id INTEGER PRIMARY KEY, code VARCHAR(32), is_system BOOLEAN)")
            )
            await conn.execute(
                text("CREATE TABLE library_file_tags (file_id INTEGER, tag_id INTEGER, created_at DATETIME NOT NULL)")
            )
            await conn.execute(text("INSERT INTO library_tags (id, code, is_system) VALUES (7, 'swap', 1)"))
            await conn.execute(
                text(
                    "INSERT INTO library_files (id, file_path, file_hash, file_tags, is_external, swap_compatible) "
                    "VALUES (1, '/mnt/share/tray.swaps.gcode.3mf', :sha, '[\"3mf\"]', 1, 0)"
                ),
                {"sha": "ab" * 32},
            )
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
            legacy = (
                await conn.execute(
                    text("SELECT swap_compatible, swap_source_declaration, file_tags FROM library_files")
                )
            ).one()
            assert legacy[0] == 1 and '"origin": "classifier"' in legacy[1] and "swap" in legacy[2]
            assert (await conn.execute(text("SELECT file_id, tag_id FROM library_file_tags"))).all() == [(1, 7)]

            await m203.upgrade(conn)  # rerun: nothing changes
        await m203.seed(async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False))
        async with engine.begin() as conn:
            for table in ("print_queue", "auto_queue_items"):
                rows = dict((await conn.execute(text(f"SELECT id, swap_declaration_identity FROM {table}"))).all())
                assert rows == first[table]
            assert (await conn.execute(text("SELECT count(*) FROM library_file_tags"))).scalar_one() == 1
            with pytest.raises(IntegrityError):  # the identity is unique
                await conn.execute(
                    text("UPDATE print_queue SET swap_declaration_identity = :same WHERE id = 2"),
                    {"same": first["print_queue"][1]},
                )
    finally:
        await engine.dispose()
