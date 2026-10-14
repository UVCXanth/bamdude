"""Our owed change_table goes out at most once, only for the run that still holds its printer (Codex review r1).

One durable claim per execution archive (``bamdude_terminal_effects["swap_change_table"]``) decides whether the
physical command may leave: the sweep's ordinary close records it ``owed`` (nothing can have attempted it while the
archive was still printing), a compare-and-set under the dispatch lane's lock moves it to ``attempted`` and COMMITS
before the command, and the finish records ``finished`` / ``failed`` together with the pending event. A second owner
stands down; a claim nobody alive is sending holds the queue, never retries. The run proof is the exact queue claim
-- the printer's queue still printing that run -- checked in the compare-and-set and again before any release, pause
or cleanup. Every error ends in a hold; an interrupted sweep is found again at the next connect edge.

The first six tests are Codex's acceptance counterexamples (r1), kept as they were written.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from backend.app.models.archive import PrintArchive
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer_queue import PrinterQueue
from backend.app.services import print_reconciliation as recovery
from backend.tests.integration.swap_terminal_support import (
    CHANGE_TABLE,
    an_execution,
    an_owed_run_closed,
    archive_of,
    close_only,
    complete,
    make_rig,  # noqa: F401 -- the fixture
    queue_status,
)

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]


def stage_of(archive) -> str | None:
    effect = ((archive.extra_data or {}).get("bamdude_terminal_effects") or {}).get("swap_change_table")
    return effect.get("stage") if isinstance(effect, dict) else None


def hold_of(archive) -> str | None:
    return ((archive.extra_data or {}).get("swap_hold") or {}).get("reason")


def pending_of(archive) -> list:
    return list((archive.extra_data or {}).get("swap_macro_events_pending") or [])


async def a_new_claim(rig) -> int:
    """Another job takes the printer: printing, the queue's current item, its execution archive not created yet."""
    async with rig.db() as db:
        other = PrintQueueItem(
            queue_id=rig.queue_id, status="printing", position=1, started_at=datetime.now(timezone.utc)
        )
        db.add(other)
        await db.flush()
        queue = await db.get(PrinterQueue, rig.queue_id)
        queue.status, queue.current_item_id = "printing", other.id
        await db.commit()
        return other.id


async def the_queue(rig) -> tuple[str, int | None]:
    async with rig.db() as db:
        queue = await db.get(PrinterQueue, rig.queue_id)
        return queue.status, queue.current_item_id


def spawned_tasks(monkeypatch) -> list:
    tasks: list = []

    def spawn(coro, *, name):
        task = asyncio.create_task(coro)
        tasks.append(task)
        return task

    monkeypatch.setattr("backend.app.core.tasks.spawn_background_task", spawn)
    return tasks


# --- Codex's acceptance counterexamples (r1) -------------------------------------------------------------------------


async def test_a_sweep_interrupted_after_send_does_not_send_again(make_rig):
    rig = await make_rig(require_plate_clear=False)
    archive_id, _ = await an_execution(rig, fact=False, pending=[CHANGE_TABLE], bound=False)
    await close_only(rig, archive_id)
    calls = []

    async def send(*args, **kwargs):
        calls.append(args)
        if len(calls) == 1:
            raise asyncio.CancelledError("process stops after physical send")
        return True, "ok"

    rig.macro.side_effect = send
    with pytest.raises(asyncio.CancelledError):
        await recovery._resolve_pending_swaps(rig.printer_id, [archive_id])
    await recovery._resolve_pending_swaps(rig.printer_id, [archive_id])
    assert len(calls) == 1, "a restarted sweep physically repeated change_table"
    assert await queue_status(rig) == "paused"


async def test_two_sweeps_cannot_both_send_the_same_change_table(make_rig):
    rig = await make_rig(require_plate_clear=False)
    archive_id, _ = await an_execution(rig, fact=False, pending=[CHANGE_TABLE], bound=False)
    await close_only(rig, archive_id)
    first = asyncio.Event()
    release = asyncio.Event()
    calls = []

    async def send(*args, **kwargs):
        calls.append(args)
        first.set()
        await release.wait()
        return True, "ok"

    rig.macro.side_effect = send
    one = asyncio.create_task(recovery._resolve_pending_swaps(rig.printer_id, [archive_id]))
    await asyncio.wait_for(first.wait(), 5)
    two = asyncio.create_task(recovery._resolve_pending_swaps(rig.printer_id, [archive_id]))
    # Let the second reach the same hardware barrier (or wait behind an ownership lock).
    for _ in range(100):
        if len(calls) > 1 or two.done():
            break
        await asyncio.sleep(0.01)
    release.set()
    await asyncio.wait_for(asyncio.gather(one, two), 5)
    assert len(calls) == 1, "two overlapping sweeps both sent change_table"


