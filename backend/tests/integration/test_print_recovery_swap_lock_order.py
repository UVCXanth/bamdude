"""T9.7 R4 on the INTEGRATED copy (swap T9 + operator print-state recovery): one archive-then-lane order, SQLite.

Real file SQLite, two connections, the process-local locks ON. Each scenario holds one writer at a named point
while the other starts, then lets go; a stall shows up as the wait running out (well under SQLite's 15 s busy
timeout), never as a slow pass. The writers are the production ones: ``print_state_recovery_store.apply_preview``
(operator recovery), ``swap_job_refresh.refresh``, ``swap_terminal.claim_change_table``, the terminal autorepair
``print_reconciliation._repair_terminal_queue_items`` and ``ArchiveService.delete_archive``.

Collected after T9 is integrated; before that the module is explicitly skipped because its writers do not exist.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock

import pytest

pytest.importorskip("backend.app.services.swap_terminal", reason="these integrated scenarios require the T9 branch")

from backend.app.models.archive import PrintArchive
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer_queue import PrinterQueue
from backend.app.services import swap_job_refresh as jobs, swap_source_declarations as decl, swap_terminal
from backend.tests.integration.test_swap_declaration_service import (  # noqa: F401 -- fixtures
    ALL,
    a_3mf,
    a_user,
    actor_of,
    an_archive,
    clean_spool_state,
    declare,
    factory,
)
from backend.tests.integration.test_swap_job_refresh import QUEUE_ALL, a_job, a_printer_queue, by_id, ref

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]

DONE_WITHIN = 8


@pytest.fixture
def telemetry(monkeypatch):
    """An idle, connected printer with nothing in flight: what recovery and the autorepair read live."""
    from backend.app.services.background_dispatch import background_dispatch
    from backend.app.services.bambu_mqtt import PrinterState
    from backend.app.services.print_scheduler import scheduler
    from backend.app.services.printer_manager import printer_manager

    state = PrinterState(connected=True, state="IDLE", connection_generation=1)
    monkeypatch.setattr(printer_manager, "peek_status", Mock(return_value=(state, 10.0, False)))
    monkeypatch.setattr(scheduler, "has_dispatch_in_flight", Mock(return_value=False))
    monkeypatch.setattr(background_dispatch, "has_work_for_printer", Mock(return_value=False))
    return state


async def a_stuck_run(factory, queue_id: int) -> tuple[int, int]:
    """A run whose archive ended while its queue row still says printing: what recovery aligns."""
    started = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=2)
    async with factory() as db:
        archive = PrintArchive(
            printer_id=queue_id,
            queue_id=queue_id,
            filename="stuck.gcode.3mf",
            file_path="",
            file_size=0,
            status="completed",
            started_at=started,
            completed_at=started + timedelta(hours=1),
            print_time_seconds=3600,
            extra_data={},
        )
        db.add(archive)
        await db.flush()
        item = PrintQueueItem(queue_id=queue_id, archive_id=archive.id, status="printing", started_at=started)
        db.add(item)
        await db.flush()
        queue = await db.get(PrinterQueue, queue_id)
        queue.status, queue.current_item_id = "printing", item.id
        await db.commit()
        return archive.id, item.id


async def a_recovery_payload(factory, printer_id: int, item_id: int) -> dict:
    from backend.app.services import print_state_recovery_preview as tokens, print_state_recovery_store as store

    async with factory() as db:
        preview = await store.make_preview(
            db, printer_id, "item", item_id, "align_terminal_item", "user:1", confirmed_completed=True
        )
    return tokens.verify(preview["preview_token"])


async def a_declared_source_on(factory, tmp_path, queue_id: int, user):
    path = tmp_path / f"{uuid.uuid4().hex[:6]}.gcode.3mf"
    a_3mf(path, path.name)
    archive_id = await an_archive(factory, path, owner=user)
    job_id = await a_job(factory, archive_id, queue_id=queue_id)
    seen = await decl.inspect("archive", archive_id, actor=actor_of(user), rights=ALL)
    await declare("archive", archive_id, seen, user)
    listing = await jobs.candidates("archive", archive_id, actor=actor_of(user), rights=ALL, job_rights=QUEUE_ALL)
    return archive_id, job_id, listing


def _refresh(archive_id, job_id, listing, user):
    return jobs.refresh(
        "archive",
        archive_id,
        declaration_id=listing["declaration_id"],
        source_revision=listing["source_revision"],
        jobs=[ref(by_id(listing, "queue", job_id))],
        operation_id=str(uuid.uuid4()),
        actor=actor_of(user),
        rights=ALL,
        job_rights=QUEUE_ALL,
    )


async def _both_finish(first: asyncio.Task, second_start, *, release: asyncio.Event) -> list:
    """``first`` is held; start the second writer, give it time to take what it takes, release ``first``, and require
    both to finish well inside SQLite's busy timeout."""
    second = asyncio.ensure_future(second_start())
    try:
        await asyncio.sleep(0.5)
        release.set()
        return await asyncio.wait_for(asyncio.gather(first, second, return_exceptions=True), DONE_WITHIN)
    finally:
        release.set()
        for task in (first, second):
            if not task.done():
                task.cancel()


def _held(monkeypatch, module, name):
    """Wrap ``module.name`` (an async callable) so its FIRST call signals and waits for a release."""
    real = getattr(module, name)
    holds, release, calls = asyncio.Event(), asyncio.Event(), [0]

    async def held(*args, **kwargs):
        calls[0] += 1
        if calls[0] == 1:
            holds.set()
            await release.wait()
        return await real(*args, **kwargs)

    monkeypatch.setattr(module, name, held)
    return holds, release


