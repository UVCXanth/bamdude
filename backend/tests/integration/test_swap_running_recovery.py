"""A restart must not discard an active dispatch's persisted swap obligation."""

from datetime import timedelta
from unittest.mock import AsyncMock

import pytest

from backend.app import main
from backend.app.models.archive import PrintArchive
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer_queue import PrinterQueue
from backend.app.services import swap_terminal
from backend.app.services.print_run_binding import bind_print_run, current_print_run, origin_is_proven
from backend.tests.integration.swap_terminal_support import (
    CHANGE_TABLE,
    an_execution,
    archive_of,
    change_tables_sent,
    complete,
    make_rig,  # noqa: F401 -- shared isolated database and hardware stubs
)

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]


async def observe_running(rig, monkeypatch, **extra):
    monkeypatch.setattr(main, "_restore_usage_tracking_session", AsyncMock())
    monkeypatch.setattr(main, "_seed_runout_detector_from_journal", AsyncMock())
    monkeypatch.setattr(main, "_capture_timelapse_baseline_at_start", AsyncMock())
    await main.on_print_running_observed(
        rig.printer_id, {"filename": "job.gcode.3mf", "subtask_name": "job", "subtask_id": "0", **extra}
    )


@pytest.mark.parametrize("origin", ["queue", "direct"])
async def test_recovered_dispatch_finishes_with_one_swap_without_device_id(make_rig, monkeypatch, origin):
    rig = await make_rig()
    archive_id, item_id = await an_execution(rig, fact=False, pending=[CHANGE_TABLE], bound=False)
    async with rig.db() as db:
        (await db.get(PrintQueueItem, item_id)).origin = origin
        await db.commit()

    await observe_running(rig, monkeypatch)

    binding = current_print_run(rig.manager, rig.printer_id)
    assert origin_is_proven(binding), "the surviving execution claim proves our dispatch after restart"
    assert (binding.archive_id, binding.queue_item_id) == (archive_id, item_id)
    assert binding.claim_started_at is not None
    await complete(rig, {"status": "completed", "subtask_name": "job", "subtask_id": "0"})
    await complete(rig, {"status": "completed", "subtask_name": "job", "subtask_id": "0"})
    assert change_tables_sent(rig) == 1
    assert swap_terminal.claim_stage((await archive_of(rig, archive_id)).extra_data) == swap_terminal.CLAIM_FINISHED


@pytest.mark.parametrize("damage", ["external", "other_header", "missing_start", "other_archive", "id_conflict"])
async def test_name_only_recovery_does_not_invent_dispatch_proof(make_rig, monkeypatch, damage):
    rig = await make_rig()
    archive_id, item_id = await an_execution(rig, fact=False, pending=[CHANGE_TABLE], bound=False)
    async with rig.db() as db:
        item = await db.get(PrintQueueItem, item_id)
        if damage == "external":
            item.origin = "external"
        elif damage == "other_header":
            (await db.get(PrinterQueue, rig.queue_id)).current_item_id = None
        elif damage == "missing_start":
            item.started_at = None
        elif damage == "other_archive":
            db.add(
                PrintArchive(
                    printer_id=rig.printer_id, filename="other.3mf", file_path="", file_size=0, status="printing"
                )
            )
        else:
            (await db.get(PrintArchive, archive_id)).subtask_id = "previous-run"
        await db.commit()

    await observe_running(rig, monkeypatch, **({"subtask_id": "new-run"} if damage == "id_conflict" else {}))

    assert not origin_is_proven(current_print_run(rig.manager, rig.printer_id))
    rig.macro.assert_not_awaited()


async def test_exact_device_recovery_keeps_its_existing_proof(make_rig, monkeypatch):
    rig = await make_rig()
    archive_id, _ = await an_execution(rig, fact=False, pending=[CHANGE_TABLE], bound=False)
    async with rig.db() as db:
        archive = await db.get(PrintArchive, archive_id)
        archive.subtask_id = "device-run"
        item = await db.get(PrintQueueItem, (await db.get(PrinterQueue, rig.queue_id)).current_item_id)
        item.origin = "external"
        await db.commit()
    await observe_running(rig, monkeypatch, subtask_id="device-run")
    assert current_print_run(rig.manager, rig.printer_id).origin == "exact_subtask"


