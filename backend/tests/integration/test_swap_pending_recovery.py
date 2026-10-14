"""Our change-table macro, still owed when a print ends (swap-source-lifecycle spec r4 §10 D3, R2-5, R2-6; plan T7).

Both executors -- the live completion and the connect-edge sweep -- run it only for a run they can prove, that
completed, on a printer still in swap mode, over a source KNOWN not to carry its own sequence (False). The
archive's own record answers; only a record-less archive from before the fix may ask the exact job that ran it,
through that job's own snapshot (§6). Anything else -- True, unknown, a conflict, an uncertain outcome, a run
that cannot be proven -- runs nothing, leaves the event owed, clears no plate and holds this printer's queue with
a reason the operator can read even when no job is waiting, saying whether our swap cycle started. The sweep
keeps the job that ran until that decision is made; success cleans it up, a hold keeps it.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from backend.app.i18n import set_language_cache
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer_queue import PrinterQueue
from backend.tests.integration.swap_terminal_support import (
    CHANGE_TABLE,
    LEGACY,
    a_library_file,
    a_pending_job,
    an_execution,
    another_printer,
    archive_of,
    change_tables_sent,
    close_only,
    complete,
    gate_armed,
    give_job_a_snapshot,
    item_of,
    make_rig,  # noqa: F401 -- the fixture
    queue_status,
    recover,
)

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]

OWED = [CHANGE_TABLE]


@pytest.fixture(autouse=True)
def english():
    set_language_cache("en")
    yield
    set_language_cache("en")


async def finish(rig, executor: str, archive_id: int) -> None:
    if executor == "live":
        await complete(rig)
    else:
        await recover(rig, archive_id)


async def an_owed_run(rig, executor: str, **kwargs):
    """A run that owes our change_table: live -> bound and registered by dispatch; recovery -> only the archive."""
    if executor == "live":
        return await an_execution(rig, pending=OWED, in_memory=True, **kwargs)
    return await an_execution(rig, pending=OWED, bound=False, **kwargs)


def pending_of(archive) -> list:
    return list((archive.extra_data or {}).get("swap_macro_events_pending") or [])


@pytest.mark.parametrize("executor", ["live", "recovery"])
@pytest.mark.parametrize("fact", [True, None, False])
async def test_recovered_pending_requires_known_false_and_exact_run(executor, fact, make_rig):
    rig = await make_rig(require_plate_clear=False)
    archive_id, item_id = await an_owed_run(rig, executor, fact=fact)

    await finish(rig, executor, archive_id)

    archive = await archive_of(rig, archive_id)
    if fact is False:
        assert change_tables_sent(rig) == 1
        assert CHANGE_TABLE not in pending_of(archive)
        assert await queue_status(rig) == "idle"
    else:
        assert change_tables_sent(rig) == 0, "a True or unknown source never gets our table swap"
        assert CHANGE_TABLE in pending_of(archive), "a blocked event is not ticked off as done"
        assert await queue_status(rig) == "paused"
        assert await item_of(rig, item_id) is not None, "the job that ran stays as the hold's record"


@pytest.mark.parametrize("executor", ["live", "recovery"])
@pytest.mark.parametrize(
    ("case", "runs"),
    [
        ("snapshot_false", True),
        ("old_snapshot_library_false", True),
        ("old_snapshot_library_hash_differs", False),
        ("old_snapshot_library_true", False),
        ("no_snapshot", False),
    ],
)
async def test_legacy_pending_uses_only_execution_linked_snapshot(executor, case, runs, make_rig):
    rig = await make_rig(require_plate_clear=False)
    archive_id, item_id = await an_owed_run(rig, executor, fact=LEGACY)
    if case == "snapshot_false":
        await give_job_a_snapshot(rig, item_id, fact=False)
    elif case.startswith("old_snapshot"):
        file_hash = "cd" * 32 if case.endswith("hash_differs") else "ab" * 32
        library_id = await a_library_file(rig, declared=case == "old_snapshot_library_true", file_hash=file_hash)
        await give_job_a_snapshot(rig, item_id, fact="missing", library_file_id=library_id)

    await finish(rig, executor, archive_id)

    assert change_tables_sent(rig) == (1 if runs else 0)


async def test_a_reprint_queued_from_the_archive_is_no_proof(make_rig):
    """The sweep's run proof is the job that RAN the archive -- never a job queued from it later (a reprint),
    and never one on another printer."""
    rig = await make_rig(require_plate_clear=False)
    archive_id, item_id = await an_owed_run(rig, "recovery", fact=LEGACY)
    async with rig.db() as db:
        await db.delete(await db.get(PrintQueueItem, item_id))
        reprint = PrintQueueItem(queue_id=rig.queue_id, archive_id=archive_id, status="pending", position=3)
        neighbour_id = await another_printer(rig)
        foreign = PrintQueueItem(
            queue_id=neighbour_id, archive_id=archive_id, status="completed", position=0, started_at=None
        )
        db.add_all([reprint, foreign])
        await db.commit()
        reprint_id = reprint.id
    await give_job_a_snapshot(rig, reprint_id, fact=False)

    await recover(rig, archive_id)

    assert change_tables_sent(rig) == 0
    assert await queue_status(rig) == "paused"


@pytest.mark.parametrize("require_plate_clear", [False, True])
async def test_blocked_pending_keeps_local_hold_after_idle_update(require_plate_clear, make_rig):
    rig = await make_rig(require_plate_clear=require_plate_clear)
    neighbour_id = await another_printer(rig)
    archive_id, item_id = await an_owed_run(rig, "live", fact=None)
    waiting_id = await a_pending_job(rig)

    await complete(rig)

    # The completion's own later release (set_queue_idle) cannot reopen the queue: the persisted result is a hold.
    assert await queue_status(rig) == "paused"
    assert (await item_of(rig, waiting_id)).waiting_reason
    assert CHANGE_TABLE in pending_of(await archive_of(rig, archive_id))
    assert gate_armed(rig) is require_plate_clear
    async with rig.db() as db:
        assert await db.scalar(select(PrinterQueue.status).where(PrinterQueue.id == neighbour_id)) == "idle"


async def test_manual_resolution_does_not_replay_blocked_change_table(make_rig):
    from backend.app.services.plate_hold import answer_by_clearing

    rig = await make_rig()
    archive_id, _item = await an_owed_run(rig, "live", fact=None)
    await complete(rig)
    assert change_tables_sent(rig) == 0

    # The operator inspects the plate and answers through the existing door; a replayed terminal follows.
    async with rig.db() as db:
        await answer_by_clearing(db, rig.printer_id)
    await complete(rig)

    assert change_tables_sent(rig) == 0, "confirming the plate never fires the macro that was held back"


async def test_reconcile_keeps_execution_item_until_pending_decision_without_plate_gate(make_rig):
    rig = await make_rig(require_plate_clear=False)
    archive_id, item_id = await an_owed_run(rig, "recovery", fact=False)

    await close_only(rig, archive_id)

    assert await item_of(rig, item_id) is not None, "the sweep's close must not clean up the proof of the run"


@pytest.mark.parametrize("executor", ["live", "recovery"])
async def test_pending_success_cleans_row_but_policy_hold_keeps_it(executor, make_rig):
    rig = await make_rig(require_plate_clear=False)
    done_archive, done_item = await an_owed_run(rig, executor, fact=False, name="done")
    await finish(rig, executor, done_archive)
    assert change_tables_sent(rig) == 1
    assert await item_of(rig, done_item) is None, "a successful swap cleans the row up as before"

    rig.macro.reset_mock()
    held_archive, held_item = await an_owed_run(rig, executor, fact=None, name="held")
    await finish(rig, executor, held_archive)
    assert change_tables_sent(rig) == 0
    assert await item_of(rig, held_item) is not None


@pytest.mark.parametrize("change", ["deleted", "rebound"])
async def test_deleted_or_rebound_execution_item_cannot_authorize_pending(change, make_rig, monkeypatch):
    """Between the sweep's close and its decision another session takes the job away: no proof is left."""
    from backend.app.services import print_reconciliation

    rig = await make_rig(require_plate_clear=False)
    archive_id, item_id = await an_owed_run(rig, "recovery", fact=False)
    await close_only(rig, archive_id)
    async with rig.db() as db:
        item = await db.get(PrintQueueItem, item_id)
        if change == "deleted":
            await db.delete(item)
        else:
            item.archive_id = None
        await db.commit()

    await print_reconciliation._resolve_pending_swaps(rig.printer_id, [archive_id])

    assert change_tables_sent(rig) == 0
    assert await queue_status(rig) == "paused"


