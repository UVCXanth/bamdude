"""m188 — order stage, responsible user and the order journal."""

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
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


@pytest.mark.asyncio
async def test_the_catalog_columns_tables_and_status_seed(engine):
    # spec workshop-product-catalog, rules 1–4: products already printing stay ready.
    async with engine.begin() as conn:
        await conn.execute(text("CREATE TABLE products (id INTEGER PRIMARY KEY, name VARCHAR(255))"))
        await conn.execute(text("CREATE TABLE product_parts (id INTEGER PRIMARY KEY, product_id INTEGER)"))
        await conn.execute(
            text("CREATE TABLE product_plates (id INTEGER PRIMARY KEY, product_id INTEGER, library_file_id INTEGER)")
        )
        await conn.execute(text("CREATE TABLE library_files (id INTEGER PRIMARY KEY, deleted_at DATETIME)"))
        await conn.execute(
            text("INSERT INTO products (id, name) VALUES (1, 'Full'), (2, 'No plates'), (3, 'Empty'), (4, 'Trashed')")
        )
        await conn.execute(text("INSERT INTO product_parts (product_id) VALUES (1), (2), (4)"))
        await conn.execute(text("INSERT INTO library_files (id, deleted_at) VALUES (10, NULL), (11, '2026-09-01')"))
        # A plate of a trashed file is no plate — what every list shows.
        await conn.execute(text("INSERT INTO product_plates (product_id, library_file_id) VALUES (1, 10), (4, 11)"))
    await _run(engine)
    await _run(engine)  # idempotent
    async with engine.connect() as conn:
        rows = (
            await conn.execute(text("SELECT id, status, sku, version, category_id FROM products ORDER BY id"))
        ).all()
        assert rows == [
            (1, "ready", None, None, None),
            (2, "draft", None, None, None),
            (3, "draft", None, None, None),
            (4, "draft", None, None, None),
        ]
        facet_cols = {r[1] for r in (await conn.execute(text("PRAGMA table_info(product_facets)"))).all()}
        assert facet_cols == {"product_id", "library_file_id", "kind", "value"}
        types = {r[1]: r[2] for r in (await conn.execute(text("PRAGMA table_info(products)"))).all()}
        assert types["sku_key"] == "VARCHAR(255)"
        for table in ("product_categories", "product_facets"):
            assert (await conn.execute(text(f"SELECT COUNT(*) FROM {table}"))).scalar() == 0
        indexes = {r[1] for r in (await conn.execute(text("PRAGMA index_list(products)"))).all()}
        assert {"ix_products_sku_key", "ix_products_category_id"} <= indexes


@pytest.mark.asyncio
async def test_the_order_queue_reads_have_their_indexes(engine):
    # spec workshop-order-queue, rules 8–9: the figures and the order's queue
    # section filter both queue tiers and the archives by order.
    async with engine.begin() as conn:
        await conn.execute(
            text("CREATE TABLE print_queue (id INTEGER PRIMARY KEY, project_id INTEGER, status VARCHAR(20))")
        )
        await conn.execute(
            text("CREATE TABLE auto_queue_items (id INTEGER PRIMARY KEY, project_id INTEGER, status VARCHAR(20))")
        )
        await conn.execute(
            text("CREATE TABLE print_archives (id INTEGER PRIMARY KEY, project_id INTEGER, created_at DATETIME)")
        )
    await _run(engine)
    await _run(engine)  # idempotent
    async with engine.connect() as conn:
        for table, index in (
            ("print_queue", "ix_print_queue_project_status"),
            ("auto_queue_items", "ix_auto_queue_items_project_status"),
            ("print_archives", "ix_print_archives_project_created"),
        ):
            names = {r[1] for r in (await conn.execute(text(f"PRAGMA index_list({table})"))).all()}
            assert index in names, table


@pytest.mark.asyncio
async def test_the_variant_and_line_configuration_schema(engine):
    # spec workshop-product-variants, rules 1–7: existing lines are standard
    # product lines with no choice and no changed count.
    async with engine.begin() as conn:
        await conn.execute(text("CREATE TABLE products (id INTEGER PRIMARY KEY, name VARCHAR(255))"))
        await conn.execute(text("CREATE TABLE product_parts (id INTEGER PRIMARY KEY, product_id INTEGER)"))
        await conn.execute(text("CREATE TABLE project_lines (id INTEGER PRIMARY KEY, product_id INTEGER)"))
        await conn.execute(text("INSERT INTO project_lines (id, product_id) VALUES (1, 1)"))
    await _run(engine)
    await _run(engine)  # idempotent
    async with engine.connect() as conn:
        line = (await conn.execute(text("SELECT mode, config_key FROM project_lines"))).one()
        assert tuple(line) == ("product", "")
        cols = {r[1] for r in (await conn.execute(text("PRAGMA table_info(product_parts)"))).all()}
        assert "variant_option_id" in cols
        for table in (
            "product_variant_groups",
            "product_variant_options",
            "project_line_choices",
            "project_line_part_counts",
        ):
            assert (await conn.execute(text(f"SELECT COUNT(*) FROM {table}"))).scalar() == 0


@pytest.mark.asyncio
async def test_the_finished_goods_schema(engine):
    # spec workshop-finished-goods, rules 1–5.
    async with engine.begin() as conn:
        await conn.execute(text("CREATE TABLE products (id INTEGER PRIMARY KEY, name VARCHAR(255))"))
        await conn.execute(text("CREATE TABLE product_parts (id INTEGER PRIMARY KEY, product_id INTEGER)"))
        await conn.execute(text("CREATE TABLE project_lines (id INTEGER PRIMARY KEY, product_id INTEGER)"))
        await conn.execute(
            text("CREATE TABLE product_part_stock_movements (id INTEGER PRIMARY KEY, product_part_id INTEGER)")
        )
    await _run(engine)
    await _run(engine)  # idempotent
    async with engine.connect() as conn:
        cols = {r[1] for r in (await conn.execute(text("PRAGMA table_info(product_part_stock_movements)"))).all()}
        assert "stock_item_id" in cols
        for table in ("stock_items", "stock_item_choices", "stock_item_part_counts", "stock_item_movements"):
            assert (await conn.execute(text(f"SELECT COUNT(*) FROM {table}"))).scalar() == 0
        await conn.execute(text("INSERT INTO stock_items (product_id, config_key) VALUES (1, '')"))
        with pytest.raises(IntegrityError):
            await conn.execute(text("INSERT INTO stock_items (product_id, config_key) VALUES (1, '')"))
        with pytest.raises(IntegrityError):
            await conn.execute(text("UPDATE stock_items SET reserved = 5 WHERE product_id = 1"))
        # WS-10: the finished units a line took off the shelf (spec workshop-add-to-order, rule 1).
        line_cols = {r[1] for r in (await conn.execute(text("PRAGMA table_info(project_lines)"))).all()}
        assert "from_finished" in line_cols
        await conn.execute(text("INSERT INTO project_lines (id, product_id) VALUES (1, 1)"))
        assert (await conn.execute(text("SELECT from_finished FROM project_lines WHERE id = 1"))).scalar() == 0
        with pytest.raises(IntegrityError):
            await conn.execute(text("UPDATE project_lines SET from_finished = -1 WHERE id = 1"))