async def test_sweep_lookup_exception_holds_with_a_reason(make_rig, monkeypatch):
    rig = await make_rig(require_plate_clear=False)
    archive_id, _ = await an_execution(rig, fact=False, pending=[CHANGE_TABLE], bound=False)
    await close_only(rig, archive_id)
    monkeypatch.setattr(
        "backend.app.services.macro_executor.find_swap_macro", AsyncMock(side_effect=RuntimeError("lookup failed"))
    )
    await recovery._resolve_pending_swaps(rig.printer_id, [archive_id])
    assert await queue_status(rig) == "paused", (
        "exception leaves the printer stuck as printing without an actionable hold"
    )


async def test_connect_edge_recovers_an_interrupted_sweep_as_a_hold(make_rig):
    rig = await make_rig(require_plate_clear=False)
    archive_id, _ = await an_execution(rig, fact=False, pending=[CHANGE_TABLE], bound=False)
    await close_only(rig, archive_id)
    rig.macro.side_effect = asyncio.CancelledError("stopped after send")
    with pytest.raises(asyncio.CancelledError):
        await recovery._resolve_pending_swaps(rig.printer_id, [archive_id])
    rig.macro.side_effect = None
    await recovery.reconcile_printer_prints(rig.printer_id, "FINISH", "job.gcode.3mf")
    assert await queue_status(rig) == "paused", "completed archive/pending/claim is invisible to connect-edge recovery"


async def test_two_actual_connect_edges_do_not_send_twice(make_rig, monkeypatch):
    rig = await make_rig(require_plate_clear=False)
    await an_execution(rig, fact=False, pending=[CHANGE_TABLE], bound=False)
    monkeypatch.setattr(recovery, "_grace_seconds", AsyncMock(return_value=0))
    monkeypatch.setattr(recovery, "_load_objects_for_a_print_already_running", AsyncMock())
    original_close = recovery._reconcile_complete_archive
    arrived = 0
    both_read = asyncio.Event()
    release_macro = asyncio.Event()
    sent = []
    tasks = spawned_tasks(monkeypatch)

    async def close(*args, **kwargs):
        nonlocal arrived
        arrived += 1
        if arrived == 2:
            both_read.set()
        await asyncio.wait_for(both_read.wait(), 5)
        return await original_close(*args, **kwargs)

    async def send(*args, **kwargs):
        sent.append(args)
        await release_macro.wait()
        return True, "ok"

    monkeypatch.setattr(recovery, "_reconcile_complete_archive", close)
    rig.macro.side_effect = send
    await asyncio.wait_for(
        asyncio.gather(
            *[recovery.reconcile_printer_prints(rig.printer_id, "FINISH", "job.gcode.3mf") for _ in range(2)]
        ),
        10,
    )
    for _ in range(100):
        if len(sent) > 1:
            break
        await asyncio.sleep(0.01)
    release_macro.set()
    await asyncio.wait_for(asyncio.gather(*tasks), 10)
    assert len(sent) == 1, "two connect-edge entry calls each sent the same physical macro"


async def test_a_new_queue_claim_is_not_the_old_run(make_rig):
    rig = await make_rig(require_plate_clear=False)
    archive_id, _ = await an_execution(rig, fact=False, pending=[CHANGE_TABLE], bound=False)
    await close_only(rig, archive_id)
    other_id = await a_new_claim(rig)
    await recovery._resolve_pending_swaps(rig.printer_id, [archive_id])
    async with rig.db() as db:
        queue = await db.get(PrinterQueue, rig.queue_id)
        observed = (rig.macro.await_count, queue.status, queue.current_item_id)
    assert observed == (0, "printing", other_id), "old sweep sends and releases another job's claim"


# --- the claim itself ------------------------------------------------------------------------------------------------


