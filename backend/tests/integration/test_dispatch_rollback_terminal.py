"""Real runners and ORM rollback; only device I/O and optional services are fake.

The PostgreSQL harness reruns this module against its disposable database.
DISPATCH_TEST_POSTGRES_URL must never name an operator database: tables are dropped.
"""

import asyncio
import os
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest
from sqlalchemy import event, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.core.config import settings
from backend.app.core.database import Base, _strip_tz_from_params, configure_sqlite_connection, import_all_models
from backend.app.models.archive import PrintArchive
from backend.app.models.print_queue import PrintQueueItem
from backend.app.services import background_dispatch as bd
from backend.app.services.filament_policy_write import prepare_routing
from backend.app.services.printer_manager import printer_manager
from backend.tests.integration.test_filament_routing_dispatch import setup_source

pytestmark = pytest.mark.integration


@pytest.fixture
async def test_engine(monkeypatch, tmp_path):
    url = os.environ.get("DISPATCH_TEST_POSTGRES_URL", f"sqlite+aiosqlite:///{tmp_path / 'dispatch.sqlite'}")
    schema = "dispatch_" + uuid4().hex if url.startswith("postgresql") else None
    if schema:
        monkeypatch.setattr(settings, "database_url", url)
    options = (
        {
            "connect_args": {
                "server_settings": {
                    "search_path": schema,
                    "timezone": "UTC",
                    "application_name": schema,
                }
            }
        }
        if schema
        else {}
    )
    engine = create_async_engine(url, **options)
    if engine.dialect.name == "sqlite":
        event.listen(engine.sync_engine, "connect", configure_sqlite_connection)
    else:
        event.listen(engine.sync_engine, "before_cursor_execute", _strip_tz_from_params, retval=True)
    import_all_models()
    async with engine.begin() as connection:
        if schema:
            await connection.execute(text(f'CREATE SCHEMA "{schema}"'))
        await connection.run_sync(Base.metadata.create_all)
    monkeypatch.setattr("backend.app.core.database.async_session", async_sessionmaker(engine, expire_on_commit=False))
    yield engine
    async with engine.begin() as connection:
        if schema:
            await connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        else:
            await connection.run_sync(Base.metadata.drop_all)
    await engine.dispose()
    await asyncio.sleep(0.1)


