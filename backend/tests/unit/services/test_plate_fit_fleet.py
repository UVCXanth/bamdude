"""Exact-quantity browsing must use the SAME live-fleet greedy objective."""

from datetime import datetime, time
from fractions import Fraction
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest

from backend.app.schemas.plate_fit import PlateFitRequest
from backend.app.services import plan_engine, plate_fit as fit, stock_offers, stock_pick
from backend.app.services.forecast_operator_hours import OperatorHours
from backend.tests.unit.services.test_plan_engine import _cand, _ctx, _figs, _line, _part
from backend.tests.unit.services.test_plate_fit import snapshot, solve


def farm():
    s = snapshot(
        [fit.Part(1, "Part A", 1, Fraction(0), 0)],
        [
            fit.Plate(1, (10,), 10),
            fit.Plate(2, (10,), 20),
            fit.Plate(3, (10,), 15),
            fit.Plate(4, (10,), 15),
        ],
    )
    for (_, _, recipe), model in zip(s.candidates, ("A1 Mini", "P1S", "P2S", "H2D"), strict=True):
        recipe.printer_model = model
    s.capacity = plan_engine.FleetCapacity(
        [
            *(plan_engine.FleetMachine(i, "A1 Mini") for i in range(1, 7)),
            *(plan_engine.FleetMachine(i, "P1S") for i in range(7, 12)),
            plan_engine.FleetMachine(12, "P2S"),
            plan_engine.FleetMachine(13, "H2D"),
        ]
    )
    return s


async def test_heterogeneous_plates_keep_fleet_neighbours_instead_of_the_legacy_1043_mix():
    """Two synthetic parts, seven plate yields, 6/5/1/1 lanes, operator asleep."""
    specs = [
        ((9, 0), 16493, "A1 Mini"),
        ((0, 16), 43778, "A1 Mini"),
        ((42, 0), 59399, "H2D"),
        ((0, 49), 105517, "H2D"),
        ((0, 35), 75149, "P1S"),
        ((0, 36), 77289, "P2S"),
        ((25, 0), 34121, "P2S"),
    ]
    s = snapshot(
        [fit.Part(1, "Part A", 1, Fraction(0), 0), fit.Part(2, "Part B", 1, Fraction(0), 0)],
        [fit.Plate(i + 1, yields, seconds) for i, (yields, seconds, _model) in enumerate(specs)],
        quantity=1043,
    )
    for (_, _, recipe), (_yields, _seconds, model) in zip(s.candidates, specs, strict=True):
        recipe.printer_model = model
    s.capacity = farm().capacity
    for machine in s.capacity.machines:
        machine.prep_seconds = 120
        machine.gap_seconds = 600
    s.capacity.operator_hours = OperatorHours(
        datetime(2026, 10, 18, 20, 46, 28, 863042), time(23), time(8), ZoneInfo("Europe/Kyiv")
    )
    result = await fit.proposals(s, PlateFitRequest(around=1043, steps=1))
    assert result["current"] == "none"
    assert result["lower"] == result["upper"] == "found"
    assert [o.quantity for o in result["options"]] == [1036, 1072]
    for option in result["options"]:
        assert {s.candidates[r.plate_id - 1][2].printer_model for r in option.runs} == {"A1 Mini", "P1S", "P2S", "H2D"}
    assert all(m.free_at == 0 for m in s.capacity.machines)


def test_equal_yield_variants_keep_actual_fleet_runs_without_changing_normal_compaction():
    s = farm()
    compact_capacity = s.capacity.copy()
    raw_capacity = s.capacity.copy()
    compact, surplus, stopped = plan_engine.cover({1: 1000}, s.candidates, {1}, None, compact_capacity)
    rows, raw_surplus, raw_stopped = plan_engine.cover(
        {1: 1000},
        s.candidates,
        {1},
        None,
        raw_capacity,
        compact_equivalent=False,
    )
    assert not stopped and not raw_stopped and not surplus and not raw_surplus
    assert len(compact) == 1  # Existing order-page representation stays unchanged.
    assert {r.plate_id for r in rows} == {1, 2, 3, 4}
    assert sum(r.count for r in rows) == compact[0].count == 100
    assert compact_capacity == raw_capacity


@pytest.mark.parametrize("direction,lo,hi,wanted", [(1, 1001, 1100, 1010), (-1, 900, 999, 990)])
def test_both_nearest_directions_keep_all_four_models_and_leave_snapshot_unconsumed(direction, lo, hi, wanted):
    s = farm()
    before = s.capacity.copy()
    proposal, status = solve(s, lo, hi, direction)
    assert status == "found" and proposal.quantity == wanted
    assert {r.plate_id for r in proposal.runs} == {1, 2, 3, 4}
    canonical, surplus, stopped = plan_engine.cover(
        {1: wanted},
        s.candidates,
        {1},
        None,
        s.capacity.copy(),
        compact_equivalent=False,
    )
    assert not surplus and not stopped
    assert {r.plate_id: r.count for r in proposal.runs} == {r.plate_id: r.count for r in canonical}
    assert s.capacity == before
    assert fit.greedy_option(s, wanted)[0] == proposal
    assert s.capacity == before


async def test_expanded_browsing_uses_fresh_copies_of_the_same_fleet_for_every_option():
    s = farm()
    result = await fit.proposals(s, PlateFitRequest(around=1000, steps=3))
    assert [o.quantity for o in result["options"]] == [970, 980, 990, 1000, 1010, 1020, 1030]
    assert all({r.plate_id for r in o.runs} == {1, 2, 3, 4} for o in result["options"])
    assert all(m.free_at == 0 for m in s.capacity.machines)


