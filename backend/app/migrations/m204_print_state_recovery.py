"""Addressed operator recovery: row incarnations and durable, non-cascading audit.

Identity backfill is DB-only and deliberately changes no print status or time.
"""

from uuid import uuid4

from sqlalchemy import text

from backend.app.migrations.helpers import add_column

version = 204
name = "print_state_recovery"


async def upgrade(conn):
    for table in ("printer_queues", "print_queue", "print_archives"):
        await add_column(conn, table, "recovery_identity VARCHAR(36)")
        while True:
            ids = (
                (await conn.execute(text(f"SELECT id FROM {table} WHERE recovery_identity IS NULL LIMIT 500")))
                .scalars()
                .all()
            )
            if not ids:
                break
            await conn.execute(
                text(f"UPDATE {table} SET recovery_identity=:identity WHERE id=:id"),
                [{"id": row_id, "identity": str(uuid4())} for row_id in ids],
            )
        await conn.exec_driver_sql(
            f"CREATE UNIQUE INDEX IF NOT EXISTS ix_{table}_recovery_identity ON {table} (recovery_identity)"
        )
    from backend.app.models.print_state_recovery_action import PrintStateRecoveryAction

    await conn.run_sync(lambda sync: PrintStateRecoveryAction.__table__.create(sync, checkfirst=True))