async def test_the_close_records_the_swap_as_owed_and_the_claim_is_committed_before_the_command(make_rig):
    rig = await make_rig(require_plate_clear=False)
    archive_id, _ = await an_owed_run_closed(rig)
    assert stage_of(await archive_of(rig, archive_id)) == "owed"
    seen: list = []

    async def send(*args, **kwargs):
        seen.append(stage_of(await archive_of(rig, archive_id)))  # another session: only what was committed
        return True, "ok"

    rig.macro.side_effect = send
    await recovery._resolve_pending_swaps(rig.printer_id, [archive_id])

    assert seen == ["attempted"]
    archive = await archive_of(rig, archive_id)
    assert stage_of(archive) == "finished"
    assert CHANGE_TABLE not in pending_of(archive)
    assert await queue_status(rig) == "idle"


async def test_a_claim_that_cannot_be_taken_sends_nothing(make_rig, monkeypatch):
    from backend.app.services import swap_terminal

    rig = await make_rig(require_plate_clear=False)
    archive_id, _ = await an_owed_run_closed(rig)
    monkeypatch.setattr(swap_terminal, "load_active_archive_for_write", AsyncMock(side_effect=RuntimeError("locked")))

    await recovery._resolve_pending_swaps(rig.printer_id, [archive_id])

    assert rig.macro.await_count == 0
    archive = await archive_of(rig, archive_id)
    assert CHANGE_TABLE in pending_of(archive)
    assert hold_of(archive) == "swap_hold_macro_error"
    assert await queue_status(rig) == "paused"


async def test_a_new_claim_between_the_lookup_and_the_command_stops_it(make_rig, monkeypatch):
    rig = await make_rig(require_plate_clear=False)
    archive_id, _ = await an_owed_run_closed(rig)
    taken: list = []

    async def lookup_while_another_job_starts(db, event, printer):
        taken.append(await a_new_claim(rig))
        return SimpleNamespace(name="Change table", gcode="G28 ; change table")

    monkeypatch.setattr("backend.app.services.macro_executor.find_swap_macro", lookup_while_another_job_starts)

    await recovery._resolve_pending_swaps(rig.printer_id, [archive_id])

    assert rig.macro.await_count == 0
    assert await the_queue(rig) == ("printing", taken[0])
    archive = await archive_of(rig, archive_id)
    assert stage_of(archive) == "owed"
    assert hold_of(archive) == "swap_hold_run_unproven"


async def test_a_dispatch_during_the_macro_wait_is_fenced(make_rig, monkeypatch):
    from backend.app.services.print_scheduler import scheduler

    rig = await make_rig(require_plate_clear=False)
    archive_id, _ = await an_owed_run_closed(rig)
    answers: list = []

    async def send(*args, may_run=None, **kwargs):
        answers.append(may_run())
        monkeypatch.setattr(scheduler, "has_dispatch_in_flight", lambda printer_id: printer_id == rig.printer_id)
        answers.append(may_run())
        return False, "stopped"

    rig.macro.side_effect = send
    await recovery._resolve_pending_swaps(rig.printer_id, [archive_id])

    assert answers == [True, False]
    assert stage_of(await archive_of(rig, archive_id)) == "failed"


@pytest.mark.parametrize("answer", [(True, "ok"), (False, "no ACK")])
async def test_a_claim_lost_during_the_command_is_left_to_its_new_owner(answer, make_rig):
    rig = await make_rig(require_plate_clear=False)
    archive_id, run_id = await an_owed_run_closed(rig)
    taken: list = []

    async def send(*args, **kwargs):
        taken.append(await a_new_claim(rig))
        return answer

    rig.macro.side_effect = send
    await recovery._resolve_pending_swaps(rig.printer_id, [archive_id])

    assert rig.macro.await_count == 1
    assert await the_queue(rig) == ("printing", taken[0]), "the old run released or paused the new job's claim"
    archive = await archive_of(rig, archive_id)
    assert stage_of(archive) == ("finished" if answer[0] else "failed")
    assert CHANGE_TABLE not in pending_of(archive)
    async with rig.db() as db:
        assert await db.get(PrintQueueItem, run_id) is not None, (
            "the old run's row is kept: it no longer owns the queue"
        )


