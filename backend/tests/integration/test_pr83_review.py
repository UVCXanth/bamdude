import time
from dataclasses import replace
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

from backend.app.api.routes.settings import set_setting
from backend.app.models.archive import PrintArchive
from backend.app.services import farm_forecast
from backend.tests.integration.test_farm_forecast_api import farm  # noqa: F401
from backend.tests.unit.services.test_farm_forecast import _plan

pytestmark = pytest.mark.integration


async def test_proven_automatic_completion_has_no_manual_service_allowance(db_session, farm, monkeypatch):
    printer = farm["printers"][0]
    archive = PrintArchive(
        printer_id=printer.id,
        filename="synthetic.gcode.3mf",
        file_path="",
        file_size=1,
        status="completed",
        extra_data={"dispatch_intent": {"auto_eject": True, "submission_id": "review-run"}},
    )
    db_session.add(archive)
    await db_session.flush()
    printer.require_plate_clear = True
    printer.swap_mode_enabled = False
    printer.awaiting_plate_clear = True
    printer.awaiting_plate_clear_archive_id = archive.id
    await set_setting(db_session, "forecast_plate_clear_minutes", "10")
    await set_setting(db_session, "forecast_operator_absence_enabled", "true")
    await set_setting(db_session, "forecast_operator_timezone", "UTC")
    await db_session.commit()
    monkeypatch.setattr(
        farm_forecast.printer_manager,
        "peek_status",
        lambda _pid: (
            SimpleNamespace(connected=True, state="FINISH", subtask_id="review-run"),
            time.monotonic(),
            False,
        ),
    )
    snapshot = await farm_forecast.load_snapshot(db_session, datetime(2026, 10, 15, 23))
    lane = next(m for m in snapshot.printers if m.printer_id == printer.id)
    assert not lane.awaiting_operator
    assert lane.waiting_seconds == 0, "Proven automatic completion still carries the manual plate-clear allowance"


@pytest.fixture
async def held_completion(db_session, farm, monkeypatch):
    printer = farm["printers"][0]
    archive = PrintArchive(
        printer_id=printer.id,
        filename="Product-A-synthetic.gcode.3mf",
        file_path="",
        file_size=1,
        status="completed",
        extra_data={"dispatch_intent": {"auto_eject": True, "submission_id": "review-run"}},
    )
    db_session.add(archive)
    await db_session.flush()
    printer.require_plate_clear = True
    printer.swap_mode_enabled = False
    printer.awaiting_plate_clear = True
    printer.awaiting_plate_clear_archive_id = archive.id
    await set_setting(db_session, "forecast_plate_clear_minutes", "10")
    await set_setting(db_session, "forecast_operator_absence_enabled", "true")
    await set_setting(db_session, "forecast_operator_timezone", "UTC")
    await db_session.commit()
    telemetry = SimpleNamespace(connected=True, state="FINISH", subtask_id="review-run")
    received = {"age": 0, "stale": False}
    monkeypatch.setattr(
        farm_forecast.printer_manager,
        "peek_status",
        lambda _pid: (telemetry, time.monotonic() - received["age"], received["stale"]),
    )
    return printer, archive, telemetry, received


@pytest.mark.parametrize("operator_enabled", [True, False])
@pytest.mark.parametrize("drying", [0, 120, 1200])
async def test_automatic_completion_keeps_independent_drying_and_future_manual_service(
    db_session, held_completion, monkeypatch, operator_enabled, drying
):
    from backend.app.services.print_scheduler import scheduler

    printer, archive, _, _ = held_completion
    await set_setting(db_session, "forecast_operator_absence_enabled", str(operator_enabled).lower())
    await set_setting(db_session, "queue_drying_enabled", "true")
    await set_setting(db_session, "queue_drying_block", "true")
    await db_session.commit()
    monkeypatch.setattr(scheduler, "drying_remaining_seconds", lambda pid: drying if pid == printer.id else 0)
    now = datetime(2026, 10, 15, 13)
    snapshot = await farm_forecast.load_snapshot(db_session, now)
    lane = next(m for m in snapshot.printers if m.printer_id == printer.id)
    assert lane.waiting_seconds == drying
    assert not lane.awaiting_operator
    assert lane.plate_clear_seconds == 600
    # The very next ordinary print still needs service before a later automatic one.
    future = replace(
        lane,
        queued=[farm_forecast.QueuedRow(7, 60), farm_forecast.QueuedRow(7, 60, auto_eject=True)],
    )
    result = farm_forecast.simulate_farm(replace(snapshot, printers=[future], staged=[]))
    assert result.free_seconds == drying + 60 + 600 + 60
    await db_session.refresh(printer)
    await db_session.refresh(archive)
    assert printer.awaiting_plate_clear is True
    assert printer.awaiting_plate_clear_archive_id == archive.id
    assert archive.status == "completed"


@pytest.mark.parametrize(
    "case",
    ["failed", "cancelled", "ordinary", "uncertain", "mismatch", "stale", "aged", "offline", "running", "missing"],
)
async def test_unproven_predecessor_keeps_manual_service(db_session, held_completion, case):
    printer, archive, telemetry, received = held_completion
    if case in ("failed", "cancelled"):
        archive.status = case
    elif case == "ordinary":
        archive.extra_data = {"dispatch_intent": {"auto_eject": False, "submission_id": "review-run"}}
    elif case == "uncertain":
        archive.extra_data = {**archive.extra_data, "recovered_outcome_uncertain": True}
    elif case == "mismatch":
        telemetry.subtask_id = "another-run"
    elif case == "stale":
        received["stale"] = True
    elif case == "aged":
        received["age"] = 60
    elif case == "offline":
        telemetry.connected = False
    elif case == "running":
        telemetry.state = "RUNNING"
    elif case == "missing":
        printer.awaiting_plate_clear_archive_id = None
    await db_session.commit()
    snapshot = await farm_forecast.load_snapshot(db_session, datetime(2026, 10, 15, 23))
    lane = next(m for m in snapshot.printers if m.printer_id == printer.id)
    assert lane.awaiting_operator
    assert lane.waiting_seconds == lane.plate_clear_seconds == 600
    assert printer.awaiting_plate_clear is True


@pytest.mark.parametrize("drying", [0, 120])
async def test_next_job_eta_is_continuous_across_automatic_completion(db_session, held_completion, monkeypatch, drying):
    from backend.app.services.print_scheduler import scheduler

    printer, archive, _, _ = held_completion
    now = datetime(2026, 10, 15, 23)
    archive.status = "printing"
    archive.started_at = now - timedelta(seconds=60)
    archive.print_time_seconds = 60
    printer.awaiting_plate_clear = False
    await set_setting(db_session, "queue_drying_enabled", "true")
    await set_setting(db_session, "queue_drying_block", "true")
    await db_session.commit()
    monkeypatch.setattr(scheduler, "drying_remaining_seconds", lambda pid: drying if pid == printer.id else 0)
    plan = _plan(7, [(1, 1, 60, "P1S", [])])
    plan.auto_eject = True

    async def next_eta():
        snap = await farm_forecast.load_snapshot(db_session, now)
        snap = replace(snap, printers=[m for m in snap.printers if m.printer_id == printer.id], staged=[])
        return farm_forecast.forecast_orders(snap, {7: plan}, [7], {7}, now)[7].now_seconds

    before = await next_eta()
    archive.status = "completed"
    printer.awaiting_plate_clear = True
    await db_session.commit()
    after = await next_eta()
    assert before == after == drying + 60
