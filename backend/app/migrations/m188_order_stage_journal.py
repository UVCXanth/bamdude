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
"""

from backend.app.migrations.helpers import add_column, table_exists

version = 188
name = "order_stage_journal"


async def upgrade(conn):
    sqlite = conn.dialect.name == "sqlite"
    pk = "INTEGER PRIMARY KEY AUTOINCREMENT" if sqlite else "SERIAL PRIMARY KEY"
    ts = "DATETIME" if sqlite else "TIMESTAMP"

    await add_column(conn, "projects", "stage VARCHAR(16) NOT NULL DEFAULT 'prep'")
    await add_column(conn, "projects", "responsible_id INTEGER REFERENCES users(id) ON DELETE SET NULL")
    await conn.exec_driver_sql("CREATE INDEX IF NOT EXISTS ix_projects_responsible_id ON projects (responsible_id)")

    if not await table_exists(conn, "project_events"):
        await conn.exec_driver_sql(
            f"""
            CREATE TABLE project_events (
                id {pk},
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                created_at {ts} DEFAULT CURRENT_TIMESTAMP,
                user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                user_name VARCHAR(100),
                kind VARCHAR(40) NOT NULL,
                payload JSON
            )
            """
        )
    await conn.exec_driver_sql(
        "CREATE INDEX IF NOT EXISTS ix_project_events_project_created ON project_events (project_id, created_at)"
    )
