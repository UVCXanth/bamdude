"""Serialize a sensor bind with deletion of its target on both databases."""

from sqlalchemy import text

from backend.app.core.db_dialect import is_postgres

_TABLES = {"printers", "printer_locations", "locations"}


async def lock_sensor_target(db, table: str, target_id: int) -> bool:
    if table not in _TABLES:
        raise ValueError("Unknown sensor target")
    if is_postgres():
        statement = text(f"SELECT id FROM {table} WHERE id = :id FOR UPDATE")
    else:
        # SQLite has no row locks. A no-op write obtains the writer lock without
        # touching updated_at; the existence check is then serialized with delete.
        statement = text(f"UPDATE {table} SET id = id WHERE id = :id RETURNING id")
    return (await db.execute(statement, {"id": target_id})).scalar_one_or_none() is not None