async def test_an_error_after_the_command_holds_and_is_never_sent_again(make_rig, monkeypatch):
    from backend.app.services import swap_terminal

    rig = await make_rig(require_plate_clear=False)
    archive_id, _ = await an_owed_run_closed(rig)
    monkeypatch.setattr(swap_terminal, "finish_change_table", AsyncMock(side_effect=RuntimeError("db gone")))

    await recovery._resolve_pending_swaps(rig.printer_id, [archive_id])
    monkeypatch.undo()
    await recovery.reconcile_printer_prints(rig.printer_id, "FINISH", "job.gcode.3mf")

    assert rig.macro.await_count == 1
    archive = await archive_of(rig, archive_id)
    assert stage_of(archive) == "attempted"
    assert hold_of(archive) == "swap_hold_attempt_unknown"
    assert await queue_status(rig) == "paused"


async def test_a_live_completion_never_sends_over_an_existing_attempt(make_rig):
    rig = await make_rig(require_plate_clear=False)
    archive_id, _ = await an_execution(rig, fact=False, pending=[CHANGE_TABLE], in_memory=True)
    async with rig.db() as db:
        archive = await db.get(PrintArchive, archive_id)
        archive.extra_data = {
            **archive.extra_data,
            "bamdude_terminal_effects": {"swap_change_table": {"stage": "attempted", "at": "2026-10-14"}},
        }
        await db.commit()

    await complete(rig)

    assert rig.macro.await_count == 0
    assert hold_of(await archive_of(rig, archive_id)) == "swap_hold_attempt_unknown"
    assert await queue_status(rig) == "paused"


# --- the connect edge finds what an interrupted sweep left -----------------------------------------------------------


async def test_the_connect_edge_continues_an_owed_swap_exactly_once(make_rig, monkeypatch):
    rig = await make_rig(require_plate_clear=False)
    archive_id, _ = await an_owed_run_closed(rig)  # the process stopped before the sweep spawned its resolver
    tasks = spawned_tasks(monkeypatch)

    await recovery.reconcile_printer_prints(rig.printer_id, "FINISH", "job.gcode.3mf")
    await asyncio.wait_for(asyncio.gather(*tasks), 10)
    await recovery.reconcile_printer_prints(rig.printer_id, "FINISH", "job.gcode.3mf")
    await asyncio.wait_for(asyncio.gather(*tasks), 10)

    assert rig.macro.await_count == 1
    assert stage_of(await archive_of(rig, archive_id)) == "finished"
    assert await queue_status(rig) == "idle"


async def test_the_connect_edge_holds_a_completed_run_whose_swap_has_no_claim(make_rig):
    """A run closed by an older version (no claim recorded) may have had its swap sent: held, not sent."""
    rig = await make_rig(require_plate_clear=False)
    archive_id, _ = await an_owed_run_closed(rig)
    async with rig.db() as db:
        archive = await db.get(PrintArchive, archive_id)
        archive.extra_data = {
            key: value for key, value in archive.extra_data.items() if key != "bamdude_terminal_effects"
        }
        await db.commit()

    await recovery.reconcile_printer_prints(rig.printer_id, "FINISH", "job.gcode.3mf")

    assert rig.macro.await_count == 0
    archive = await archive_of(rig, archive_id)
    assert hold_of(archive) == "swap_hold_attempt_unknown"
    assert CHANGE_TABLE in pending_of(archive)
    assert await queue_status(rig) == "paused"


async def test_two_connect_edges_close_a_run_once(make_rig, monkeypatch):
    """The second edge's stale copy of the archive closes nothing: no second usage booking, no second energy."""
    from backend.app import main
    from backend.app.services import usage_tracker

    rig = await make_rig(require_plate_clear=False)
    await an_execution(rig, fact=False, bound=False)
    monkeypatch.setattr(recovery, "_grace_seconds", AsyncMock(return_value=0))
    monkeypatch.setattr(recovery, "_load_objects_for_a_print_already_running", AsyncMock())
    original_close = recovery._reconcile_complete_archive
    both_read = asyncio.Event()
    arrived = 0
    spawned_tasks(monkeypatch)

    async def close(*args, **kwargs):
        nonlocal arrived
        arrived += 1
        if arrived == 2:
            both_read.set()
        await asyncio.wait_for(both_read.wait(), 5)
        return await original_close(*args, **kwargs)

    monkeypatch.setattr(recovery, "_reconcile_complete_archive", close)
    await asyncio.wait_for(
        asyncio.gather(
            *[recovery.reconcile_printer_prints(rig.printer_id, "FINISH", "job.gcode.3mf") for _ in range(2)]
        ),
        30,
    )

    assert usage_tracker.on_print_complete.await_count == 1
    assert main._record_print_energy.call_count == 1


