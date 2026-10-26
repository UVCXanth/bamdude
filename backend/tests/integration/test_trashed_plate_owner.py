"""Trashing print history does not answer its physical plate-clear question."""

from datetime import datetime, timezone

import pytest
from sqlalchemy import select

from backend.app.models.archive import PrintArchive
from backend.app.models.print_completion_receipt import PrintCompletionReceipt
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.models.printer_queue import PrinterQueue
from backend.app.services.plate_answers import answer_plate_run
from backend.app.services.plate_hold import StalePlateAnswer
from backend.tests.integration.test_plate_answers_defects import _finished_flat, _finished_printer

pytestmark = pytest.mark.integration


async def _trashed_owner(db, printer, *, status="completed", removed_row=False):
    archive, row = await _finished_flat(db, printer, 2)
    archive.status = row.status = status
    archive.deleted_at = datetime.now(timezone.utc)
    printer.awaiting_plate_clear = True
    printer.awaiting_plate_clear_archive_id = archive.id
    printer.awaiting_plate_clear_token = "trashed-owner"
    queue = await db.get(PrinterQueue, row.queue_id)
    queue.status = "paused"
    old = PrintArchive(printer_id=printer.id, filename="older.3mf", file_path="old", file_size=1, status="completed")
    db.add(old)
    await db.flush()
    old_row = PrintQueueItem(queue_id=queue.id, archive_id=old.id, status="completed")
    pending = PrintQueueItem(queue_id=queue.id, status="pending", library_file_id=1, manual_start=False)
    db.add_all([old_row, pending])
    await db.flush()
    ids = {
        "pid": printer.id,
        "aid": archive.id,
        "row": row.id,
        "queue": queue.id,
        "old_row": old_row.id,
        "pending": pending.id,
    }
    if removed_row:
        await db.delete(row)
    await db.commit()
    return ids


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["completed", "cancelled", "failed"])
@pytest.mark.parametrize("removed_row", [False, True])
async def test_fresh_manual_clear_answers_only_the_trashed_gate_owner(
    async_client, printer_factory, db_session, status, removed_row
):
    printer = await printer_factory()
    ids = await _trashed_owner(db_session, printer, status=status, removed_row=removed_row)
    # The deleted print is never offered for assessment or repeat.
    assert (await async_client.get(f"/api/v1/printers/{ids['pid']}/waiting-print")).status_code == 404
    with _finished_printer():
        response = await async_client.post(f"/api/v1/printers/{ids['pid']}/clear-plate")
    assert response.status_code == 200, response.text
    db_session.expire_all()
    current = await db_session.get(Printer, ids["pid"])
    assert not current.awaiting_plate_clear
    assert current.awaiting_plate_clear_archive_id is None and current.awaiting_plate_clear_token is None
    archive = await db_session.get(PrintArchive, ids["aid"])
    assert archive.deleted_at is not None and archive.status == status and archive.defective_count == 0
    receipt = await db_session.scalar(
        select(PrintCompletionReceipt).where(PrintCompletionReceipt.archive_id == ids["aid"])
    )
    assert receipt.plate_action == "clear" and receipt.assessment is None
    assert receipt.gate_token == "trashed-owner"
    row = await db_session.get(PrintQueueItem, ids["row"])
    if removed_row or status == "completed":
        assert row is None
    else:
        assert row.status == status  # keep failed history for previous-success admission
    assert (await db_session.get(PrintQueueItem, ids["old_row"])).status == "completed"
    assert (await db_session.get(PrintQueueItem, ids["pending"])).status == "pending"
    assert (await db_session.get(PrinterQueue, ids["queue"])).status == "paused"


@pytest.mark.asyncio
@pytest.mark.parametrize("answer", ["card", "token", "defects", "repeat", "automatic"])
async def test_deleted_print_cannot_be_graded_repeated_or_answered_by_a_card(
    async_client, printer_factory, db_session, answer
):
    printer = await printer_factory()
    ids = await _trashed_owner(db_session, printer)
    body = None
    if answer == "card":
        body = {"expected_archive_id": ids["aid"], "expected_gate_token": "trashed-owner"}
    elif answer == "token":
        body = {"expected_gate_token": "trashed-owner"}
    elif answer == "defects":
        body = {"defects": {"defective_count": 1}}
    if answer == "automatic":
        with pytest.raises(StalePlateAnswer):
            await answer_plate_run(
                db_session, printer_id=ids["pid"], expected_archive_id=None, action="clear", automatic=True
            )
        await db_session.rollback()
    else:
        path = "repeat-print" if answer == "repeat" else "clear-plate"
        with _finished_printer():
            response = await async_client.post(f"/api/v1/printers/{ids['pid']}/{path}", json=body)
        assert response.status_code == 409, response.text
    db_session.expire_all()
    assert (await db_session.get(Printer, ids["pid"])).awaiting_plate_clear
    assert (await db_session.get(PrintQueueItem, ids["row"])).status == "completed"
    assert (await db_session.get(PrintArchive, ids["aid"])).defective_count == 0
    assert (
        await db_session.scalar(
            select(PrintCompletionReceipt.id).where(PrintCompletionReceipt.archive_id == ids["aid"])
        )
        is None
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("invalid", ["foreign", "running", "unarmed", "pending-row", "running-row"])
async def test_manual_clear_does_not_guess_an_invalid_trashed_owner(async_client, printer_factory, db_session, invalid):
    printer = await printer_factory()
    ids = await _trashed_owner(db_session, printer)
    archive = await db_session.get(PrintArchive, ids["aid"])
    if invalid == "foreign":
        other = await printer_factory()
        archive.printer_id = other.id
    elif invalid == "running":
        archive.status = "printing"
    elif invalid == "unarmed":
        printer.awaiting_plate_clear = False
    else:
        row = await db_session.get(PrintQueueItem, ids["row"])
        row.status = "pending" if invalid == "pending-row" else "printing"
    await db_session.commit()
    with _finished_printer():
        response = await async_client.post(f"/api/v1/printers/{ids['pid']}/clear-plate")
    assert response.status_code == 409, response.text
    db_session.expire_all()
    assert (await db_session.get(Printer, ids["pid"])).awaiting_plate_clear_archive_id == ids["aid"]
    assert (await db_session.get(PrintQueueItem, ids["row"])).status == {
        "pending-row": "pending",
        "running-row": "printing",
    }.get(invalid, "completed")
