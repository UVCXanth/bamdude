"""A restart/reconnect must not revoke a dispatched job's owed table swap."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from backend.app import main
from backend.app.models.archive import PrintArchive
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer_queue import PrinterQueue
from backend.tests.integration.swap_terminal_support import (
    CHANGE_TABLE,
    an_execution,
    archive_of,
    change_tables_sent,
    complete,
    make_rig,  # noqa: F401
    queue_status,
    recover,
)

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]


@pytest.mark.parametrize("binding", ["observed", "absent"])
async def test_persisted_owed_swap_survives_lost_dispatch_binding(binding, make_rig):
    rig = await make_rig(require_plate_clear=False)
    archive_id, _ = await an_execution(
        rig, fact=False, pending=[CHANGE_TABLE], origin="observed", bound=binding != "absent"
    )
    payload = {"status": "completed", "subtask_name": "job", "filename": "job.gcode.3mf"}

    await complete(rig, payload)
    await complete(rig, payload)

    assert change_tables_sent(rig) == 1
    archive = await archive_of(rig, archive_id)
    assert archive.status == "completed"
    assert CHANGE_TABLE not in archive.extra_data.get("swap_macro_events_pending", [])
    assert "swap_hold" not in archive.extra_data
    assert await queue_status(rig) == "idle"


async def test_completed_during_disconnect_runs_owed_swap_once(make_rig):
    rig = await make_rig(require_plate_clear=False)
    archive_id, _ = await an_execution(rig, fact=False, pending=[CHANGE_TABLE], bound=False)
    await recover(rig, archive_id)
    await recover(rig, archive_id)
    assert change_tables_sent(rig) == 1
    assert await queue_status(rig) == "idle"


async def test_actual_running_recovery_then_finish_keeps_owed_swap(make_rig, monkeypatch):
    rig = await make_rig(require_plate_clear=False)
    archive_id, _ = await an_execution(rig, fact=False, pending=[CHANGE_TABLE], bound=False)
    monkeypatch.setattr(main, "_seed_runout_detector_from_journal", AsyncMock())
    monkeypatch.setattr(main, "_timelapse_baselines", {rig.printer_id: set()})
    payload = {"filename": "job.gcode.3mf", "subtask_name": "job", "status": "completed"}
    await main.on_print_running_observed(rig.printer_id, payload)
    await complete(rig, payload)
    assert change_tables_sent(rig) == 1
    assert await queue_status(rig) == "idle"
    assert (await archive_of(rig, archive_id)).status == "completed"


@pytest.mark.parametrize("change", ["deleted", "rebound", "new_attempt", "new_claim"])
async def test_live_swap_rechecks_execution_after_macro_lookup(change, make_rig, monkeypatch):
    rig = await make_rig(require_plate_clear=False)
    archive_id, item_id = await an_execution(rig, fact=False, pending=[CHANGE_TABLE], origin="observed")

    async def lookup(db, event, printer):
        from datetime import timedelta

        async with rig.db() as other:
            item = await other.get(PrintQueueItem, item_id)
            if change == "deleted":
                await other.delete(item)
            elif change == "rebound":
                item.archive_id = None
            elif change == "new_attempt":
                item.started_at += timedelta(seconds=1)
            else:
                queue = await other.get(PrinterQueue, rig.queue_id)
                replacement = PrintQueueItem(queue_id=rig.queue_id, status="printing", position=1)
                other.add(replacement)
                await other.flush()
                queue.current_item_id = replacement.id
            await other.commit()
        return SimpleNamespace(name="Change table", gcode="G28")

    monkeypatch.setattr("backend.app.services.macro_executor.find_swap_macro", lookup)
    await complete(rig)
    assert change_tables_sent(rig) == 0
    assert CHANGE_TABLE in (await archive_of(rig, archive_id)).extra_data["swap_macro_events_pending"]


async def test_old_completed_hold_is_not_replayed_on_reconnect(make_rig):
    from backend.app.services.print_reconciliation import _resolve_pending_swaps

    rig = await make_rig(require_plate_clear=False)
    archive_id, item_id = await an_execution(rig, fact=False, pending=[CHANGE_TABLE], bound=False)
    async with rig.db() as db:
        archive = await db.get(PrintArchive, archive_id)
        archive.status = "completed"
        archive.extra_data = {**archive.extra_data, "swap_hold": {"reason": "swap_hold_run_unproven"}}
        (await db.get(PrintQueueItem, item_id)).status = "completed"
        (await db.get(PrinterQueue, rig.queue_id)).status = "paused"
        await db.commit()
    await _resolve_pending_swaps(rig.printer_id, [archive_id])
    assert change_tables_sent(rig) == 0
    assert await queue_status(rig) == "paused"
