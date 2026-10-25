from datetime import datetime

import pytest
from pydantic import ValidationError

from backend.app.schemas.order_resources import PrinterResources
from backend.app.services.farm_forecast import (
    FarmSnapshot,
    MachineState,
    StagedJob,
    _initial_state,
    capacity_from_snapshot,
)
from backend.app.services.order_resources import permits


def test_existing_greedy_plan_never_uses_an_excluded_model_or_machine():
    from backend.app.services.plan_engine import FleetCapacity, FleetMachine, plan_lines
    from backend.tests.unit.services.test_plan_engine import _cand, _ctx, _figs, _line, _part

    part = _part(1, 1, "Part A", 1)
    line = _line(1, 1, 20)
    ctx = _ctx([line], [part])
    ctx.project.printer_resources = {"models": ["A1 Mini"], "printer_ids": [1]}
    capacity = FleetCapacity([FleetMachine(1, "A1 Mini"), FleetMachine(2, "A1 Mini"), FleetMachine(3, "P1S")])
    candidates = [_cand(1, 1, {1: 1}, model="A1 Mini", secs=100), _cand(2, 1, {1: 10}, model="P1S", secs=1)]
    plan = plan_lines(ctx, {1: _figs(line, [part], {1: 20})}, {1: candidates}, {}, None, capacity)
    assert [(p.plate_id, p.count) for p in plan.lines[0].rows] == [(1, 20)]
    assert [m.printer_id for m in capacity.machines] == [1]


def test_replan_without_a_permitted_lane_reports_missing_work_instead_of_expanding_policy():
    from backend.app.services.plan_engine import FleetCapacity, FleetMachine, plan_lines
    from backend.tests.unit.services.test_plan_engine import _cand, _ctx, _figs, _line, _part

    part = _part(1, 1, "Part A", 1)
    line = _line(1, 1, 20)
    ctx = _ctx([line], [part])
    ctx.project.printer_resources = {"models": ["A1 Mini"]}
    capacity = FleetCapacity([FleetMachine(3, "P1S")])
    plan = plan_lines(
        ctx, {1: _figs(line, [part], {1: 20})}, {1: [_cand(1, 1, {1: 1}, model="P1S")]}, {}, None, capacity
    )
    assert not plan.lines[0].rows
    assert plan.lines[0].unsatisfiable == [1]
    assert plan.lines[0].unsatisfiable_reasons == {1: "printer_resources"}


def test_models_and_ids_intersect_and_never_reserve_another_order():
    policy = {"models": ["A1 mini"], "printer_ids": [1, 2]}
    assert permits(policy, 1, "A1MINI")
    assert not permits(policy, 2, "P1S")
    assert not permits(policy, 3, "A1 Mini")
    assert permits(None, 3, "P1S")
    assert not permits({"printer_ids": []}, 1, "A1 Mini")


@pytest.mark.parametrize(
    "policy", [{"models": []}, {"printer_ids": []}, {"printer_ids": [True]}, {"printer_ids": [0]}, {"models": [""]}]
)
def test_invalid_empty_selection_is_not_an_unrestricted_policy(policy):
    with pytest.raises(ValidationError):
        PrinterResources(**policy)


def test_staged_forecast_uses_only_selected_printer_ids():
    snapshot = FarmSnapshot(
        printers=[MachineState(1, "P1S"), MachineState(2, "P1S")],
        staged=[StagedJob(10, "P1S", 100)],
        allow_compatible=True,
        order_resources={10: {"models": ["P1S"], "printer_ids": [2]}},
    )
    state = _initial_state(snapshot)
    assert not state.machines[0].timeline
    assert len(state.machines[1].timeline) == 1


def test_no_eligible_forecast_lane_does_not_fall_back_to_entire_farm():
    snapshot = FarmSnapshot(
        printers=[MachineState(1, "P1S")],
        staged=[StagedJob(10, "P1S", 100)],
        order_resources={10: {"models": ["A1 Mini"]}},
    )
    state = _initial_state(snapshot)
    assert state.unroutable[10] == 1
    assert not state.machines[0].timeline
    assert capacity_from_snapshot(snapshot).machines[0].free_at == 0


def test_forecast_machine_counts_are_order_local():
    from backend.app.services.farm_forecast import accepting_models

    snapshot = FarmSnapshot(
        printers=[MachineState(1, "A1 Mini"), MachineState(2, "A1 Mini"), MachineState(3, "P1S")],
        staged=[],
        order_resources={10: {"printer_ids": [2]}},
    )
    assert dict(accepting_models(snapshot, 10)) == {"a1 mini": 1}
    assert sum(accepting_models(snapshot, 11).values()) == 3
