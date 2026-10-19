"""Additive m195 keeps existing orders stable and is safe to rerun."""

import json

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.migrations import m195_bom_extra_percent as m195


@pytest.mark.asyncio
async def test_upgrade_and_rerun_preserve_old_rows_and_new_snapshot(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'm195.db'}")
    try:
        async with engine.begin() as conn:
            await conn.execute(text("CREATE TABLE product_parts (id INTEGER PRIMARY KEY, qty_per_unit INTEGER)"))
            await conn.execute(text("CREATE TABLE project_lines (id INTEGER PRIMARY KEY, quantity INTEGER)"))
            await conn.execute(text("INSERT INTO product_parts VALUES (1, 3)"))
            await conn.execute(text("INSERT INTO project_lines VALUES (1, 100)"))
            await m195.upgrade(conn)
            assert (await conn.execute(text("SELECT qty_per_unit, extra_percent FROM product_parts"))).one() == (3, 0)
            assert (
                json.loads((await conn.execute(text("SELECT extra_percentages FROM project_lines"))).scalar_one()) == {}
            )
            await conn.execute(
                text("UPDATE project_lines SET extra_percentages = :snapshot"), {"snapshot": '{"1": 12.5}'}
            )
            await m195.upgrade(conn)
            assert json.loads(
                (await conn.execute(text("SELECT extra_percentages FROM project_lines"))).scalar_one()
            ) == {"1": 12.5}
            cols = {row[1]: row for row in (await conn.execute(text("PRAGMA table_info(project_lines)"))).all()}
            assert cols["extra_percentages"][2].upper() == "TEXT"
            assert cols["extra_percentages"][3] == 1
    finally:
        await engine.dispose()
