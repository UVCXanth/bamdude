"""Keep order-local printer restrictions without unlinking product plates.

NULL retains the entire existing farm. The JSON policy intersects actual
printer models and optional printer ids; it never reserves machines globally.
"""

from backend.app.migrations.helpers import add_column

version = 209
name = "order_printer_resources"


async def upgrade(conn):
    await add_column(conn, "projects", "printer_resources JSON")
