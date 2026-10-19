"""Telegram queue screens must name real ORM jobs without a file_name column."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.models.queue_source import QueueSource
from backend.app.services.telegram_handlers import common, printers, queue

pytestmark = pytest.mark.unit


@pytest.fixture
def patched_session(test_engine):
    maker = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    with patch("backend.app.core.database.async_session", maker):
        yield maker


async def _printer(db, name):
    printer = Printer(name=name, serial_number=f"SN-{name}", ip_address="127.0.0.1", access_code="12345678")
    db.add(printer)
    await db.flush()
    from backend.app.services.printer_queues import ensure_printer_queue

    await ensure_printer_queue(db, printer.id)
    return printer


@pytest.mark.asyncio
async def test_next_pending_name_and_empty_queue(db_session, patched_session):
    first = await _printer(db_session, "first")
    second = await _printer(db_session, "second")
    archive = PrintArchive(
        printer_id=first.id,
        filename="old.3mf",
        print_name="Product [A].3mf",
        file_path="old.3mf",
        file_size=1,
        status="completed",
    )
    db_session.add(archive)
    await db_session.flush()
    db_session.add_all(
        [
            PrintQueueItem(queue_id=first.id, status="printing", position=0, archive_id=archive.id),
            PrintQueueItem(queue_id=first.id, status="pending", position=2, archive_id=archive.id),
            PrintQueueItem(queue_id=second.id, status="pending", position=0),
        ]
    )
    await db_session.commit()

    assert await common.get_next_queue_item(first.id) == "Product [A].3mf"
    assert (await common.get_next_queue_item(second.id)).startswith("Job #")
    assert await common.get_next_queue_item(99999) is None


@pytest.mark.asyncio
async def test_captured_source_and_legacy_names_do_not_leak_hash(db_session):
    source = QueueSource(sha256="a" * 64, relative_path="spool/" + "a" * 64, size_bytes=1, format="3mf")
    library = LibraryFile(filename="Legacy.gcode.3mf", file_path="legacy.3mf", file_type="gcode", file_size=1)
    db_session.add_all([source, library])
    await db_session.flush()
    items = [
        PrintQueueItem(
            id=101,
            queue_id=1,
            queue_source_id=source.id,
            source_snapshot={"version": 1, "display_filename": "Saved [A].3mf"},
        ),
        PrintQueueItem(
            id=102,
            queue_id=1,
            queue_source_id=source.id,
            source_snapshot={"version": 999, "display_filename": "Wrong.3mf"},
            library_file_id=library.id,
        ),
        PrintQueueItem(id=103, queue_id=1, library_file_id=library.id),
        PrintQueueItem(id=104, queue_id=1),
        PrintQueueItem(id=105, queue_id=1, queue_source_id=999999, library_file_id=library.id),
    ]
    names = await common.queue_item_names(db_session, items, "en")
    assert names == {101: "Saved [A].3mf", 102: "Job #102", 103: "Legacy.gcode.3mf", 104: "Job #104", 105: "Job #105"}
    assert "a" * 64 not in str(names)


@pytest.mark.asyncio
async def test_list_and_detail_use_same_escaped_name(db_session, patched_session):
    printer = await _printer(db_session, "names")
    archive = PrintArchive(
        printer_id=printer.id,
        filename="plate.3mf",
        print_name="Part [A].3mf",
        file_path="plate.3mf",
        file_size=1,
        status="completed",
    )
    db_session.add(archive)
    await db_session.flush()
    item = PrintQueueItem(queue_id=printer.id, status="pending", position=1, archive_id=archive.id)
    db_session.add(item)
    await db_session.commit()

    target = MagicMock(answer=AsyncMock())
    await queue.render_queue(target)
    list_text = target.answer.await_args.args[0]
    list_markup = target.answer.await_args.kwargs["reply_markup"]
    assert "Part \\[A\\]\\.3mf" in list_text
    assert any(button.text == "⏳ Part [A].3mf" for row in list_markup.inline_keyboard for button in row)

    callback = MagicMock(data=f"queue:detail:{item.id}", answer=AsyncMock())
    callback.message.edit_text = AsyncMock()
    await queue.cb_queue_detail(callback)
    assert "Part \\[A\\]\\.3mf" in callback.message.edit_text.await_args.args[0]


@pytest.mark.asyncio
@pytest.mark.parametrize("state", ["FINISH", "FAILED"])
async def test_plate_clear_card_shows_next_job_and_keeps_gate_actions(db_session, patched_session, state):
    printer = await _printer(db_session, f"held-{state}")
    archive = PrintArchive(
        printer_id=printer.id,
        filename="plate.3mf",
        print_name="Next [A].3mf",
        file_path="plate.3mf",
        file_size=1,
        status="completed",
    )
    db_session.add(archive)
    await db_session.flush()
    db_session.add(PrintQueueItem(queue_id=printer.id, status="pending", position=1, archive_id=archive.id))
    await db_session.commit()
    printer_data = {
        "id": printer.id,
        "name": printer.name,
        "model": "X1C",
        "connected": False,
        "state": state,
        "nozzle_temp": None,
        "bed_temp": None,
        "awaiting_plate_clear": True,
    }
    callback = MagicMock()
    callback.message.edit_text = AsyncMock()
    with (
        patch.object(printers, "get_printers_data", AsyncMock(return_value=[printer_data])),
        patch.object(printers, "get_total_hours", AsyncMock(return_value=1.0)),
        patch("backend.app.services.plate_hold.waiting_archive", AsyncMock(return_value=archive)),
    ):
        await printers.show_printer_detail(callback, printer.id)
    text = callback.message.edit_text.await_args.args[0]
    markup = callback.message.edit_text.await_args.kwargs["reply_markup"]
    assert "Next \\[A\\]\\.3mf" in text
    buttons = [button.callback_data for row in markup.inline_keyboard for button in row]
    assert any(data.startswith("action:clear_plate:") for data in buttons)
    assert any(data.startswith("action:repeat_print:") for data in buttons)


@pytest.mark.asyncio
async def test_foreign_queue_item_does_not_reveal_name(db_session, patched_session):
    printer = await _printer(db_session, "other")
    item = PrintQueueItem(queue_id=printer.id, status="pending", position=1)
    db_session.add(item)
    await db_session.commit()
    chat = MagicMock()
    chat.allows_printer.return_value = False
    callback = MagicMock(data=f"queue:detail:{item.id}", answer=AsyncMock())
    callback.message.edit_text = AsyncMock()
    await queue.cb_queue_detail(callback, chat)
    callback.message.edit_text.assert_not_awaited()
    assert callback.answer.await_args.kwargs["show_alert"] is True