@pytest.mark.parametrize(
    "around,stock,below,above",
    [(1000, 0, 840, 1012), (1100, 0, 1044, 1371), (1000, 8, 848, 1020), (1100, 8, 1052, 1379)],
)
async def test_dense_eight_plate_search_with_free_kits_finds_both_sides(monkeypatch, around, stock, below, above):
    specs = [
        ((9, 0), 16493, "A1 Mini"),
        ((0, 16), 43778, "A1 Mini"),
        ((42, 0), 59399, "H2D"),
        ((0, 49), 105517, "H2D"),
        ((0, 35), 75149, "P1S"),
        ((25, 0), 35895, "P1S"),
        ((0, 36), 77289, "P2S"),
        ((25, 0), 34121, "P2S"),
    ]
    s = snapshot(
        [fit.Part(1, "Part A", 1, Fraction(0), 0), fit.Part(2, "Part B", 1, Fraction(0), 0)],
        [fit.Plate(i + 1, yields, seconds) for i, (yields, seconds, _model) in enumerate(specs)],
        quantity=1043,
    )
    for (_, _, recipe), (_yields, _seconds, model) in zip(s.candidates, specs, strict=True):
        recipe.printer_model = model
    s.capacity = farm().capacity
    for machine in s.capacity.machines:
        machine.prep_seconds, machine.gap_seconds = 120, 600
    s.capacity.operator_hours = OperatorHours(
        datetime(2026, 10, 18, 21, 16, 3, 194952), time(23), time(8), ZoneInfo("Europe/Kyiv")
    )
    line = _line(1, 1, 1043)
    line.mode = "product"
    s.context = _ctx([line], [_part(1, 1, "Part A", 1), _part(2, 1, "Part B", 1)])
    s.recipes = {1: s.candidates}
    s.supply = stock_offers.Supply(
        {1: stock_pick.Suggestion(1, 0, stock, 0, 0, 1, None, None)}, {1: {1: stock, 2: stock}}
    )
    # Arithmetic assertions are independent of the CI machine's speed. The
    # short-budget fairness contract is tested with a deterministic clock.
    monkeypatch.setattr(fit, "MAX_SECONDS", 30)
    result = await fit.proposals(s, PlateFitRequest(around=around, steps=1))
    assert result["lower"] == result["upper"] == "found"
    assert [o.quantity for o in result["options"]] == [below, above]
    for option in result["options"]:
        assert option == fit.greedy_option(s, option.quantity)[0]
        assert option.from_kits == stock
        assert all(p.required == p.free_stock + p.new_printed for p in option.parts)
    assert s.supply.parts == {1: {1: stock, 2: stock}}
    assert all(m.free_at == 0 for m in s.capacity.machines)


def test_busy_model_is_not_treated_as_a_free_printer_and_legacy_mix_cannot_be_confirmed():
    s = farm()
    legacy, _, _ = plan_engine.cover({1: 1000}, s.candidates, {1}, None)
    with pytest.raises(fit.FitError, match="invalid_plan"):
        fit.confirm(
            s,
            1000,
            SimpleNamespace(
                basis=s.basis,
                acknowledge_large_change=False,
                runs=[SimpleNamespace(plate_id=r.plate_id, count=r.count) for r in legacy],
            ),
        )
    s.capacity.machines[-1].free_at = 1_000_000
    option, stopped = fit.greedy_option(s, 1000)
    assert not stopped and option is not None
    assert 4 not in {r.plate_id for r in option.runs}
    assert {1, 2, 3} <= {r.plate_id for r in option.runs}


def test_previous_order_lines_reserve_the_same_lanes_before_this_line(monkeypatch):
    first, second = _part(1, 10, "Part A", 1), _part(2, 20, "Part B", 1)
    left, right = _line(100, 10, 1), _line(200, 20, 1, sort=1)
    ctx = _ctx([left, right], [first, second])
    recipes = {
        10: [_cand(1, 10, {1: 1}, secs=8 * 3600, model="A1 Mini")],
        20: [_cand(2, 20, {2: 1}, secs=8 * 3600, model="A1 Mini"), _cand(3, 20, {2: 1}, secs=13 * 3600, model="P1S")],
    }
    figures = {100: _figs(left, [first], {1: 1}), 200: _figs(right, [second], {2: 1})}
    monkeypatch.setattr(fit.order_metrics, "attribute", lambda _ctx: (figures, {}))
    monkeypatch.setattr(stock_offers, "offers_for", lambda *_: [])
    s = fit.Snapshot(
        200,
        1,
        1,
        [fit.Part(2, "Part B", 1, Fraction(0), 0)],
        [fit.Plate(2, (1,), 8 * 3600), fit.Plate(3, (1,), 13 * 3600)],
        "a" * 64,
        recipes[20],
        context=ctx,
        supply=stock_offers.Supply({}, {}),
        recipes=recipes,
        capacity=plan_engine.FleetCapacity(
            [plan_engine.FleetMachine(1, "A1 Mini"), plan_engine.FleetMachine(2, "P1S")]
        ),
    )
    option, stopped = fit.greedy_option(s, 1)
    assert not stopped and [(r.plate_id, r.count) for r in option.runs] == [(3, 1)]
    assert all(m.free_at == 0 for m in s.capacity.machines)
