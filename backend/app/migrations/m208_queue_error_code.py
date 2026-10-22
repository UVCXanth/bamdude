"""Add ``print_queue.error_code`` — the closed class of a failed row.

A failed queue row says WHY in two parts: ``error_code``, a key of the one
failure vocabulary (``utils/failure_reasons``: a dispatch class such as
``dispatchUploadFailed``, or a physical cause), decided from the typed result
where the attempt ended; and ``error_message``, its human detail. The queue
card, Issues and notifications show the translated class beside the detail,
and nothing reads the class back out of the sentence.

Nullable: rows failed before this migration keep NULL and are shown as before —
they are not reclassified from their text. A Retry clears both. Fresh installs
get the column from the model's ``create_all``; this adds it to existing DBs.
Idempotent.
"""

from backend.app.migrations.helpers import add_column

version = 208
name = "queue_error_code"


async def upgrade(conn):
    await add_column(conn, "print_queue", "error_code VARCHAR(40)")