async def test_recovery_never_resends_an_already_attempted_swap(make_rig, monkeypatch):
    rig = await make_rig()
    archive_id, _ = await an_execution(rig, fact=False, pending=[CHANGE_TABLE], bound=False)
    async with rig.db() as db:
        archive = await db.get(PrintArchive, archive_id)
        archive.extra_data = {
            **archive.extra_data,
            swap_terminal.EFFECTS_KEY: {swap_terminal.CHANGE_TABLE_EFFECT: {"stage": swap_terminal.CLAIM_ATTEMPTED}},
        }
        await db.commit()
    await observe_running(rig, monkeypatch)
    await complete(rig, {"status": "completed", "subtask_name": "job", "subtask_id": "0"})
    assert change_tables_sent(rig) == 0
    assert swap_terminal.claim_stage((await archive_of(rig, archive_id)).extra_data) == swap_terminal.CLAIM_ATTEMPTED


@pytest.mark.parametrize("changed", ["attempt", "header"])
async def test_recovered_claim_is_checked_again_when_finishing(make_rig, monkeypatch, changed):
    rig = await make_rig()
    archive_id, item_id = await an_execution(rig, fact=False, pending=[CHANGE_TABLE], bound=False)
    await observe_running(rig, monkeypatch)
    assert origin_is_proven(current_print_run(rig.manager, rig.printer_id))
    async with rig.db() as db:
        if changed == "attempt":
            item = await db.get(PrintQueueItem, item_id)
            item.started_at += timedelta(seconds=1)
        else:
            (await db.get(PrinterQueue, rig.queue_id)).current_item_id = None
        await db.commit()
    await complete(rig, {"status": "completed", "subtask_name": "job", "subtask_id": "0"})
    assert change_tables_sent(rig) == 0
    assert (await archive_of(rig, archive_id)).status == "printing"


async def test_a_newer_binding_wins_while_recovery_reads_its_claim(make_rig, monkeypatch):
    rig = await make_rig()
    await an_execution(rig, fact=False, pending=[CHANGE_TABLE], bound=False)
    real_read = main._running_dispatch_claim

    async def new_run_during_read(db, printer_id, archive_id):
        claim = await real_read(db, printer_id, archive_id)
        bind_print_run(rig.manager, printer_id=printer_id, archive_id=999, origin="dispatch")
        return claim

    monkeypatch.setattr(main, "_running_dispatch_claim", new_run_during_read)
    await observe_running(rig, monkeypatch)
    assert current_print_run(rig.manager, rig.printer_id).archive_id == 999
    rig.macro.assert_not_awaited()


async def test_device_identity_observed_on_recovery_rejects_a_foreign_finish(make_rig, monkeypatch):
    rig = await make_rig()
    await an_execution(rig, fact=False, pending=[CHANGE_TABLE], bound=False)
    await observe_running(rig, monkeypatch, subtask_id="live-run")
    await complete(rig, {"status": "completed", "subtask_id": "another-run"})
    rig.macro.assert_not_awaited()
    await complete(rig, {"status": "completed", "subtask_id": "live-run"})
    assert change_tables_sent(rig) == 1


async def test_recovered_finish_under_farm_hold_remains_owed_until_resume(make_rig, monkeypatch, tmp_path):
    from backend.app.services import farm_startup_guard as module
    from backend.app.services.print_reconciliation import _resolve_pending_swaps

    guard = module.FarmStartupGuard()
    guard.start(tmp_path / "farm-state")
    guard.mark_ready()
    monkeypatch.setattr(module, "farm_startup_guard", guard)
    monkeypatch.setattr(main, "farm_startup_guard", guard)
    rig = await make_rig()
    archive_id, _ = await an_execution(rig, fact=False, pending=[CHANGE_TABLE], bound=False)
    try:
        await observe_running(rig, monkeypatch)
        await complete(rig, {"status": "completed", "subtask_name": "job", "subtask_id": "0"})
        archive = await archive_of(rig, archive_id)
        assert swap_terminal.claim_stage(archive.extra_data) == swap_terminal.CLAIM_OWED
        rig.macro.assert_not_awaited()
        state = guard.status()
        guard.resume(state["boot_id"], state["hold_id"], actor="test")
        await _resolve_pending_swaps(rig.printer_id, [archive_id])
        await _resolve_pending_swaps(rig.printer_id, [archive_id])
        assert change_tables_sent(rig) == 1
    finally:
        guard.finish(clean=False)
