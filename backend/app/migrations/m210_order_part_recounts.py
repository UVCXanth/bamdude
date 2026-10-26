"""Separate counted output corrections from archive defects and shelf movements.

The signed projection belongs to a line; the existing order journal records
each before/after, reason and actor. NULL leaves every existing figure intact.
"""

from backend.app.migrations.helpers import add_column

version = 210
name = "order_part_recounts"


async def upgrade(conn):
    await add_column(conn, "project_lines", "part_count_adjustments JSON")