@pytest.mark.parametrize("kind", ["print_library_file", "reprint_archive"])
@pytest.mark.parametrize("owner", ["direct", "queue"])
@pytest.mark.parametrize(
    "failure", ["cancel", "early_cancel", "upload", "start", "early", "cleanup", "success", "late_cancel"]
)
async def test_runner_preserves_terminal_outcome_after_rollback(
    db_session, test_engine, tmp_path, printer_factory, monkeypatch, caplog, kind, failure, owner
):
    source, printer, queue, mqtt = await setup_source(db_session, tmp_path, printer_factory, monkeypatch)
    monkeypatch.setattr(settings, "base_dir", tmp_path)
    monkeypatch.setattr(settings, "archive_dir", tmp_path / "archives")
    settings.archive_dir.mkdir()
    source_archive = None
    if kind == "reprint_archive":
        source_archive = PrintArchive(
            printer_id=printer.id,
            filename=source.filename,
            file_path=source.file_path,
            file_size=source.file_size,
            status="completed",
            plate_index=15,
        )
        db_session.add(source_archive)
        await db_session.commit()
    source_id = source_archive.id if source_archive else source.id
    source_archive_id = source_archive.id if source_archive else None
    routing, plate = await prepare_routing(
        db_session,
        printer_id=printer.id,
        archive_id=source_archive_id,
        library_file_id=None if source_archive else source.id,
    )
    item = PrintQueueItem(
        queue_id=queue.id,
        archive_id=source_archive_id,
        library_file_id=None if source_archive else source.id,
        filament_routing=routing,
        plate_id=plate,
        status="printing",
        origin=owner,
        started_at=datetime.now(timezone.utc),
    )
    db_session.add(item)
    await db_session.flush()
    queue.current_item_id, queue.status = item.id, "printing"
    await db_session.commit()
    item_id, queue_id, printer_id = item.id, queue.id, printer.id
    factory = async_sessionmaker(test_engine, expire_on_commit=False)
    monkeypatch.setattr(bd, "async_session", factory)
    monkeypatch.setattr("backend.app.services.print_scheduler.async_session", factory)
    monkeypatch.setattr("backend.app.services.print_scheduler.scheduler.acquire_stagger_slot", AsyncMock())
    monkeypatch.setattr(bd, "resolve_dispatch_storage", lambda *_: ("external", None))
    monkeypatch.setattr(bd, "delete_file_async", AsyncMock(return_value=True))
    monkeypatch.setattr(bd, "list_files_async", AsyncMock(return_value=[]))
    monkeypatch.setattr(bd, "get_ftp_retry_settings", AsyncMock(return_value=(False, 0, 0, 30)))
    monkeypatch.setattr(printer_manager, "ensure_fresh_connection_for_printer", AsyncMock(return_value=True))
    monkeypatch.setattr(bd, "_warn_on_filament_deficit", AsyncMock())
    monkeypatch.setattr(bd.ws_manager, "broadcast", AsyncMock())
    register, withdraw = MagicMock(), MagicMock()
    monkeypatch.setattr("backend.app.main.register_expected_print", register)
    monkeypatch.setattr("backend.app.main.withdraw_expected_print", withdraw)
    monkeypatch.setattr("backend.app.services.preheat.rollback", MagicMock())
    monkeypatch.setattr("backend.app.services.preheat.preheat_and_soak", AsyncMock())

    async def calibration(*args, **kwargs):
        # Unlike an upload that fails immediately after archive commit, this
        # point has an active real transaction. Rollback expires the archive.
        if failure in {"cancel", "cleanup"}:
            raise bd.DispatchJobCancelled("operator cancelled before publish")
        return frozenset()

    monkeypatch.setattr(bd, "_apply_calibrations_for_print", AsyncMock(side_effect=calibration))
    monkeypatch.setattr(bd, "_calibration_bind_keys", AsyncMock(return_value=frozenset()))
    notifications = AsyncMock()
    monkeypatch.setattr(
        "backend.app.services.notification_service.notification_service.on_queue_job_failed", notifications
    )
    service = bd.BackgroundDispatchService()
    monkeypatch.setattr(service, "_ensure_live_connection_before_start", AsyncMock())
    monkeypatch.setattr(service, "_run_swap_macro_if_needed", AsyncMock())
    monkeypatch.setattr(service, "_verify_print_response", AsyncMock(return_value=True))
    monkeypatch.setattr(service, "_strict_stagger_refuses", AsyncMock(return_value=False))
    job = bd.PrintDispatchJob(
        id=991,
        kind=kind,
        source_id=source_id,
        source_name=source.filename,
        printer_id=printer_id,
        printer_name=printer.name,
        queue_item_id=item_id,
        claim_started_at=item.started_at,
        options={"plate_id": plate, "mesh_mode_fast_check": True},
    )

    async def upload(*args, **kwargs):
        return failure != "upload"

    monkeypatch.setattr(bd, "upload_file_async", AsyncMock(side_effect=upload))
    original_start = printer_manager.start_print

    def start(*args, **kwargs):
        if failure == "start":
            return False
        result = original_start(*args, **kwargs)
        if failure == "late_cancel":
            service._cancel_requested_job_ids.add(job.id)
        return result

    monkeypatch.setattr(printer_manager, "start_print", start)
    if failure == "early":
        monkeypatch.setattr(printer_manager, "ensure_fresh_connection_for_printer", AsyncMock(return_value=False))
    if failure == "early_cancel":
        monkeypatch.setattr(bd, "delete_file_async", AsyncMock(side_effect=bd.DispatchJobCancelled("early cancel")))
    if failure == "cleanup":
        terminal = service._mark_dispatch_archive_terminal

        async def unavailable(*args, **kwargs):
            with monkeypatch.context() as patch:
                patch.setattr(bd, "async_session", MagicMock(side_effect=OSError("SECRET-database-error")))
                await terminal(*args, **kwargs)

        monkeypatch.setattr(service, "_mark_dispatch_archive_terminal", unavailable)
    try:
        if owner == "direct":
            await asyncio.wait_for(service._run_active_job(job), 20)
        else:
            from backend.app.services.print_scheduler import PrintScheduler

            original_process = service._process_job

            async def observe(actual_job):
                nonlocal job
                job = actual_job
                await original_process(job)

            monkeypatch.setattr(service, "_process_job", observe)
            monkeypatch.setattr(bd, "background_dispatch", service)
            await asyncio.wait_for(
                PrintScheduler()._dispatch_and_finalize(
                    queue_item_id=item_id,
                    printer_id=printer_id,
                    printer_name=printer.name,
                    printer_serial=printer.serial_number,
                    dispatch_kind=kind,
                    dispatch_source_id=source_id,
                    dispatch_source_name=source.filename,
                    options=job.options,
                    requested_by_user_id=None,
                    project_id=None,
                    project_line_id=None,
                    job_name_short="part",
                    swap_events=[],
                ),
                20,
            )
    finally:
        # Allow assertions and teardown to use the real database, even when the
        # isolated terminal writer was deliberately unavailable.
        monkeypatch.setattr(bd, "async_session", factory)
    assert job.completion_event.is_set()
    cancelled = failure in {"cancel", "early_cancel", "cleanup"}
    successful = failure in {"success", "late_cancel"}
    assert job.outcome["cancelled"] is cancelled, job.outcome
    assert job.outcome["success"] is successful, job.outcome
    assert "greenlet" not in str(job.outcome).lower()
    if failure == "upload":
        assert "upload" in job.outcome["error"].lower()
    if failure == "start":
        assert job.outcome["error"] == "Failed to start print"
    async with factory() as check:
        archives = (await check.scalars(select(PrintArchive).order_by(PrintArchive.id))).all()
        execution = [archive for archive in archives if archive.id != source_archive_id]
        if failure == "early":
            assert execution == [] and job.execution_archive_id is None
        else:
            assert len(execution) == 1
            assert job.outcome["archive_id"] == job.execution_archive_id == execution[0].id
            expected = "printing" if successful or failure == "cleanup" else "cancelled" if cancelled else "failed"
            assert execution[0].status == expected
        if source_archive_id:
            assert (await check.get(PrintArchive, source_archive_id)).status == "completed"
        current = await check.get(PrintQueueItem, item_id)
        header = await check.get(type(queue), queue_id)
        if successful:
            assert current.status == "printing" and header.current_item_id == item_id
        else:
            assert current.status == ("cancelled" if cancelled else "failed")
            assert header.current_item_id is None
    assert mqtt._client.publish.call_count == int(successful)
    if cancelled or successful:
        notifications.assert_not_awaited()
    else:
        notifications.assert_awaited_once()
    if failure == "cleanup":
        assert "SECRET-database-error" not in caplog.text
        assert "terminal" in caplog.text.lower()
    if register.called and not successful:
        withdraw.assert_called_once()


