"""How a dispatch attempt ends: the printer's answers, the swap-start veto, the phase and the budget.

Spec: vault ``60-specs/post-rebuild-dispatch-transactions-spec.md`` — D-R3 (phase),
D-R4 (three negative answers, one veto for every automatic pending), D-R5 (the
budget is spent at the claim, given back only by a typed refusal before publish,
opened again by the operator's Retry), acceptance rows D05–D08. The real scheduler
and runners, device I/O faked (the harness of ``test_dispatch_without_original``).
"""

from __future__ import annotations

from datetime import datetime
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from backend.app.models.archive import PrintArchive
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer_queue import PrinterQueue
from backend.tests.integration.test_dispatch_attempt_outcome import a_queued_job, execution_archive, reread
from backend.tests.integration.test_dispatch_without_original import (  # noqa: F401 - fixtures
    clean_spool_state,
    dispatch_mocks,
    drain,
    scheduler_with_captured_dispatch,
    sessions,
)

pytestmark = pytest.mark.integration


async def a_job_and_its_dispatch(db_session, test_engine, tmp_path, printer_factory, monkeypatch, kind="library"):
    printer_id, queue_id, mqtt, item_id = await a_queued_job(db_session, tmp_path, printer_factory, monkeypatch, kind)
    service = dispatch_mocks(monkeypatch, async_sessionmaker(test_engine, expire_on_commit=False))
    scheduler, spawned = scheduler_with_captured_dispatch(monkeypatch)
    return queue_id, mqtt, item_id, service, scheduler, spawned


async def one_tick(scheduler, spawned):
    await scheduler.check_queue()
    await drain(spawned)


# --------------------------------------------------------------------------- #
# D05 — the printer's three negative answers end the attempt with their class
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("answer", "code"),
    [
        ("no_acknowledgement", "dispatchNoAcknowledgement"),
        ("file_received", "dispatchAcceptedNotStarted"),
        ("stalled_after_accept", "dispatchAcceptedNotStarted"),
    ],
)
@pytest.mark.parametrize("kind", ["library", "archive"])
async def test_a_negative_answer_fails_the_attempt_with_its_class_and_halts_the_queue(
    db_session, test_engine, tmp_path, printer_factory, monkeypatch, sessions, kind, answer, code
):
    queue_id, mqtt, item_id, service, scheduler, spawned = await a_job_and_its_dispatch(
        db_session, test_engine, tmp_path, printer_factory, monkeypatch, kind
    )
    monkeypatch.setattr(service, "_await_print_response", AsyncMock(return_value=answer))

    await one_tick(scheduler, spawned)

    mqtt._client.publish.assert_called_once()
    row = await reread(db_session, PrintQueueItem, item_id)
    assert row.status == "failed" and row.error_code == code, row.error_message
    assert row.dispatch_attempts == 1  # the claim spent it; a published start gives nothing back
    status, _message, _extra = await execution_archive(db_session)
    assert status == "failed"
    failure = (
        await db_session.execute(select(PrintArchive.failure_reason).where(PrintArchive.status == "failed"))
    ).scalar_one()
    assert failure == code
    assert (await db_session.get(PrinterQueue, queue_id)).status == "error"

    # Never sent twice by itself: the halted queue waits for the operator.
    await one_tick(scheduler, spawned)
    mqtt._client.publish.assert_called_once()


# --------------------------------------------------------------------------- #
# D05 — one veto for every automatic pending: a swap start that ran
# --------------------------------------------------------------------------- #


async def test_a_refusal_after_the_swap_start_ran_fails_instead_of_waiting(
    db_session, test_engine, tmp_path, printer_factory, monkeypatch, sessions
):
    import backend.app.services.background_dispatch as bd
    from backend.app.services.filament_routing import RoutingDeferred

    queue_id, mqtt, item_id, service, scheduler, spawned = await a_job_and_its_dispatch(
        db_session, test_engine, tmp_path, printer_factory, monkeypatch
    )

    async def the_start_macro_ran(job, printer, event, message, *, record=None):
        if event == "swap_mode_start":
            job.swap_start_effect = "fired"
            if record is not None:
                await record("fired")

    monkeypatch.setattr(service, "_run_swap_macro_if_needed", the_start_macro_ran)
    monkeypatch.setattr(bd, "settle_plan", AsyncMock(side_effect=RoutingDeferred("feed_settle_timeout")))

    await one_tick(scheduler, spawned)

    mqtt._client.publish.assert_not_called()
    row = await reread(db_session, PrintQueueItem, item_id)
    assert row.status == "failed" and row.error_code == "dispatchStartRefused"
    assert "swap start macro" in row.error_message
    assert row.dispatch_attempts == 1  # no attempt is given back over a physical effect
    status, _message, _extra = await execution_archive(db_session)
    assert status == "failed"
    assert (await db_session.get(PrinterQueue, queue_id)).status == "error"


async def test_the_same_refusal_without_a_swap_start_waits_and_returns_its_attempt(
    db_session, test_engine, tmp_path, printer_factory, monkeypatch, sessions
):
    import backend.app.services.background_dispatch as bd
    from backend.app.services.filament_routing import RoutingDeferred

    queue_id, mqtt, item_id, _service, scheduler, spawned = await a_job_and_its_dispatch(
        db_session, test_engine, tmp_path, printer_factory, monkeypatch
    )
    monkeypatch.setattr(bd, "settle_plan", AsyncMock(side_effect=RoutingDeferred("feed_settle_timeout")))

    await one_tick(scheduler, spawned)

    row = await reread(db_session, PrintQueueItem, item_id)
    assert row.status == "pending" and row.dispatch_attempts == 0 and row.error_code is None
    status, _message, extra = await execution_archive(db_session)
    assert status == "cancelled" and extra["dispatch_aborted"] is True
    assert (await db_session.get(PrinterQueue, queue_id)).status == "idle"


