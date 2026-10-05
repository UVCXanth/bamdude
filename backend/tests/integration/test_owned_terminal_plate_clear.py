"""An explicitly held cancelled/failed print remains answerable without unpausing its queue."""

from datetime import datetime, timezone

import pytest
from sqlalchemy import select

from backend.app.models.archive import PrintArchive
from backend.app.models.print_completion_receipt import PrintCompletionReceipt
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.models.printer_queue import PrinterQueue
from backend.app.services.print_scheduler import PrintScheduler
from backend.tests.integration.test_plate_answers_defects import _finished_flat, _finished_printer

pytestmark = pytest.mark.integration


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["cancelled", "failed"])
async def test_owned_terminal_print_can_clear_without_unpausing(async_client, printer_factory, db_session, status):
    printer = await printer_factory()
    archive, row = await _finished_flat(db_session, printer, 2)
    archive.status = row.status = status
    printer.awaiting_plate_clear = True
    printer.awaiting_plate_clear_archive_id = archive.id
    printer.awaiting_plate_clear_token = "owned-terminal-token"
    queue = await db_session.get(PrinterQueue, row.queue_id)
    queue.status = "paused"
    pending = PrintQueueItem(queue_id=queue.id, status="pending", manual_start=False, library_file_id=1)
    db_session.add(pending)
    await db_session.commit()
    printer_id, archive_id, row_id, pending_id, queue_id = printer.id, archive.id, row.id, pending.id, queue.id

    response = await async_client.get(f"/api/v1/printers/{printer_id}/waiting-print")
    assert response.status_code == 200, response.text
    assert response.json()["archive_id"] == archive_id
    assert response.json()["status"] == status

    body = {"expected_archive_id": archive_id, "expected_gate_token": "owned-terminal-token"}
    with _finished_printer():
        response = await async_client.post(f"/api/v1/printers/{printer_id}/clear-plate", json=body)
    assert response.status_code == 200, response.text

    db_session.expire_all()
    assert (await db_session.get(PrintQueueItem, row_id)).status == status
    assert (await db_session.get(PrintArchive, archive_id)).status == status
    assert (await db_session.get(PrintQueueItem, pending_id)).status == "pending"
    assert (await db_session.get(PrinterQueue, queue_id)).status == "paused"
    current = await db_session.get(Printer, printer_id)
    assert not current.awaiting_plate_clear
    assert current.awaiting_plate_clear_archive_id is None
    assert await PrintScheduler().previous_print_succeeded(db_session, printer_id) is (status != "failed")
    receipt = await db_session.scalar(
        select(PrintCompletionReceipt).where(PrintCompletionReceipt.archive_id == archive_id)
    )
    assert receipt.plate_action == "clear" and receipt.assessment is None


@pytest.mark.asyncio
async def test_old_completed_row_cannot_override_owned_cancelled_print(async_client, printer_factory, db_session):
    printer = await printer_factory()
    archive, row = await _finished_flat(db_session, printer, 1)
    archive.status = row.status = "cancelled"
    printer.awaiting_plate_clear = True
    printer.awaiting_plate_clear_archive_id = archive.id
    printer.awaiting_plate_clear_token = "new-gate"
    old = PrintArchive(printer_id=printer.id, filename="old.3mf", file_path="old.3mf", file_size=1, status="completed")
    db_session.add(old)
    await db_session.flush()
    stale = PrintQueueItem(
        queue_id=row.queue_id, archive_id=old.id, status="completed", completed_at=datetime.now(timezone.utc)
    )
    db_session.add(stale)
    await db_session.commit()
    pid, aid, old_id, row_id, stale_id = printer.id, archive.id, old.id, row.id, stale.id

    response = await async_client.get(f"/api/v1/printers/{pid}/waiting-print")
    assert response.status_code == 200, response.text
    assert response.json()["archive_id"] == aid
    with _finished_printer():
        response = await async_client.post(
            f"/api/v1/printers/{pid}/clear-plate",
            json={"expected_archive_id": old_id, "expected_gate_token": "old-gate"},
        )
    assert response.status_code == 409
    db_session.expire_all()
    assert (await db_session.get(Printer, pid)).awaiting_plate_clear
    assert (await db_session.get(PrintQueueItem, row_id)).status == "cancelled"
    assert (await db_session.get(PrintQueueItem, stale_id)).status == "completed"


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["cancelled", "failed"])
async def test_ownerless_gate_does_not_guess_a_terminal_history_row(async_client, printer_factory, db_session, status):
    printer = await printer_factory()
    archive, row = await _finished_flat(db_session, printer, 1)
    archive.status = row.status = status
    printer.awaiting_plate_clear = True
    await db_session.commit()
    response = await async_client.get(f"/api/v1/printers/{printer.id}/waiting-print")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_owned_running_row_does_not_offer_a_plate_answer(async_client, printer_factory, db_session):
    printer = await printer_factory()
    archive, row = await _finished_flat(db_session, printer, 1)
    archive.status = row.status = "printing"
    printer.awaiting_plate_clear = True
    printer.awaiting_plate_clear_archive_id = archive.id
    printer.awaiting_plate_clear_token = "running-owner"
    await db_session.commit()
    response = await async_client.get(f"/api/v1/printers/{printer.id}/waiting-print")
    assert response.status_code == 404