CYCLE_TEXT = {
    (
        "en",
        "fired",
    ): "The table-swap cycle started but did not finish. Inspect the mechanism and plate before resuming.",
    ("en", "possibly_fired"): (
        "The table-swap cycle may have started, but completion is unconfirmed. "
        "Inspect the mechanism and plate before resuming."
    ),
    ("uk", "fired"): "Зміну столу розпочато, але не завершено. Огляньте установку й стіл перед продовженням.",
    ("uk", "possibly_fired"): (
        "Зміна столу могла розпочатися, але її завершення не підтверджено. "
        "Огляньте установку й стіл перед продовженням."
    ),
}


@pytest.mark.parametrize("lang", ["en", "uk"])
@pytest.mark.parametrize("start", ["fired", "possibly_fired", "no_outcome", "not_called"])
async def test_partial_swap_hold_explains_started_and_uncertain_cycle(lang, start, make_rig):
    set_language_cache(lang)
    rig = await make_rig(require_plate_clear=False)
    if start == "no_outcome":
        # A run from before the start was recorded: nothing says whether it began.
        archive_id, item_id = await an_owed_run(rig, "live", fact=LEGACY)
    else:
        archive_id, item_id = await an_owed_run(
            rig, "live", fact=None, start_effect=None if start == "not_called" else start
        )

    await complete(rig)  # no job is waiting

    reason = (await item_of(rig, item_id)).waiting_reason
    expected = CYCLE_TEXT.get((lang, "possibly_fired" if start == "no_outcome" else start))
    if expected is not None:
        assert reason == expected
    else:
        # Not started: the ordinary refusal, which claims nothing about a cycle.
        assert reason
        assert "started" not in reason and "розпоч" not in reason
    hold = (await archive_of(rig, archive_id)).extra_data["swap_hold"]
    assert (
        hold["cycle"]
        == {
            "fired": "started",
            "possibly_fired": "possibly_started",
            "no_outcome": "possibly_started",
            "not_called": "not_started",
        }[start]
    )


