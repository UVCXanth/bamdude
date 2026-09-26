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
"""

from backend.app.migrations.helpers import add_column, table_exists

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
