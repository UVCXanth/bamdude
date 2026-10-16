"""Synthetic daily absence: UTC arithmetic, local boundaries, no device access."""

from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from backend.app.schemas.settings import AppSettingsUpdate
from backend.app.services.farm_forecast import FarmSnapshot, MachineState, QueuedRow, forecast_orders, simulate_farm
from backend.app.services.forecast_operator_hours import OperatorHours
from backend.app.services.plan_engine import FleetCapacity, FleetMachine
from backend.tests.unit.services.test_farm_forecast import _plan
from backend.tests.unit.services.test_plan_engine import _cand

H = 3600


def hours(origin, start="23:00", end="08:00", zone="UTC"):
    return OperatorHours(origin, time.fromisoformat(start), time.fromisoformat(end), ZoneInfo(zone))


@pytest.mark.parametrize(
    "offset,duration,expected",
    [(0, 600, 600), (H, 600, 10 * H + 600), (H - 300, 600, 10 * H + 300), (10 * H, 600, 10 * H + 600)],
)
def test_midnight_boundaries_and_work_crossing_into_absence(offset, duration, expected):
    assert hours(datetime(2026, 10, 15, 22)).service_finish(offset, duration) == expected


def test_daytime_absence_and_zero_duration_manual_confirmation():
    policy = hours(datetime(2026, 10, 15, 9), start="08:00", end="17:00")
    assert policy.service_finish(0, 0) == 8 * H
    assert policy.service_finish(9 * H, 60) == 9 * H + 60


@pytest.mark.parametrize("origin,expected", [(datetime(2026, 3, 28, 22), 7 * H), (datetime(2026, 10, 24, 21), 9 * H)])
def test_kyiv_dst_changes_elapsed_night_hours(origin, expected):
    assert hours(origin, zone="Europe/Kyiv").service_finish(0, 0) == expected


def test_missing_and_repeated_end_times_normalize_forward():
    spring = hours(datetime(2026, 3, 29, 0), end="03:30", zone="Europe/Kyiv")
    autumn = hours(datetime(2026, 10, 25, 0), end="03:30", zone="Europe/Kyiv")
    assert spring.service_finish(0, 0) == 90 * 60
    assert autumn.service_finish(0, 0) == 90 * 60


def test_multiday_service_and_aware_origin():
    origin = datetime(2026, 10, 15, 22, tzinfo=timezone(timedelta(hours=3)))
    policy = hours(origin, start="23:00", end="08:00", zone="Europe/Kyiv")
    assert policy.service_finish(0, 16 * H) == 25 * H


@pytest.mark.parametrize(
    "field,value",
    [
        ("forecast_operator_absence_start", "25:00"),
        ("forecast_operator_absence_end", "9:61"),
        ("forecast_operator_timezone", "No/SuchZone"),
    ],
)
def test_bad_settings_are_refused(field, value):
    with pytest.raises(ValueError):
        AppSettingsUpdate(**{field: value})


def test_equal_window_is_not_silently_interpreted_as_always_present():
    with pytest.raises(ValueError):
        hours(datetime(2026, 10, 15), start="08:00", end="08:00")


def test_print_continues_at_night_but_manual_next_run_waits():
    origin = datetime(2026, 10, 15, 22)
    snap = FarmSnapshot(
        [
            MachineState(
                1,
                "P1S",
                queued=[QueuedRow(1, 2 * H, started=True), QueuedRow(1, H)],
                plate_clear_seconds=600,
                requires_operator=True,
            )
        ],
        [],
        operator_hours=hours(origin),
    )
    state = simulate_farm(snap)
    # First print completes at midnight; manual service at08:00, next print at08:10.
    assert state.free_seconds == 11 * H + 1200
    automatic = FarmSnapshot(
        [
            MachineState(
                1,
                "P1S",
                queued=[QueuedRow(1, 2 * H, started=True, auto_eject=True), QueuedRow(1, H, auto_eject=True)],
                plate_clear_seconds=600,
                requires_operator=True,
            )
        ],
        [],
        operator_hours=hours(origin),
    )
    assert simulate_farm(automatic).free_seconds == 3 * H


def test_auto_eject_service_is_consistent_with_operator_window_disabled():
    snapshot = FarmSnapshot(
        [
            MachineState(
                1,
                "P1S",
                queued=[QueuedRow(1, 2 * H, started=True, auto_eject=True), QueuedRow(1, H, auto_eject=True)],
                plate_clear_seconds=600,
            )
        ],
        [],
    )
    assert simulate_farm(snapshot).free_seconds == 3 * H


def test_new_auto_eject_job_cannot_erase_previous_manual_wait():
    origin = datetime(2026, 10, 15, 22)
    snap = FarmSnapshot(
        [
            MachineState(
                1, "P1S", queued=[QueuedRow(1, 2 * H, started=True)], plate_clear_seconds=600, requires_operator=True
            )
        ],
        [],
        operator_hours=hours(origin),
    )
    plan = _plan(7, [(1, 1, H, "P1S", [])])
    plan.auto_eject = True
    result = forecast_orders(snap, {7: plan}, [7], {7}, origin)[7]
    assert result.now_seconds == 11 * H + 600


def test_initial_empty_plate_and_printer_without_manual_gate_do_not_wait():
    origin = datetime(2026, 10, 15, 23)
    snap = FarmSnapshot([MachineState(1, "P1S")], [], operator_hours=hours(origin))
    assert forecast_orders(snap, {7: _plan(7, [(1, 1, H, "P1S", [])])}, [7], {7}, origin)[7].now_seconds == H


def test_planner_capacity_uses_the_same_operator_window_and_preserves_it_in_copy():
    origin = datetime(2026, 10, 15, 22)
    recipe = _cand(1, 1, {1: 1}, secs=2 * H, model="P1S")[2]
    capacity = FleetCapacity([FleetMachine(1, "P1S", gap_seconds=600)], operator_hours=hours(origin))
    capacity.reserve(recipe)
    assert capacity.copy().preview(recipe)[0] == 12 * H + 600
    capacity.auto_eject = True
    capacity.machines[0].free_at = 0
    capacity.reserve(recipe)
    assert capacity.preview(recipe)[0] == 4 * H