async def test_terminal_writer_does_not_overwrite_concurrent_completion(
    test_engine, archive_factory, printer_factory, monkeypatch
):
    from contextlib import asynccontextmanager

    from backend.app.services import archive_write_scope as scopes

    printer = await printer_factory()
    archive = await archive_factory(printer.id, status="printing")
    archive_id = archive.id
    factory = async_sessionmaker(test_engine, expire_on_commit=False)
    monkeypatch.setattr(bd, "async_session", factory)
    attempted = asyncio.Event()
    original_scope = scopes.archive_write_scope

    if test_engine.dialect.name == "postgresql":

        class NoProcessLock:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

        # Emulate two processes: only PostgreSQL may serialize these writers.
        monkeypatch.setitem(scopes._archive_locks, archive_id, NoProcessLock())

    @asynccontextmanager
    async def observed_scope(*args, **kwargs):
        attempted.set()
        async with original_scope(*args, **kwargs):
            yield

    def before_update(connection, cursor, statement, parameters, context, many):
        # Old code skips the scope and blocks only on its unconditional UPDATE.
        # Observe that attempt as well so the old code fails on lost state,
        # rather than on an instrumentation timeout.
        if statement.lstrip().upper().startswith("UPDATE") and "cancelled" in str(parameters):
            attempted.set()

    event.listen(test_engine.sync_engine, "before_cursor_execute", before_update)
    try:
        async with factory() as winner:
            async with original_scope(winner, archive_id):
                row = await winner.get(PrintArchive, archive_id)
                row.status = "completed"
                await winner.flush()
                monkeypatch.setattr(scopes, "archive_write_scope", observed_scope)
                cleanup = asyncio.create_task(
                    bd.BackgroundDispatchService._mark_dispatch_archive_terminal(archive_id, "cancelled", "old attempt")
                )
                await asyncio.wait_for(attempted.wait(), 5)
                assert not cleanup.done(), "the terminal writer must wait for completion's transaction"
                if test_engine.dialect.name == "postgresql":
                    async with factory() as monitor:
                        async with asyncio.timeout(5):
                            while not await monitor.scalar(
                                text(
                                    "SELECT count(*) FROM pg_stat_activity "
                                    "WHERE application_name = current_setting('application_name') "
                                    "AND wait_event_type = 'Lock'"
                                )
                            ):
                                await asyncio.sleep(0.01)
                await winner.commit()
            await asyncio.wait_for(cleanup, 5)
        async with factory() as check:
            assert (await check.get(PrintArchive, archive_id)).status == "completed"
    finally:
        event.remove(test_engine.sync_engine, "before_cursor_execute", before_update)
