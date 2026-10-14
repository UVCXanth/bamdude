"""Bookkeeping for an attempt refused before MQTT publish; never a failed print."""

import json
from datetime import datetime, timezone

from sqlalchemy import func, update

from backend.app.models.archive import PrintArchive
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer_queue import PrinterQueue
from backend.app.services.filament_intake import routing_detail
from backend.app.services.filament_policy import decode
from backend.app.services.filament_routing import RoutingDeferred
from backend.app.services.queue_counters import update_queue_counters
from backend.app.services.queue_sources import QueueSourceBusy, QueueSourceError
from backend.app.services.source_io import SOURCE_FAILURES

#: What a refused attempt becomes, named by the refusal itself rather than guessed from its reason
#: (swap-source-lifecycle spec r4 §6). ``failed``: before dispatch, ``gate_acknowledged``, only a manual Retry.
#: ``retry_later``: back to pending with its own wait reason, the scheduler's bounded cooldown deciding when.
DISPOSITION_FAILED = "failed"
DISPOSITION_RETRY_LATER = "retry_later"
#: The wait reason of a queued job whose source copy found the spool busy.
SOURCE_CAPTURE_WAIT_CODE = "source_capture"


class SourceCaptureDeferred(RoutingDeferred):
    """A dispatch-time copy of the source was refused; ``disposition`` says what the job becomes."""

    def __init__(self, reason: str, *, disposition: str):
        super().__init__(reason)
        self.disposition = disposition


class SwapSourceRefused(SourceCaptureDeferred):
    """D2 of the swap-source-lifecycle spec: our swap macros were asked for a source whose declaration is unknown.

    Failed before dispatch, like a refused copy -- ``gate_acknowledged``, no waiting reason, the job's events kept
    -- and never a silent strip of what the operator asked for.
    """

    def __init__(self, reason: str):
        super().__init__(reason, disposition=DISPOSITION_FAILED)


def capture_refusal(exc: QueueSourceError, *, queued: bool) -> SourceCaptureDeferred:
    """The class of the refusal decides, never its text or an HTTP status (§6's table).

    A busy or replaced spool is "ask again later" -- for a queued job only, which then waits; a direct print never
    retries by itself. A timeout, an unreadable / changed / invalid source, a spool without room or a failed write
    end the attempt before dispatch with their own reason, and wait for the operator's Retry.
    """
    retry = queued and isinstance(exc, QueueSourceBusy)
    return SourceCaptureDeferred(exc.reason, disposition=DISPOSITION_RETRY_LATER if retry else DISPOSITION_FAILED)


def dispatched_archive_filter():
    return func.coalesce(PrintArchive.extra_data["dispatch_aborted"].as_boolean(), False).is_(False)


async def abort_execution_archive(db, archive_id, reason):
    if archive_id is None:
        return
    archive = await db.get(PrintArchive, archive_id)
    if archive is not None and archive.status == "printing":
        archive.status = "cancelled"
        archive.extra_data = {**(archive.extra_data or {}), "dispatch_aborted": True, "dispatch_abort_reason": reason}
        archive.completed_at = datetime.now(timezone.utc)


async def defer_claim(
    db,
    *,
    item_id,
    started_at,
    reason,
    revision=None,
    direct=False,
    source_archive_id=None,
    source_library_file_id=None,
    restore_source=False,
    disposition=None,
):
    """CAS only our active attempt. Cancelled/deleted/reclaimed rows stay untouched.

    ``disposition`` is an explicit answer from a refusal that knows what it is (a source copy at dispatch,
    :func:`capture_refusal`): ``failed`` ends the attempt whatever the reason, ``retry_later`` sends a queued job
    back to pending under its own wait reason. Neither is a routing state, so the routing intent is left as it
    is. Without one, a caller gets exactly the behaviour it always had.
    """
    item = await db.get(PrintQueueItem, item_id)
    if item is None or started_at is None:
        return False
    source_failed = not direct and reason in SOURCE_FAILURES
    # A refused direct print never starts on its own (no future autostart), so its
    # row is a failure with a Retry — not «cancelled», which reads as the operator's
    # own act (spec direct-print-silent-cancel §4.1).
    if disposition is None:
        terminal = direct or source_failed
    else:
        terminal = direct or disposition != DISPOSITION_RETRY_LATER
    wait_code = SOURCE_CAPTURE_WAIT_CODE if disposition == DISPOSITION_RETRY_LATER else "filament_unavailable"
    message = routing_detail(reason)["message"]
    values = {
        "status": "failed" if terminal else "pending",
        "started_at": None,
        "completed_at": datetime.now(timezone.utc) if terminal else None,
        "waiting_reason": None if terminal else message,
        "waiting_reason_code": None if terminal else wait_code,
        "waiting_reason_checked_at": None if terminal else datetime.now(timezone.utc),
        "error_message": message if terminal else None,
    }
    if restore_source:
        values.update(archive_id=source_archive_id, library_file_id=source_library_file_id)
    if terminal:
        # This preparation never published a print, so there is no physical
        # failure for the next item's require_previous_success gate.
        values["gate_acknowledged"] = True
    routing = decode(item.filament_routing)
    if disposition is None and isinstance(routing, dict):
        routing["runtime"] = {"reason": reason, "blocked_revision": revision}
        values["filament_routing"] = json.dumps(routing)
    result = await db.execute(
        update(PrintQueueItem)
        .where(
            PrintQueueItem.id == item_id,
            PrintQueueItem.status == "printing",
            PrintQueueItem.started_at == started_at,
        )
        .values(**values)
        .execution_options(synchronize_session=False)
    )
    if not result.rowcount:
        return False
    # The queue can already belong to a later attempt; do not release that owner.
    await db.execute(
        update(PrinterQueue)
        .where(
            PrinterQueue.id == item.queue_id,
            PrinterQueue.current_item_id == item_id,
            PrinterQueue.status == "printing",
        )
        .values(status="idle", current_item_id=None)
        .execution_options(synchronize_session=False)
    )
    await update_queue_counters(db, item.queue_id)
    return True
