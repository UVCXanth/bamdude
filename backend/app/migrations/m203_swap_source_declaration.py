"""An operator's swap declaration of a source, and the jobs' incarnations (swap-source-declaration spec r3 §3, plan T9.1).

- ``print_archives.swap_source_declaration`` / ``library_files.swap_source_declaration``: nullable JSON, a source's
  declaration for a FUTURE use -- apart from an archive's executed-run fact, and the hash-bound carrier beside a
  library row's bool. Only ``services/swap_compatibility`` reads and writes them.
- ``print_queue.swap_declaration_identity`` / ``auto_queue_items.swap_declaration_identity``: a job's incarnation for
  the refresh's compare-and-set -- a reused integer id is another job. Unique; the seed gives every existing job one,
  in batches. The SOURCES get none: their equality is content-bound (§5).
- ``swap_source_declaration_audit``: the append-only journal, created here as well as by ``create_all`` -- an import
  resumes the chain on a schema built from its own file, not from the models.

DDL and a DB-only seed: no file is read, nothing is hashed.
"""

import uuid

from sqlalchemy import text

from backend.app.migrations.helpers import add_column, json_column_type, table_exists

version = 203
name = "swap_source_declaration"

JOB_TABLES = ("print_queue", "auto_queue_items")
BATCH = 500


async def upgrade(conn):
    sqlite = conn.dialect.name == "sqlite"
    json_type = "TEXT" if sqlite else json_column_type()
    for table in ("print_archives", "library_files"):
        await add_column(conn, table, f"swap_source_declaration {json_type}")
    for table in JOB_TABLES:
        await add_column(conn, table, "swap_declaration_identity VARCHAR(36)")
        await conn.exec_driver_sql(
            f"CREATE UNIQUE INDEX IF NOT EXISTS ix_{table}_swap_declaration_identity "
            f"ON {table} (swap_declaration_identity)"
        )

    if not await table_exists(conn, "swap_source_declaration_audit"):
        pk = "INTEGER PRIMARY KEY AUTOINCREMENT" if sqlite else "SERIAL PRIMARY KEY"
        ts = "DATETIME" if sqlite else "TIMESTAMP"
        await conn.exec_driver_sql(
            f"""
            CREATE TABLE swap_source_declaration_audit (
                id {pk},
                operation_id VARCHAR(36) NOT NULL UNIQUE,
                action VARCHAR(16) NOT NULL,
                source_kind VARCHAR(16) NOT NULL,
                source_id INTEGER NOT NULL,
                sha256 VARCHAR(64),
                old_value BOOLEAN,
                new_value BOOLEAN,
                declaration_id VARCHAR(36),
                previous_declaration_id VARCHAR(36),
                actor_id INTEGER,
                actor_label VARCHAR(255) NOT NULL DEFAULT '',
                actor_kind VARCHAR(16) NOT NULL,
                revision_before VARCHAR(64),
                revision_after VARCHAR(64),
                request_digest VARCHAR(64),
                jobs {json_type},
                created_at {ts} NOT NULL
            )
            """
        )
    await conn.exec_driver_sql(
        "CREATE INDEX IF NOT EXISTS ix_swap_source_declaration_audit_source "
        "ON swap_source_declaration_audit (source_kind, source_id)"
    )


async def seed(session_factory):
    """Give every existing job its incarnation, once, in batches -- named columns only."""
    for table in JOB_TABLES:
        while True:
            async with session_factory() as db:
                ids = (
                    (
                        await db.execute(
                            text(
                                f"SELECT id FROM {table} WHERE swap_declaration_identity IS NULL ORDER BY id LIMIT :n"
                            ),
                            {"n": BATCH},
                        )
                    )
                    .scalars()
                    .all()
                )
                if not ids:
                    break
                for job_id in ids:
                    await db.execute(
                        text(f"UPDATE {table} SET swap_declaration_identity = :identity WHERE id = :id"),
                        {"identity": str(uuid.uuid4()), "id": job_id},
                    )
                await db.commit()
