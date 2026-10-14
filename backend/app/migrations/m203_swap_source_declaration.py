"""An operator's swap declaration of a source, and the jobs' incarnations (swap-source-declaration spec r3 §3, plan T9.1).

- ``print_archives.swap_source_declaration`` / ``library_files.swap_source_declaration``: nullable JSON, a source's
  declaration for a FUTURE use -- apart from an archive's executed-run fact, and the hash-bound carrier beside a
  library row's bool. Only ``services/swap_compatibility`` reads and writes them.
- ``print_queue.swap_declaration_identity`` / ``auto_queue_items.swap_declaration_identity``: a job's incarnation for
  the refresh's compare-and-set -- a reused integer id is another job. Unique; the seed gives every existing job one,
  in batches. The SOURCES get none: their equality is content-bound (§5).
- ``swap_source_declaration_audit``: the append-only journal, created here as well as by ``create_all`` -- an import
  resumes the chain on a schema built from its own file, not from the models.
- The backfill (§8, plan T9.3): a legacy EXTERNAL row's ``swap_compatible = False`` without a carrier was the old
  scan's default, not a declaration. Every such row with a valid hash and a path gets the classification the source
  reader answers for it -- by the basename of its persisted ``file_path`` on the share -- persisted as a hash-bound
  ``classifier`` carrier, its bool and, for True, the ``swap`` system tag (cache and association both), so the tag
  filter and the badges agree with the effective fact. A legacy True, a managed row, a row without a valid hash or
  path and any row that already has a carrier are left exactly as they are.

DDL and a DB-only seed: no file is read, nothing is hashed.
"""

import json
import re
import uuid
from datetime import datetime, timezone

from sqlalchemy import text

from backend.app.migrations.helpers import add_column, as_json, json_column_type, table_exists

version = 203
name = "swap_source_declaration"

JOB_TABLES = ("print_queue", "auto_queue_items")
BATCH = 500

# The classification as it stood when this migration was written -- frozen here, never imported from the runtime
# classifier, so a later change to that one never changes what this backfill did.
_MARKER = re.compile(r"\.swaps?\.", re.IGNORECASE)
_SHA256 = re.compile(r"[0-9a-f]{64}")


def _declares_swap(path: str) -> bool:
    return _MARKER.search(re.split(r"[\\/]", path)[-1]) is not None


def _tags(raw) -> list:
    if isinstance(raw, str):
        raw = json.loads(raw)
    return list(raw) if isinstance(raw, list) else []


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
    await _seed_job_identities(session_factory)
    await _backfill_legacy_external_defaults(session_factory)


async def _seed_job_identities(session_factory):
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


async def _backfill_legacy_external_defaults(session_factory):
    """§8's classification of every legacy external default False, persisted in batches by id; each row is written
    under a compare-and-set on what was read, so a row a declaration reached first is left to it, and a rerun finds
    nothing to do."""
    last_id = 0
    while True:
        async with session_factory() as db:
            rows = (
                await db.execute(
                    text(
                        "SELECT id, file_path, file_hash, file_tags FROM library_files "
                        "WHERE id > :last AND swap_source_declaration IS NULL "
                        "AND is_external = :external AND swap_compatible = :legacy "
                        "ORDER BY id LIMIT :n"
                    ),
                    {"last": last_id, "external": True, "legacy": False, "n": BATCH},
                )
            ).all()
            if not rows:
                break
            last_id = rows[-1].id
            swap_tag_id = (
                await db.execute(
                    text("SELECT id FROM library_tags WHERE code = :code AND is_system = :system"),
                    {"code": "swap", "system": True},
                )
            ).scalar_one_or_none()
            for row in rows:
                if not (isinstance(row.file_hash, str) and _SHA256.fullmatch(row.file_hash)):
                    continue
                if not (isinstance(row.file_path, str) and row.file_path.strip()):
                    continue
                value = _declares_swap(row.file_path)
                carrier = json.dumps({"version": 1, "value": value, "sha256": row.file_hash, "origin": "classifier"})
                params = {
                    "id": row.id,
                    "carrier": carrier,
                    "value": value,
                    "external": True,
                    "legacy": False,
                    "file_hash": row.file_hash,
                    "file_path": row.file_path,
                }
                assignments = f"swap_source_declaration = {as_json(':carrier')}, swap_compatible = :value"
                if value:
                    tags = _tags(row.file_tags)
                    if "swap" not in tags:
                        # Where the runtime's tag derivation puts it: before provenance.
                        tags.insert(tags.index("makerworld") if "makerworld" in tags else len(tags), "swap")
                    params["tags"] = json.dumps(tags)
                    assignments += f", file_tags = {as_json(':tags')}"
                written = await db.execute(
                    text(
                        f"UPDATE library_files SET {assignments} "
                        "WHERE id = :id AND swap_source_declaration IS NULL AND is_external = :external "
                        "AND swap_compatible = :legacy AND file_hash = :file_hash AND file_path = :file_path"
                    ),
                    params,
                )
                if written.rowcount != 1 or not value or swap_tag_id is None:
                    continue
                already = (
                    await db.execute(
                        text("SELECT 1 FROM library_file_tags WHERE file_id = :file AND tag_id = :tag"),
                        {"file": row.id, "tag": swap_tag_id},
                    )
                ).first()
                if already is None:
                    await db.execute(
                        text("INSERT INTO library_file_tags (file_id, tag_id, created_at) VALUES (:file, :tag, :at)"),
                        {"file": row.id, "tag": swap_tag_id, "at": datetime.now(timezone.utc).replace(tzinfo=None)},
                    )
            await db.commit()
