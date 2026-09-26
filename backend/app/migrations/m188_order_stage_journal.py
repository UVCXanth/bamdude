"""Order stage, responsible user and the order journal (spec workshop-order-stage).

- ``projects.stage`` — prep | printing | qc, NOT NULL, default prep. Set by hand
  only (owner, 2026-09-26: no derived stage — see the spec's «Відкинуте»); an
  existing order starts in preparation and the operator moves it. «Done» is not
  stored: it is ``status='completed'``.
- ``projects.responsible_id`` — the user responsible for the order; SET NULL in
  code when the user is deleted (SQLite runs no FK actions).
- ``project_events`` — the order journal, written only by
  ``services/order_journal.py``. AUTOINCREMENT on SQLite so an id is never
  handed out twice. No backfill: the journal starts empty.

The workshop feature keeps ONE migration (owner, 2026-09-26), so later tasks
add here while the branch is unreleased:

- **WS-06 (spec workshop-order-queue) — indexes by order.** The order figures
  (``order_metrics._load_queued``, both archive loaders) and the order's queue
  section (``GET /projects/{id}/queue``) filter both queue tiers and the
  archives by ``project_id``, which had no index. ``EXPLAIN QUERY PLAN`` on a
  copy of a real farm's SQLite (888 archives, 584 of them filed; both queues
  empty at the snapshot), m168's rule — only what changed a plan:
  * ``print_queue`` / ``auto_queue_items`` — ``SCAN`` → ``SEARCH USING INDEX
    (project_id=? AND status=?)`` for the figures' counts and the section's rows;
  * ``print_archives`` — ``SEARCH USING INDEX ix_print_archives_deleted_at`` +
    ``USE TEMP B-TREE FOR ORDER BY`` → ``SEARCH USING INDEX
    ix_print_archives_project_created (project_id=?)``, the sort gone.
  A table missing here (the migration tests build only what they need) is
  skipped; ``create_all`` gives fresh installs the same indexes from the models.

- **WS-07 (spec workshop-product-catalog) — the product catalog.** ``products``
  gains ``sku`` (+ its case-free ``sku_key``, unique when set), ``version``,
  ``category_id`` and ``status`` (``draft`` | ``ready``). Two tables:
  ``product_categories`` — the category directory (AUTOINCREMENT, a unique
  ``name_key``) — and ``product_facets`` — a product's plate materials,
  colours and printer models, STORED and written only by
  ``services/product_facets.py``. Seeds: a product that already has a part
  and a plate is ``ready`` (owner, 2026-09-26: products already printing stay
  printable) — a plate of a trashed file is no plate, as on every list; the rest
  stay ``draft``. The status seed only ever promotes a qualifying draft, so it
  is safe to run again. A facet row names its file, and the catalog skips a
  trashed file's rows (owner, 2026-09-27); a ``product_facets`` from before that
  column is dropped and rebuilt — it is derived, and the seed refills it. The
  two case-free keys are wide enough for casefold(), which may lengthen text
  threefold.
"""

from backend.app.migrations.helpers import add_column, column_exists, table_exists

version = 188
name = "order_stage_journal"