async def test_successful_pending_clear_keeps_existing_once_only_semantics(make_rig):
    rig = await make_rig(require_plate_clear=False)
    archive_id, _item = await an_owed_run(rig, "live", fact=False)

    await complete(rig)
    await complete(rig)  # replayed

    assert change_tables_sent(rig) == 1
    assert CHANGE_TABLE not in pending_of(await archive_of(rig, archive_id))


async def test_reconnect_completed_true_arms_plate_and_holds_row(make_rig):
    """A print found finished on a restart or a fresh MQTT reconnect -- both edges end in the same sweep -- never
    clears the plate on a True declaration: the gate arms and the row waits for the answer."""
    rig = await make_rig(require_plate_clear=True)
    archive_id, item_id = await an_execution(rig, fact=True, bound=False)

    await recover(rig, archive_id)

    assert gate_armed(rig) is True
    assert await item_of(rig, item_id) is not None


@pytest.mark.parametrize("executor", ["live", "recovery"])
async def test_a_missing_macro_holds_and_keeps_the_event(executor, make_rig, monkeypatch):
    """Swap mode is on and the source says False, but there is no change-table macro to send: nothing went out,
    so the event stays owed and the queue holds -- it is not ticked off as done."""
    from unittest.mock import AsyncMock

    rig = await make_rig(require_plate_clear=False)
    monkeypatch.setattr("backend.app.services.macro_executor.find_swap_macro", AsyncMock(return_value=None))
    archive_id, item_id = await an_owed_run(rig, executor, fact=False)

    await finish(rig, executor, archive_id)

    assert change_tables_sent(rig) == 0
    assert CHANGE_TABLE in pending_of(await archive_of(rig, archive_id))
    assert await queue_status(rig) == "paused"
    assert (await archive_of(rig, archive_id)).extra_data["swap_hold"]["reason"] == "swap_hold_swap_off"


async def test_the_run_is_re_checked_right_before_the_command(make_rig, monkeypatch):
    """The job that ran is taken away while the sweep is deciding (another session, during its awaits): the
    command does not go out on the proof it read before."""
    from types import SimpleNamespace

    rig = await make_rig(require_plate_clear=False)
    archive_id, item_id = await an_owed_run(rig, "recovery", fact=False)
    await close_only(rig, archive_id)

    async def macro_while_the_row_goes(db, event, printer):
        async with rig.db() as other:
            await other.delete(await other.get(PrintQueueItem, item_id))
            await other.commit()
        return SimpleNamespace(name="Change table", gcode="G28 ; change table")

    monkeypatch.setattr("backend.app.services.macro_executor.find_swap_macro", macro_while_the_row_goes)
    from backend.app.services import print_reconciliation

    await print_reconciliation._resolve_pending_swaps(rig.printer_id, [archive_id])

    assert change_tables_sent(rig) == 0
    assert await queue_status(rig) == "paused"
