"""Two real file-backed SQLite sessions: plate clear must not invert writer/print guards."""

import asyncio
from datetime import datetime, timezone
from unittest.mock import MagicMock

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.core.database import Base
from backend.app.models.archive import PrintArchive
from backend.app.models.print_completion_receipt import PrintCompletionReceipt
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.models.printer_queue import PrinterQueue
from backend.app.services import plate_answers
from backend.app.services.archive_write_scope import archive_process_lock, archive_write_scope
from backend.app.services.plate_hold import StalePlateAnswer

pytestmark = [pytest.mark.integration, pytest.mark.asyncio]


@pytest.mark.parametrize("kind", ["trashed", "active", "legacy", "addressed"])
@pytest.mark.parametrize("caller_writer", [False, True])
async def test_clear_refuses_writer_lock_cycle_then_retry_commits_exact_owner(
    tmp_path, monkeypatch, kind, caller_writer
):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'plate.db'}", connect_args={"timeout": 2})
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
        await connection.execute(text("CREATE TABLE caller_work (id INTEGER PRIMARY KEY)"))
    async with sessions() as setup:
        printer = Printer(name="test", serial_number="test", ip_address="127.0.0.1", access_code="test")
        setup.add(printer)
        await setup.flush()
        archive = PrintArchive(
            printer_id=printer.id,
            filename="done.3mf",
            file_path="unused",
            file_size=1,
            status="completed",
            deleted_at=datetime.now(timezone.utc) if kind == "trashed" else None,
        )
        setup.add(archive)
        await setup.flush()
        printer.awaiting_plate_clear = True
        printer.awaiting_plate_clear_archive_id = None if kind == "legacy" else archive.id
        printer.awaiting_plate_clear_token = "exact-owner"
        queue = PrinterQueue(printer_id=printer.id, status="paused")
        setup.add(queue)
        await setup.flush()
        row = PrintQueueItem(queue_id=queue.id, archive_id=archive.id, status="completed")
        old = PrintQueueItem(queue_id=queue.id, status="failed")
        pending = PrintQueueItem(queue_id=queue.id, status="pending")
        setup.add_all([row, old, pending])
        await setup.commit()
        pid, aid, qid, rid, oid, pending_id = printer.id, archive.id, queue.id, row.id, old.id, pending.id

    from backend.app.services.printer_manager import printer_manager

    released = MagicMock()
    monkeypatch.setattr(printer_manager, "confirm_awaiting_plate_clear_released", released)
    competitor_at_writer, competitor_finished = asyncio.Event(), asyncio.Event()

    async def competitor():
        async with sessions() as other:
            execute = other.execute

            async def observe(statement, *args, **kwargs):
                if str(statement) == "BEGIN IMMEDIATE":
                    competitor_at_writer.set()
                return await execute(statement, *args, **kwargs)

            other.execute = observe
            async with archive_write_scope(other, aid):
                await other.execute(text("INSERT INTO caller_work VALUES (2)"))
                await other.commit()
            competitor_finished.set()

    tasks = []
    expected = aid if kind == "addressed" else None
    try:
        async with sessions() as clear:
            execute = clear.execute

            async def interleave(statement, *args, **kwargs):
                result = await execute(statement, *args, **kwargs)
                if str(statement) == "BEGIN IMMEDIATE":
                    await execute(text("INSERT INTO caller_work VALUES (1)"))
                    tasks.append(asyncio.create_task(competitor()))
                    await asyncio.wait_for(competitor_at_writer.wait(), 5)
                    assert archive_process_lock(aid).locked()
                return result

            clear.execute = interleave
            if caller_writer or kind == "addressed":
                await clear.execute(text("BEGIN IMMEDIATE"))
            with pytest.raises(StalePlateAnswer, match="being changed"):
                await asyncio.wait_for(
                    plate_answers.answer_plate_run(clear, printer_id=pid, expected_archive_id=expected, action="clear"),
                    0.75,
                )
            assert clear.in_transaction()  # neither rollback nor commit of caller work
            assert await clear.scalar(text("SELECT count(*) FROM caller_work WHERE id=1")) == 1
            assert not competitor_finished.is_set()
            released.assert_not_called()
            await clear.rollback()
        await asyncio.wait_for(asyncio.gather(*tasks), 5)
        async with sessions() as verify:
            assert await verify.scalar(text("SELECT count(*) FROM caller_work WHERE id=1")) == 0
            assert (await verify.get(Printer, pid)).awaiting_plate_clear
            assert await verify.get(PrintQueueItem, rid) is not None
            assert await verify.scalar(select(PrintCompletionReceipt.id)) is None
        async with sessions() as retry:
            result = await plate_answers.answer_plate_run(
                retry, printer_id=pid, expected_archive_id=expected, action="clear"
            )
            assert result.archive.id == aid
        released.assert_called_once_with(pid)
        async with sessions() as verify:
            printer = await verify.get(Printer, pid)
            assert not printer.awaiting_plate_clear and printer.awaiting_plate_clear_archive_id is None
            assert printer.awaiting_plate_clear_token is None
            receipt = await verify.scalar(select(PrintCompletionReceipt))
            assert receipt.archive_id == aid and receipt.plate_action == "clear" and receipt.assessment is None
            assert await verify.get(PrintQueueItem, rid) is None
            assert (await verify.get(PrintQueueItem, oid)).status == "failed"
            assert (await verify.get(PrintQueueItem, pending_id)).status == "pending"
            assert (await verify.get(PrinterQueue, qid)).status == "paused"
            archive = await verify.get(PrintArchive, aid)
            assert (archive.deleted_at is not None) == (kind == "trashed")
            assert archive.extra_data["plate_clear_source"] == "manual"
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await engine.dispose()


async def test_clear_refuses_an_unlocked_archive_guard_already_promised_to_a_waiter(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'handoff.db'}", connect_args={"timeout": 2})
    sessions = async_sessionmaker(engine)
    async with engine.begin() as connection:
        await connection.execute(text("CREATE TABLE caller_work (id INTEGER PRIMARY KEY)"))
    aid = 777
    lock = archive_process_lock(aid)
    waiting = asyncio.Event()

    async def competitor():
        async with sessions() as other:
            waiting.set()
            async with archive_write_scope(other, aid):
                await other.execute(text("INSERT INTO caller_work VALUES (2)"))
                await other.commit()

    task = None
    try:
        async with sessions() as clear:
            await clear.execute(text("BEGIN IMMEDIATE"))
            await clear.execute(text("INSERT INTO caller_work VALUES (1)"))
            await lock.acquire()
            task = asyncio.create_task(competitor())
            await waiting.wait()  # competitor has suspended on the archive guard
            lock.release()  # unlocked, but acquire must honour its existing waiter
            assert not lock.locked()
            with pytest.raises(plate_answers.PlateAnswerBusy):
                async with asyncio.timeout(0.75):
                    # Direct await preserves this exact handoff interleaving.
                    await plate_answers.answer_plate_run(clear, printer_id=777, expected_archive_id=aid, action="clear")
            assert clear.in_transaction()
            assert await clear.scalar(text("SELECT count(*) FROM caller_work WHERE id=1")) == 1
            await clear.rollback()
        await asyncio.wait_for(task, 5)
        async with sessions() as verify:
            assert await verify.scalar(text("SELECT count(*) FROM caller_work")) == 1
    finally:
        if task is not None:
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await engine.dispose()
