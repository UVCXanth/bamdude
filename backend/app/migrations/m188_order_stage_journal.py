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

- **WS-08 (spec workshop-product-variants) — variants and line configuration.**
  ``product_variant_groups`` / ``product_variant_options`` (AUTOINCREMENT) — a
  product's choices; ``product_parts.variant_option_id`` — a part in the kit
  only when its option is chosen. ``project_lines.mode`` (``product`` |
  ``parts``) and ``config_key``; ``project_line_choices`` (the option a line
  chose, written for every group) and ``project_line_part_counts`` (changed
  per-unit counts, or a parts line's wanted counts). Existing lines are
  standard product lines: no group exists yet, so nothing is seeded and their
  figures do not change. ``product_variant_groups.default_option_id`` carries
  no FK here — a circular one needs a table rebuild on SQLite — and the routes
  keep it pointing at one of the group's own options.

- **WS-09 (spec workshop-finished-goods) — finished goods.** ``stock_items``
  (AUTOINCREMENT — the code ``SK-0003`` is derived from the id): one position per
  product configuration, ``UNIQUE(product_id, config_key)``, the balance as the
  columns ``on_hand`` / ``reserved`` with CHECKs (never below zero, reserved never
  above on hand), a location and a minimum. ``stock_item_choices`` /
  ``stock_item_part_counts`` — the position's configuration, the same shape as
  an order line's and written by the same writer. ``stock_item_movements``
  (AUTOINCREMENT) — the history the columns always equal the sum of.
  ``project_lines.from_finished`` (WS-10, spec workshop-add-to-order) — finished
  units a line took off the finished-goods shelf, issued ones included; written
  only by ``services/finished_stock.py`` with the movement that explains it.
  ``product_part_stock_movements.stock_item_id`` — the position assembled parts
  went into. New tables only; nothing is seeded.
- WS-11 (spec workshop-order-issue): ``stock_issues`` (AUTOINCREMENT: WS-12 derives
  a dispatch note's code from its id) — an issue of goods with a snapshot of its
  customer, recipient and delivery and an optional waybill; ``project_lines.assembled
  / received / issued / returned`` (written only by services/finished_stock.py);
  ``project_line_part_stock`` (a parts line's counters, only services/part_stock.py);
  ``stock_issue_id`` on both ledgers' movements.
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

    # spec workshop-product-variants (WS-08): variant groups and options, the
    # part's option, and the line's configuration.
    if await table_exists(conn, "products"):
        if not await table_exists(conn, "product_variant_groups"):
            await conn.exec_driver_sql(
                f"""
                CREATE TABLE product_variant_groups (
                    id {pk},
                    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
                    name VARCHAR(128) NOT NULL,
                    position INTEGER NOT NULL DEFAULT 0,
                    default_option_id INTEGER
                )
                """
            )
        await conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_product_variant_groups_product_id ON product_variant_groups (product_id)"
        )
        if not await table_exists(conn, "product_variant_options"):
            await conn.exec_driver_sql(
                f"""
                CREATE TABLE product_variant_options (
                    id {pk},
                    group_id INTEGER NOT NULL REFERENCES product_variant_groups(id) ON DELETE CASCADE,
                    name VARCHAR(128) NOT NULL,
                    position INTEGER NOT NULL DEFAULT 0
                )
                """
            )
        await conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_product_variant_options_group_id ON product_variant_options (group_id)"
        )
    if await table_exists(conn, "product_parts"):
        await add_column(
            conn,
            "product_parts",
            "variant_option_id INTEGER REFERENCES product_variant_options(id) ON DELETE SET NULL",
        )
        await conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_product_parts_variant_option_id ON product_parts (variant_option_id)"
        )
    if await table_exists(conn, "project_lines"):
        await add_column(conn, "project_lines", "mode VARCHAR(8) NOT NULL DEFAULT 'product'")
        await add_column(conn, "project_lines", "config_key VARCHAR(512) NOT NULL DEFAULT ''")
        # WS-10 (spec workshop-add-to-order, rule 1).
        # Named as the model names it, so fresh, upgraded and imported installs agree.
        await add_column(
            conn,
            "project_lines",
            "from_finished INTEGER NOT NULL DEFAULT 0 "
            "CONSTRAINT ck_project_lines_from_finished CHECK (from_finished >= 0)",
        )
        if not await table_exists(conn, "project_line_choices"):
            await conn.exec_driver_sql(
                """
                CREATE TABLE project_line_choices (
                    line_id INTEGER NOT NULL REFERENCES project_lines(id) ON DELETE CASCADE,
                    group_id INTEGER NOT NULL REFERENCES product_variant_groups(id) ON DELETE CASCADE,
                    option_id INTEGER NOT NULL REFERENCES product_variant_options(id),
                    PRIMARY KEY (line_id, group_id)
                )
                """
            )
        await conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_project_line_choices_option_id ON project_line_choices (option_id)"
        )
        if not await table_exists(conn, "project_line_part_counts"):
            await conn.exec_driver_sql(
                """
                CREATE TABLE project_line_part_counts (
                    line_id INTEGER NOT NULL REFERENCES project_lines(id) ON DELETE CASCADE,
                    part_id INTEGER NOT NULL REFERENCES product_parts(id) ON DELETE CASCADE,
                    qty INTEGER NOT NULL,
                    PRIMARY KEY (line_id, part_id)
                )
                """
            )
        await conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_project_line_part_counts_part_id ON project_line_part_counts (part_id)"
        )

    # spec workshop-finished-goods (WS-09): finished goods, one position per configuration.
    if await table_exists(conn, "products"):
        if not await table_exists(conn, "stock_items"):
            await conn.exec_driver_sql(
                f"""
                CREATE TABLE stock_items (
                    id {pk},
                    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
                    config_key VARCHAR(512) NOT NULL DEFAULT '',
                    on_hand INTEGER NOT NULL DEFAULT 0,
                    reserved INTEGER NOT NULL DEFAULT 0,
                    location VARCHAR(64),
                    min_qty INTEGER NOT NULL DEFAULT 0,
                    created_at {ts} NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    CONSTRAINT uq_stock_items_product_config UNIQUE (product_id, config_key),
                    CONSTRAINT ck_stock_items_on_hand CHECK (on_hand >= 0),
                    CONSTRAINT ck_stock_items_reserved CHECK (reserved >= 0),
                    CONSTRAINT ck_stock_items_reserved_le_on_hand CHECK (reserved <= on_hand)
                )
                """
            )
        await conn.exec_driver_sql("CREATE INDEX IF NOT EXISTS ix_stock_items_product_id ON stock_items (product_id)")
        if not await table_exists(conn, "stock_item_choices"):
            await conn.exec_driver_sql(
                """
                CREATE TABLE stock_item_choices (
                    item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
                    group_id INTEGER NOT NULL REFERENCES product_variant_groups(id) ON DELETE CASCADE,
                    option_id INTEGER NOT NULL REFERENCES product_variant_options(id),
                    PRIMARY KEY (item_id, group_id)
                )
                """
            )
        await conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_stock_item_choices_option_id ON stock_item_choices (option_id)"
        )
        if not await table_exists(conn, "stock_item_part_counts"):
            await conn.exec_driver_sql(
                """
                CREATE TABLE stock_item_part_counts (
                    item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
                    part_id INTEGER NOT NULL REFERENCES product_parts(id) ON DELETE CASCADE,
                    qty INTEGER NOT NULL,
                    PRIMARY KEY (item_id, part_id)
                )
                """
            )
        await conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_stock_item_part_counts_part_id ON stock_item_part_counts (part_id)"
        )
        if not await table_exists(conn, "stock_item_movements"):
            await conn.exec_driver_sql(
                f"""
                CREATE TABLE stock_item_movements (
                    id {pk},
                    item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
                    kind VARCHAR(16) NOT NULL,
                    delta_on_hand INTEGER NOT NULL DEFAULT 0,
                    delta_reserved INTEGER NOT NULL DEFAULT 0,
                    note TEXT,
                    customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
                    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
                    project_line_id INTEGER REFERENCES project_lines(id) ON DELETE SET NULL,
                    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                    created_at {ts} NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
        await conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_stock_item_movements_item_created ON stock_item_movements (item_id, created_at)"
        )
        await conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_stock_item_movements_created_id ON stock_item_movements (created_at, id)"
        )
    if await table_exists(conn, "product_part_stock_movements"):
        await add_column(
            conn,
            "product_part_stock_movements",
            "stock_item_id INTEGER REFERENCES stock_items(id) ON DELETE SET NULL",
        )
        await conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_product_part_stock_movements_stock_item_id"
            " ON product_part_stock_movements (stock_item_id)"
        )

    # spec workshop-order-issue (WS-11): issues, the line counters, parts-line counters.
    # Gated like the finished-goods block above: an install that has products has the rest.
    if await table_exists(conn, "products"):
        if not await table_exists(conn, "stock_issues"):
            await conn.exec_driver_sql(
                f"""
                CREATE TABLE stock_issues (
                    id {pk},
                    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
                    customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
                    customer_name VARCHAR(255) NOT NULL DEFAULT '',
                    recipient_name VARCHAR(255),
                    recipient_phone VARCHAR(255),
                    delivery_method VARCHAR(255),
                    delivery_details VARCHAR(255),
                    waybill VARCHAR(24),
                    note TEXT,
                    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                    created_at {ts} NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
        await conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_stock_issues_customer_created ON stock_issues (customer_id, created_at)"
        )
        await conn.exec_driver_sql("CREATE INDEX IF NOT EXISTS ix_stock_issues_project_id ON stock_issues (project_id)")
    if await table_exists(conn, "project_lines"):
        for col in ("assembled", "received", "issued", "returned"):
            await add_column(
                conn,
                "project_lines",
                f"{col} INTEGER NOT NULL DEFAULT 0 CONSTRAINT ck_project_lines_{col} CHECK ({col} >= 0)",
            )
        if not await table_exists(conn, "project_line_part_stock"):
            await conn.exec_driver_sql(
                """
                CREATE TABLE project_line_part_stock (
                    line_id INTEGER NOT NULL REFERENCES project_lines(id) ON DELETE CASCADE,
                    part_id INTEGER NOT NULL REFERENCES product_parts(id) ON DELETE CASCADE,
                    received INTEGER NOT NULL DEFAULT 0,
                    issued INTEGER NOT NULL DEFAULT 0,
                    returned INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (line_id, part_id),
                    CONSTRAINT ck_project_line_part_stock_received CHECK (received >= 0),
                    CONSTRAINT ck_project_line_part_stock_issued CHECK (issued >= 0),
                    CONSTRAINT ck_project_line_part_stock_returned CHECK (returned >= 0)
                )
                """
            )
    for table in ("stock_item_movements", "product_part_stock_movements"):
        if await table_exists(conn, table) and await table_exists(conn, "stock_issues"):
            await add_column(conn, table, "stock_issue_id INTEGER REFERENCES stock_issues(id) ON DELETE SET NULL")
            await conn.exec_driver_sql(
                f"CREATE INDEX IF NOT EXISTS ix_{table}_stock_issue_id ON {table} (stock_issue_id)"
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
