"""What an order has in the queue — one condition per tier (spec workshop-order-queue, rule 5).

The order's figures count these rows (``order_metrics._load_queued`` and
``prints_in_progress``) and ``GET /projects/{id}/queue`` lists them, both through
the conditions below — so the tile and the section cannot disagree. The two
queue tiers are the printers' queues and, above them, the auto-queue whose
distributor has not handed the job to a printer yet.
"""

from sqlalchemy import func

from backend.app.models.archive import PrintArchive
from backend.app.models.auto_queue import AutoQueueItem
from backend.app.models.print_queue import PrintQueueItem

RUNNING_STATUS = "printing"


def live_archive_conditions() -> tuple:
    """An archive that counts as one of the order's prints: not trashed, and not a
    dispatch that never reached the printer."""
    return (
        func.coalesce(PrintArchive.extra_data["dispatch_aborted"].as_boolean(), False).is_(False),
        PrintArchive.deleted_at.is_(None),
    )


def queued_printer_row_conditions() -> tuple:
    """A printer-queue row still waiting for its printer."""
    return (PrintQueueItem.status == "pending",)


def awaiting_auto_row_conditions() -> tuple:
    """An auto-queue row the distributor has not handed to a printer yet — once
    handed, it IS the printer-queue row and is counted there, never twice."""
    return (AutoQueueItem.status == "pending", AutoQueueItem.assigned_to_item_id.is_(None))