# --------------------------------------------------------------------------- #
# D07 — the phase: a ``sending`` mark that cannot be written forbids the send
# --------------------------------------------------------------------------- #


async def test_a_lost_sending_mark_sends_nothing(
    db_session, test_engine, tmp_path, printer_factory, monkeypatch, sessions
):
    import backend.app.services.background_dispatch as bd
    from backend.app.services import dispatch_phase

    _queue_id, _mqtt, item_id, _service, scheduler, spawned = await a_job_and_its_dispatch(
        db_session, test_engine, tmp_path, printer_factory, monkeypatch
    )
    real_advance = dispatch_phase.advance

    async def advance(db, archive_id, to, *, boot_id):
        if to == dispatch_phase.SENDING:
            return False
        return await real_advance(db, archive_id, to, boot_id=boot_id)

    monkeypatch.setattr(bd.dispatch_phase, "advance", advance)
    start = MagicMock(return_value=True)
    monkeypatch.setattr(bd.printer_manager, "start_print", start)

    await one_tick(scheduler, spawned)

    start.assert_not_called()
    row = await reread(db_session, PrintQueueItem, item_id)
    assert row.status == "failed" and row.error_code == "dispatchInternalError"


async def test_the_phase_follows_the_attempt_to_accepted(
    db_session, test_engine, tmp_path, printer_factory, monkeypatch, sessions
):
    _queue_id, _mqtt, _item_id, _service, scheduler, spawned = await a_job_and_its_dispatch(
        db_session, test_engine, tmp_path, printer_factory, monkeypatch
    )

    await one_tick(scheduler, spawned)

    db_session.expire_all()
    phase = (
        await db_session.execute(select(PrintArchive.dispatch_phase).where(PrintArchive.status == "printing"))
    ).scalar_one()
    assert phase == "accepted"


# --------------------------------------------------------------------------- #
# D08 — the budget: spent at the claim, given back by a typed refusal, opened by Retry
# --------------------------------------------------------------------------- #


async def test_repeated_refusals_never_exhaust_the_budget(
    db_session, test_engine, tmp_path, printer_factory, monkeypatch, sessions
):
    import backend.app.services.background_dispatch as bd
    from backend.app.services.print_scheduler import DISPATCH_MAX_ATTEMPTS

    _queue_id, _mqtt, item_id, _service, scheduler, spawned = await a_job_and_its_dispatch(
        db_session, test_engine, tmp_path, printer_factory, monkeypatch
    )
    start = MagicMock(return_value=False)
    monkeypatch.setattr(bd.printer_manager, "start_print", start)

    for _ in range(DISPATCH_MAX_ATTEMPTS + 1):
        await one_tick(scheduler, spawned)
        row = await reread(db_session, PrintQueueItem, item_id)
        assert row.status == "pending" and row.dispatch_attempts == 0

    assert start.call_count == DISPATCH_MAX_ATTEMPTS + 1


async def test_attempts_a_crash_spent_end_in_a_visible_failure_and_a_retry_opens_a_new_budget(
    db_session, test_engine, tmp_path, printer_factory, monkeypatch, sessions
):
    import backend.app.services.background_dispatch as bd
    from backend.app.api.routes.print_queue import retry_failed_item
    from backend.app.services.print_scheduler import DISPATCH_MAX_ATTEMPTS

    queue_id, _mqtt, item_id, _service, scheduler, spawned = await a_job_and_its_dispatch(
        db_session, test_engine, tmp_path, printer_factory, monkeypatch
    )
    claimed_before = datetime(2026, 10, 1, 12, 0)
    row = await db_session.get(PrintQueueItem, item_id)
    row.dispatch_attempts = DISPATCH_MAX_ATTEMPTS  # three crashes mid-dispatch spent them
    row.started_at = claimed_before
    await db_session.commit()
    start = MagicMock(return_value=True)
    monkeypatch.setattr(bd.printer_manager, "start_print", start)

    await one_tick(scheduler, spawned)

    start.assert_not_called()
    row = await reread(db_session, PrintQueueItem, item_id)
    assert row.status == "failed" and row.error_code == "dispatchInternalError"
    assert "budget" in row.error_message
    assert (await db_session.get(PrinterQueue, queue_id)).status == "error"

    await retry_failed_item(item_id, db=db_session, _=None)
    row = await reread(db_session, PrintQueueItem, item_id)
    assert row.status == "pending" and row.dispatch_attempts == 0
    assert row.error_code is None and row.error_message is None
    # The proof of an earlier dispatch survives the Retry (swap_job_refresh reads it).
    assert row.started_at == claimed_before
    # A Retry is not a Resume: the halted queue stays halted.
    assert (await db_session.get(PrinterQueue, queue_id)).status == "error"


# --------------------------------------------------------------------------- #
# D06 — a shutdown is not a failed print
# --------------------------------------------------------------------------- #


async def test_a_shutdown_or_an_unknown_outcome_announces_no_failure(monkeypatch):
    import backend.app.services.background_dispatch as bd

    notify = AsyncMock()
    monkeypatch.setattr("backend.app.services.notification_service.notification_service.on_queue_job_failed", notify)
    job = bd.PrintDispatchJob(
        id=1, kind="print_library_file", source_id=1, source_name="lamp", printer_id=1, printer_name="P"
    )
    job.send_fact = bd.SEND_SENT
    job.interrupted = True
    await bd.report_failure_if_unwatched(job)
    notify.assert_not_awaited()

    job.interrupted = False
    job.outcome["uncertain"] = True
    await bd.report_failure_if_unwatched(job)
    notify.assert_not_awaited()
