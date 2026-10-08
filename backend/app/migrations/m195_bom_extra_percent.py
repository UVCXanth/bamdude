"""Optional BOM extras; existing products and order lines retain zero extra demand.

The catalog default is copied into new order lines. Keeping the snapshot on the
line prevents a catalog edit from changing a dispatched or partly fulfilled order.
No stock counter, ledger or queue schema is introduced.
"""

from backend.app.migrations.helpers import add_column, json_column_type

version = 195
name = "bom_extra_percent"


async def upgrade(conn):
    await add_column(conn, "product_parts", "extra_percent FLOAT NOT NULL DEFAULT 0")
    await add_column(conn, "project_lines", f"extra_percentages {json_column_type()} NOT NULL DEFAULT '{{}}'")
