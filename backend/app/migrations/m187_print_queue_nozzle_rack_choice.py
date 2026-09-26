"""Add ``nozzle_rack_choice`` to ``print_queue`` (upstream #1784, 3954d3a7).

Which of the H2C's six rack positions each filament GROUP prints from, as the
operator picked it in the print dialog: a JSON object ``{group_id: 1-based
position}``. The 3MF states the pick nowhere — upstream sent one plate twice
from BambuStudio with different picks and the two files differed only in float
noise — so without a column a queued job cannot carry it to dispatch.

Stored as the pick, not as the expanded wire ``nozzle_mapping``: that column
means "BambuStudio decided, forward verbatim" (m098), and only the
group-and-position form can be re-checked at dispatch against what the rack
holds then. NULL means "assign the positions for me".

Upstream also adds it to ``print_queue_variants`` (cross-model alternatives,
#671); that table does not exist here.

Nullable TEXT — no Postgres / SQLite divergence. Fresh installs get the column
from the model's ``create_all``; this backfills existing databases.
"""

from backend.app.migrations.helpers import add_column

version = 187
name = "print_queue_nozzle_rack_choice"


async def upgrade(conn):
    await add_column(conn, "print_queue", "nozzle_rack_choice TEXT")