async def upgrade(conn):
    sqlite = conn.dialect.name == "sqlite"
    pk = "INTEGER PRIMARY KEY AUTOINCREMENT" if sqlite else "SERIAL PRIMARY KEY"
    ts = "DATETIME" if sqlite else "TIMESTAMP"
    # What ``helpers.json_column_type`` answers, read off THIS connection: SQLite
    # has no JSON storage class (TEXT, as create_all makes it), PostgreSQL does.
    json_type = "TEXT" if sqlite else "JSON"

    await add_column(conn, "projects", "stage VARCHAR(16) NOT NULL DEFAULT 'prep'")
    await add_column(conn, "projects", "responsible_id INTEGER REFERENCES users(id) ON DELETE SET NULL")
    await conn.exec_driver_sql("CREATE INDEX IF NOT EXISTS ix_projects_responsible_id ON projects (responsible_id)")

    if not await table_exists(conn, "project_events"):
        await conn.exec_driver_sql(
            f"""
            CREATE TABLE project_events (
                id {pk},
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                created_at {ts} NOT NULL DEFAULT CURRENT_TIMESTAMP,
                user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                user_name VARCHAR(100),
                kind VARCHAR(40) NOT NULL,
                payload {json_type} NOT NULL
            )
            """
        )
    await conn.exec_driver_sql(
        "CREATE INDEX IF NOT EXISTS ix_project_events_project_created ON project_events (project_id, created_at)"
    )

    # spec workshop-order-queue (WS-06; owner: one migration for the whole
    # feature): the order figures and the order's queue section filter both
    # queue tiers and the archives by order. Measured plans: see the docstring.
    for table, ddl in (
        ("print_queue", "CREATE INDEX IF NOT EXISTS ix_print_queue_project_status ON print_queue (project_id, status)"),
        (
            "auto_queue_items",
            "CREATE INDEX IF NOT EXISTS ix_auto_queue_items_project_status ON auto_queue_items (project_id, status)",
        ),
        (
            "print_archives",
            "CREATE INDEX IF NOT EXISTS ix_print_archives_project_created ON print_archives (project_id, created_at)",
        ),
    ):
        if await table_exists(conn, table):
            await conn.exec_driver_sql(ddl)

    # spec workshop-product-catalog (WS-07): catalog fields, the category
    # directory and the stored plate facets.
    if await table_exists(conn, "products"):
        if not await table_exists(conn, "product_categories"):
            await conn.exec_driver_sql(
                f"""
                CREATE TABLE product_categories (
                    id {pk},
                    name VARCHAR(128) NOT NULL,
                    name_key VARCHAR(512) NOT NULL UNIQUE,
                    created_at {ts} NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
        await add_column(conn, "products", "sku VARCHAR(64)")
        await add_column(conn, "products", "sku_key VARCHAR(255)")
        await add_column(conn, "products", "version VARCHAR(64)")
        await add_column(conn, "products", "category_id INTEGER REFERENCES product_categories(id) ON DELETE SET NULL")
        await add_column(conn, "products", "status VARCHAR(16) NOT NULL DEFAULT 'draft'")
        await conn.exec_driver_sql("CREATE UNIQUE INDEX IF NOT EXISTS ix_products_sku_key ON products (sku_key)")
        await conn.exec_driver_sql("CREATE INDEX IF NOT EXISTS ix_products_category_id ON products (category_id)")
        if await table_exists(conn, "product_facets") and not await column_exists(
            conn, "product_facets", "library_file_id"
        ):
            await conn.exec_driver_sql("DROP TABLE product_facets")
        if not await table_exists(conn, "product_facets"):
            await conn.exec_driver_sql(
                """
                CREATE TABLE product_facets (
                    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
                    library_file_id INTEGER NOT NULL REFERENCES library_files(id) ON DELETE CASCADE,
                    kind VARCHAR(16) NOT NULL,
                    value VARCHAR(64) NOT NULL,
                    PRIMARY KEY (product_id, library_file_id, kind, value)
                )
                """
            )
        await conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_product_facets_kind_value ON product_facets (kind, value)"
        )
        # Products already printing stay ready; only incomplete ones become drafts
        # (owner, 2026-09-26). Idempotent: only ever promotes drafts that qualify.
        if all([await table_exists(conn, t) for t in ("product_parts", "product_plates", "library_files")]):
            await conn.exec_driver_sql(
                "UPDATE products SET status = 'ready' WHERE status = 'draft'"
                " AND EXISTS (SELECT 1 FROM product_parts pp WHERE pp.product_id = products.id)"
                " AND EXISTS (SELECT 1 FROM product_plates pl JOIN library_files lf ON lf.id = pl.library_file_id"
                " WHERE pl.product_id = products.id AND lf.deleted_at IS NULL)"
            )


async def seed(session_factory):
    """WS-07: the stored facets of every existing product, once (spec workshop-product-catalog, rule 4).

    The writer reads plates and files by column and inserts named columns only,
    so it holds on a database at this migration's level.
    """
    from backend.app.services import product_facets

    async with session_factory() as db:
        await product_facets.refresh_all(db)
        await db.commit()
