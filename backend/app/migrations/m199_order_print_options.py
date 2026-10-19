"""Order toggles and immutable auto-job overrides; NULL retains legacy profiles.

Only explicit overrides are copied to new router jobs. No backfill: old jobs
must keep resolving operator defaults. Per-printer jobs already store the
resolved calibration modes and preheat fields, so need no second representation.
"""

from backend.app.migrations.helpers import add_column, json_column_type

version = 199
name = "order_print_options"


async def upgrade(conn):
    for table in ("projects", "auto_queue_items"):
        await add_column(conn, table, f"order_print_options {json_column_type()}")