async def test_a_second_owner_stands_down_entirely(make_rig):
    """While the first owner is sending, the second writes nothing: no hold, no pause -- the first one settles."""
    rig = await make_rig(require_plate_clear=False)
    archive_id, _ = await an_owed_run_closed(rig)
    sending = asyncio.Event()
    release = asyncio.Event()

    async def send(*args, **kwargs):
        sending.set()
        await release.wait()
        return True, "ok"

    rig.macro.side_effect = send
    first = asyncio.create_task(recovery._resolve_pending_swaps(rig.printer_id, [archive_id]))
    await asyncio.wait_for(sending.wait(), 5)
    await recovery._resolve_pending_swaps(rig.printer_id, [archive_id])
    assert hold_of(await archive_of(rig, archive_id)) is None
    assert await queue_status(rig) == "printing"
    release.set()
    await asyncio.wait_for(first, 5)

    assert rig.macro.await_count == 1
    assert await queue_status(rig) == "idle"


@pytest.mark.parametrize(("answer", "after"), [("finished", "idle"), ("failed", "paused")])
async def test_the_connect_edge_settles_an_answered_swap_whose_bookkeeping_never_ran(answer, after, make_rig):
    """The process stopped after the macro's answer was written and before the queue was settled."""
    rig = await make_rig(require_plate_clear=False)
    archive_id, _ = await an_owed_run_closed(rig)
    async with rig.db() as db:
        archive = await db.get(PrintArchive, archive_id)
        archive.extra_data = {
            **{key: value for key, value in archive.extra_data.items() if key != "swap_macro_events_pending"},
            "bamdude_terminal_effects": {"swap_change_table": {"stage": answer, "owner": "sweep", "at": "2026-10-14"}},
        }
        await db.commit()

    await recovery.reconcile_printer_prints(rig.printer_id, "FINISH", "job.gcode.3mf")

    assert rig.macro.await_count == 0
    assert await queue_status(rig) == after


async def test_an_owner_that_claims_after_another_passed_its_check_is_left_alone(make_rig, monkeypatch):
    """The second sweep found nobody sending, then -- while it looked the macro up -- the first one claimed and
    began: the claim answers 'busy', and the second writes nothing."""
    rig = await make_rig(require_plate_clear=False)
    archive_id, _ = await an_owed_run_closed(rig)
    sending = asyncio.Event()
    release = asyncio.Event()
    lookups = 0

    async def lookup(db, event, printer):
        nonlocal lookups
        lookups += 1
        if lookups == 1:  # the second sweep, started first: past its check, before its claim
            await asyncio.wait_for(sending.wait(), 5)
        return SimpleNamespace(name="Change table", gcode="G28 ; change table")

    async def send(*args, **kwargs):
        sending.set()
        await release.wait()
        return True, "ok"

    monkeypatch.setattr("backend.app.services.macro_executor.find_swap_macro", lookup)
    rig.macro.side_effect = send
    second = asyncio.create_task(recovery._resolve_pending_swaps(rig.printer_id, [archive_id]))
    for _ in range(200):
        if lookups:
            break
        await asyncio.sleep(0.01)
    first = asyncio.create_task(recovery._resolve_pending_swaps(rig.printer_id, [archive_id]))
    await asyncio.wait_for(second, 10)
    assert hold_of(await archive_of(rig, archive_id)) is None
    assert await queue_status(rig) == "printing"
    release.set()
    await asyncio.wait_for(first, 10)

    assert rig.macro.await_count == 1
    assert await queue_status(rig) == "idle"


async def test_the_close_never_marks_owed_over_a_recorded_attempt(make_rig):
    rig = await make_rig(require_plate_clear=False)
    archive_id, _ = await an_execution(rig, fact=False, pending=[CHANGE_TABLE], bound=False)
    async with rig.db() as db:
        archive = await db.get(PrintArchive, archive_id)
        archive.extra_data = {
            **archive.extra_data,
            "bamdude_terminal_effects": {"swap_change_table": {"stage": "attempted", "at": "2026-10-14"}},
        }
        await db.commit()

    await close_only(rig, archive_id)
    await recovery._resolve_pending_swaps(rig.printer_id, [archive_id])

    assert rig.macro.await_count == 0
    archive = await archive_of(rig, archive_id)
    assert stage_of(archive) == "attempted"
    assert hold_of(archive) == "swap_hold_attempt_unknown"
