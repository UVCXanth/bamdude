"""A dispatch attempt whose owner ended before it was sent goes back to the queue — only by proof (post-rebuild I-R3).

An execution archive carries its dispatch phase and the boot of the process that owned it
(``services/dispatch_phase``). When THIS process holds the installation's owner lock
(``farm_startup_guard``) and an attempt names another boot, its owner has ended: two
processes never hold that lock together. That is the only proof used — never an age, a
timer or a file name.

Of such attempts only a ``prepared`` one — the start command was provably never sent — may
return to ``pending`` by itself, and only when all of these hold at the moment of the move:

* the farm's crash-start pause is released (otherwise it stays visible and this check runs
  again after Resume);
* the printer reports a fresh, inactive state, with no other print archive running on it;
* our swap-start macro provably did not run (``swap_terminal.cycle_state`` is
  ``not_started``); one that ran, or may have, fails the attempt and halts the queue, so a
  table is never moved twice;
* no other unfinished effect is recorded on the archive (a pending-events list is only an
  intent and proves nothing);
* the row still has dispatch attempts to spend; otherwise it fails for the operator's Retry.

``sending`` / ``sent`` / unknown attempts are never moved here: the start may be on the
printer, so they are the operator's to close through the Info action. Nothing here sends a
physical command, replays a completion, books usage or touches the heaters. Recovery never
gives the spent attempt back: a crash is not a typed refusal (D-R5).

The check is addressed and has no timer: it runs when a printer's first fresh status of a
connection arrives (``reconcile_printer_prints``) and when the farm is resumed.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import func, select

from backend.app.core import database
from backend.app.models.archive import PrintArchive
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer_queue import PrinterQueue
from backend.app.services import dispatch_phase
from backend.app.utils import failure_reasons

logger = logging.getLogger(__name__)

REQUEUED = "requeued"
FAILED = "failed"

_INTERRUPTED = "The dispatch was interrupted before the start command was sent"


async def recover_interrupted_dispatches(printer_id: int) -> list[str]:
    """Settle the ``prepared`` attempts of an ended owner on this printer; the outcome of each, in order."""
    from backend.app.services.farm_startup_guard import farm_startup_guard
    from backend.app.services.print_state_recovery_store import live_snapshot

    if not farm_startup_guard.allowed():
        return []
    boot = dispatch_phase.current_boot_id()
    if boot is None:
        return []
    if live_snapshot(printer_id)["mode"] != "inactive":
        return []
    async with database.async_session() as db:
        queue_id = await db.scalar(select(PrinterQueue.id).where(PrinterQueue.printer_id == printer_id))
        if queue_id is None:
            return []
        candidates = (
            await db.execute(
                select(PrintQueueItem.id, PrintArchive.id)
                .join(PrintArchive, PrintArchive.id == PrintQueueItem.archive_id)
                .where(
                    PrintQueueItem.queue_id == queue_id,
                    PrintQueueItem.status == "printing",
                    PrintArchive.status == "printing",
                    PrintArchive.dispatch_phase == dispatch_phase.PREPARED,
                    PrintArchive.dispatch_boot_id.is_not(None),
                    PrintArchive.dispatch_boot_id != boot,
                )
                .order_by(PrintQueueItem.id)
            )
        ).all()
    outcomes = []
    for item_id, archive_id in candidates:
        outcome = await _settle(printer_id, queue_id, item_id, archive_id, boot)
        if outcome:
            outcomes.append(outcome)
    return outcomes


async def _settle(printer_id: int, queue_id: int, item_id: int, archive_id: int, boot: str) -> str | None:
    from backend.app.services import swap_terminal
    from backend.app.services.archive_write_scope import load_active_archive_for_write
    from backend.app.services.print_scheduler import DISPATCH_MAX_ATTEMPTS
    from backend.app.services.print_state_recovery import effects_pending
    from backend.app.services.queue_counters import set_queue_error, update_queue_counters
    from backend.app.services.queue_ops import claim_lanes

    # Archive before lane before rows, the order every archive + queue writer keeps.
    async with database.async_session() as db, claim_lanes(db, [queue_id], archive_id=archive_id):
        archive = await load_active_archive_for_write(db, archive_id)
        item = await db.scalar(
            select(PrintQueueItem)
            .where(PrintQueueItem.id == item_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        queue = await db.scalar(
            select(PrinterQueue)
            .where(PrinterQueue.id == queue_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if (
            archive is None
            or item is None
            or queue is None
            or archive.status != "printing"
            or archive.dispatch_phase != dispatch_phase.PREPARED
            or archive.dispatch_boot_id in (None, boot)
            or item.status != "printing"
            or item.archive_id != archive_id
            or item.queue_id != queue_id
        ):
            return None
        others = await db.scalar(
            select(func.count(PrintArchive.id)).where(
                PrintArchive.printer_id == printer_id,
                PrintArchive.status == "printing",
                PrintArchive.deleted_at.is_(None),
                PrintArchive.id != archive_id,
            )
        )
        if others:
            return None  # another print may be on this printer: the operator decides
        start_ran = swap_terminal.cycle_state(archive.extra_data) != swap_terminal.CYCLE_NOT_STARTED
        if not start_ran and effects_pending({"extra_data": archive.extra_data}, intents=False):
            return None  # an unfinished effect is recorded: visible in Info, never resolved here
        now = datetime.now(timezone.utc)
        code = failure_reasons.DISPATCH_PREPARATION_ERROR
        # A direct print ("print now") is never started later by itself: like a refused one,
        # it ends, and leaves the queue to the jobs behind it.
        direct = item.origin == "direct"
        if start_ran:
            detail = f"{_INTERRUPTED}, after the swap start macro ran or may have. Check the plate, then Retry."
        elif direct:
            detail = f"{_INTERRUPTED}; a direct print is not started again by itself. Check the printer, then Retry."
        elif (item.dispatch_attempts or 0) >= DISPATCH_MAX_ATTEMPTS:
            detail = f"{_INTERRUPTED}, and its dispatch attempts are spent. Check the printer, then Retry."
        else:
            detail = None

        archive.status = "failed"
        archive.failure_reason = code
        archive.error_message = detail or f"{_INTERRUPTED}; the job went back to the queue."
        archive.completed_at = now
        if detail is None:
            # Back to pending with its own bytes, options and macros; the attempt it spent stays spent.
            _restore_source(item, archive_id)
            item.status = "pending"
            item.started_at = None
            item.error_message = None
            item.error_code = None
            item.waiting_reason = None
            if queue.current_item_id == item_id and queue.status == "printing":
                queue.status = "idle"
                queue.current_item_id = None
        else:
            item.status = "failed"
            item.error_message = detail
            item.error_code = code
            item.completed_at = now
            # It never printed: no physical failure for a require-previous-success gate.
            item.gate_acknowledged = True
            if direct and not start_ran:
                if queue.current_item_id == item_id and queue.status == "printing":
                    queue.status = "idle"
                    queue.current_item_id = None
            else:
                await set_queue_error(db, queue_id, failed_item_id=item_id, expected_item_id=item_id)
        await update_queue_counters(db, queue_id)
        await db.commit()
    outcome = REQUEUED if detail is None else FAILED
    logger.warning(
        "Interrupted dispatch: printer %d item %s archive %s (phase prepared, owner ended) — %s",
        printer_id,
        item_id,
        archive_id,
        outcome,
    )
    return outcome


def _restore_source(item, execution_archive_id: int) -> None:
    """Point the job at what it was queued from again, as a Retry would — never at its own failed attempt."""
    from backend.app.services.filament_policy import restore_routing_source

    restore_routing_source(item)
    if item.archive_id != execution_archive_id:
        return
    snapshot = item.source_snapshot if isinstance(item.source_snapshot, dict) else {}
    provenance = snapshot.get("provenance") if isinstance(snapshot.get("provenance"), dict) else {}
    kind, source_id = provenance.get("kind"), provenance.get("id")
    if type(source_id) is not int:
        return  # nothing names an original: the attempt's own copy of the bytes is the source, as on Retry
    if kind == "archive":
        item.archive_id, item.library_file_id = source_id, None
    elif kind == "library_file":
        item.archive_id, item.library_file_id = None, source_id


async def recover_after_resume() -> None:
    """The addressed recheck the farm's Resume owes: every printer that has a candidate, once."""
    async with database.async_session() as db:
        printers = (
            await db.scalars(
                select(PrinterQueue.printer_id)
                .join(PrintQueueItem, PrintQueueItem.queue_id == PrinterQueue.id)
                .join(PrintArchive, PrintArchive.id == PrintQueueItem.archive_id)
                .where(
                    PrintQueueItem.status == "printing",
                    PrintArchive.status == "printing",
                    PrintArchive.dispatch_phase == dispatch_phase.PREPARED,
                )
                .distinct()
            )
        ).all()
    for printer_id in printers:
        try:
            await recover_interrupted_dispatches(printer_id)
        except Exception:  # noqa: BLE001 - one printer's recheck never stops another's
            logger.exception("Interrupted dispatch recheck failed for printer %s", printer_id)
