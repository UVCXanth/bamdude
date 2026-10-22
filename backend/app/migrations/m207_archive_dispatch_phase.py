"""Add ``print_archives.dispatch_phase`` and ``dispatch_boot_id`` — how far our dispatch got.

An execution archive is inserted ``prepared`` with the boot of the process that
owns it, flips to ``sending`` in a commit immediately before the start command,
to ``sent`` once the command was queued for publish and to ``accepted`` once the
printer was seen running it — each step a compare-and-set, so no late writer can
move a phase back. A restarted process reads it to tell a dispatch that provably
sent nothing (``prepared`` of an ended owner) from one that may have reached the
printer, and the Info recovery shows the operator which is which.

Both columns are nullable, and NULL means *unknown*: archives from before this
migration, external prints and adopted ones are not backfilled — no name, age or
status proves how far a dispatch went. Fresh installs get the columns from the
model's ``create_all``; this adds them to existing DBs. Idempotent.
"""

from backend.app.migrations.helpers import add_column

version = 207
name = "archive_dispatch_phase"


async def upgrade(conn):
    await add_column(conn, "print_archives", "dispatch_phase VARCHAR(16)")
    await add_column(conn, "print_archives", "dispatch_boot_id VARCHAR(36)")