# --- operator recovery against T9's writers on the same printer lane ---------------------------------------------------


async def test_operator_recovery_and_a_refresh_of_another_archive_on_its_lane_both_finish(
    factory, tmp_path, monkeypatch, telemetry
):
    from backend.app.services import print_state_recovery_store as store

    user = await a_user(factory)
    queue_id = await a_printer_queue(factory)
    _stuck_archive, item_id = await a_stuck_run(factory, queue_id)
    source_id, job_id, listing = await a_declared_source_on(factory, tmp_path, queue_id, user)
    payload = await a_recovery_payload(factory, queue_id, item_id)

    # Recovery held once its archive guard is taken (on SQLite: its writer), before its lane.
    holds, release = _held(monkeypatch, store, "load_active_archive_for_write")
    from backend.app.core.database import async_session

    operator = asyncio.ensure_future(store.apply_preview(async_session, payload, "user:1", "Operator"))
    await asyncio.wait_for(holds.wait(), DONE_WITHIN)
    results = await _both_finish(operator, lambda: _refresh(source_id, job_id, listing, user), release=release)
    assert not [r for r in results if isinstance(r, BaseException)], [repr(r) for r in results]


async def test_operator_recovery_and_a_change_table_claim_of_another_archive_on_its_lane_both_finish(
    factory, tmp_path, monkeypatch, telemetry
):
    from backend.app.services import print_state_recovery_store as store

    user = await a_user(factory)
    queue_id = await a_printer_queue(factory)
    _stuck_archive, item_id = await a_stuck_run(factory, queue_id)
    owed_archive, _job, _listing = await a_declared_source_on(factory, tmp_path, queue_id, user)
    async with factory() as db:  # a run on this lane still owes its table change
        archive = await db.get(PrintArchive, owed_archive)
        archive.extra_data = {**(archive.extra_data or {}), "swap_macro_events_pending": ["swap_mode_change_table"]}
        await db.commit()
    payload = await a_recovery_payload(factory, queue_id, item_id)

    holds, release = _held(monkeypatch, store, "load_active_archive_for_write")
    from backend.app.core.database import async_session

    operator = asyncio.ensure_future(store.apply_preview(async_session, payload, "user:1", "Operator"))
    await asyncio.wait_for(holds.wait(), DONE_WITHIN)
    try:
        results = await _both_finish(
            operator,
            lambda: swap_terminal.claim_change_table(
                factory, owed_archive, queue_id=queue_id, owner="test", allow_absent=True
            ),
            release=release,
        )
    finally:
        swap_terminal._sending.discard(owed_archive)
    assert not [r for r in results if isinstance(r, BaseException)], [repr(r) for r in results]


# --- the terminal autorepair against a change_table claim -------------------------------------------------------------


async def test_the_autorepair_over_two_archives_and_a_claim_of_one_of_them_both_finish(
    factory, tmp_path, monkeypatch, telemetry
):
    """The autorepair takes every printing archive of the queue, ascending, then the lane; a claim of the second one
    takes that archive, then the lane. Each in its own order would hold what the other waits for."""
    from backend.app.services import archive_write_scope, print_reconciliation

    queue_id = await a_printer_queue(factory)
    first_archive, _first_item = await a_stuck_run(factory, queue_id)
    second_archive, _second_item = await a_stuck_run(factory, queue_id)
    assert first_archive < second_archive
    async with factory() as db:
        archive = await db.get(PrintArchive, second_archive)
        archive.extra_data = {"swap_macro_events_pending": ["swap_mode_change_table"]}
        await db.commit()
    holds, release = _held(monkeypatch, archive_write_scope, "load_active_archive_for_write")

    async def autorepair():
        from backend.app.core.database import async_session

        async with async_session() as db:
            repaired = await print_reconciliation._repair_terminal_queue_items(db, queue_id, "IDLE")
            await db.commit()
            return repaired

    repairing = asyncio.ensure_future(autorepair())
    await asyncio.wait_for(holds.wait(), DONE_WITHIN)
    try:
        results = await _both_finish(
            repairing,
            lambda: swap_terminal.claim_change_table(
                factory, second_archive, queue_id=queue_id, owner="test", allow_absent=True
            ),
            release=release,
        )
    finally:
        swap_terminal._sending.discard(second_archive)
    assert not [r for r in results if isinstance(r, BaseException)], [repr(r) for r in results]


# --- an archive's hard delete against a refresh of its jobs -----------------------------------------------------------


async def test_a_hard_delete_and_a_refresh_of_its_jobs_both_finish(factory, tmp_path, monkeypatch, telemetry):
    from backend.app.services import queue_source_release
    from backend.app.services.archive import ArchiveService

    user = await a_user(factory)
    queue_id = await a_printer_queue(factory)
    source_id, job_id, listing = await a_declared_source_on(factory, tmp_path, queue_id, user)
    holds, release = _held(monkeypatch, queue_source_release, "source_purged")

    async def delete():
        from backend.app.core.database import async_session

        async with async_session() as db:
            assert await ArchiveService(db).delete_archive(source_id)
            await db.commit()

    deleting = asyncio.ensure_future(delete())
    await asyncio.wait_for(holds.wait(), DONE_WITHIN)
    results = await _both_finish(deleting, lambda: _refresh(source_id, job_id, listing, user), release=release)
    assert results[0] is None, repr(results[0])
    # The refresh found its source gone: a typed refusal, never a stall, a deadlock or an error.
    from fastapi import HTTPException

    assert isinstance(results[1], HTTPException) and results[1].status_code in (404, 409), repr(results[1])
