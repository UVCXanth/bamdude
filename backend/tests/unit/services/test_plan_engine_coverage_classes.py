"""Coverage classes: a plate is chosen by covering ALL of its class's remaining demand.

Vault 60-specs/plan-recipe-choice-lookahead-spec (r3). Inside a class — the
plates that make the same still-needed parts — the representative is the one
whose plates alone finish that work soonest on the farm ledger; between
classes the established next-print key decides, unchanged. Every fast
makespan must equal what repeated ``FleetCapacity.reserve`` gives.
"""

import random
from datetime import datetime, time, timezone
from zoneinfo import ZoneInfo

import pytest

from backend.app.models.library import LibraryFile
from backend.app.models.product import ProductPlate
from backend.app.services import plan_engine
from backend.app.services.forecast_operator_hours import OperatorHours
from backend.app.services.plan_engine import FleetCapacity, FleetMachine
from backend.app.services.product_composition import PlateRecipe

M = 60


def _cand(plate_id, yields, *, secs, model="A1"):
    plate = ProductPlate(product_id=10, library_file_id=plate_id, plate_index=1)
    plate.id = plate_id
    file = LibraryFile(filename=f"p{plate_id}.3mf", file_path="", file_type="3mf", file_size=0)
    file.id = plate_id
    recipe = PlateRecipe(
        library_file_id=plate_id,
        plate_index=1,
        sliced=True,
        yield_by_part=dict(yields),
        materials={"PETG"},
        print_time_seconds=secs,
        filament_used_grams=10.0,
        printer_model=model,
    )
    return plate, file, recipe


def _lanes(*specs, prep=120, gap=300, compatible=False, auto_eject=False, operator_hours=None):
    """specs: (model, count[, free_at])"""
    machines = []
    for spec in specs:
        model, count, *rest = spec
        for _ in range(count):
            machines.append(FleetMachine(len(machines) + 1, model, rest[0] if rest else 0.0, prep, gap, True))
    return FleetCapacity(machines, allow_compatible=compatible, auto_eject=auto_eject, operator_hours=operator_hours)


def _picked(rows):
    return {row.plate_id: row.count for row in rows}


def _oracle(capacity, recipe, k):
    """The makespan k real reserves give, on a copy — the reference every fast path must equal."""
    sim = capacity.copy()
    return max(sim.reserve(recipe) for _ in range(k))


def _night(origin_hour=20):
    return OperatorHours(
        datetime(2026, 10, 21, origin_hour, 0, tzinfo=timezone.utc), time(22, 0), time(8, 0), ZoneInfo("UTC")
    )


HOLDERS = [_cand(1, {1: 5}, secs=60 * M), _cand(2, {1: 10}, secs=115 * M)]
PROTECT = [
    _cand(3, {2: 1}, secs=42 * M),
    _cand(4, {2: 2}, secs=80 * M),
    _cand(5, {2: 3}, secs=115 * M),
    _cand(6, {2: 4}, secs=150 * M),
]


def test_one_printer_takes_the_bigger_holder_plate():
    rows, _surplus, _trunc = plan_engine.cover({1: 10}, HOLDERS, {1}, None, _lanes(("A1", 1)))
    assert _picked(rows) == {2: 1}


def test_three_printers_keep_two_small_holder_plates_in_parallel():
    rows, _surplus, _trunc = plan_engine.cover({1: 10}, HOLDERS, {1}, None, _lanes(("A1", 3)))
    assert _picked(rows) == {1: 2}


def test_one_printer_covers_the_protect_class_without_waste():
    rows, surplus, _trunc = plan_engine.cover({2: 9}, PROTECT, {2}, None, _lanes(("A1", 1)))
    assert _picked(rows) == {5: 3}
    assert surplus == {}


def test_a_kit_line_chooses_inside_each_class():
    """GSA's real line: five parts, every plate covering its own subset of them."""
    kit = [
        _cand(11, {1: 5}, secs=60 * M),
        _cand(12, {1: 10}, secs=115 * M),
        _cand(13, {2: 5}, secs=61 * M),
        _cand(14, {2: 10}, secs=116 * M),
        _cand(15, {3: 1}, secs=42 * M),
        _cand(16, {3: 2}, secs=80 * M),
        _cand(17, {3: 3}, secs=115 * M),
        _cand(18, {3: 4}, secs=150 * M),
        _cand(19, {4: 5}, secs=70 * M),
        _cand(20, {5: 1}, secs=42 * M),
    ]
    demand = {1: 10, 2: 10, 3: 9, 4: 9, 5: 9}
    rows, _surplus, _trunc = plan_engine.cover(demand, kit, set(demand), None, _lanes(("A1", 1)))
    assert _picked(rows) == {12: 1, 14: 1, 17: 3, 19: 2, 20: 9}


@pytest.mark.parametrize("demand, bound", [(20, 660), (1000, 31_440)])
def test_c2_r1a_parallel_models_stay_parallel(demand, bound):
    """A1 1x/60 s beside P1S 2x/132 s, both idle: neither lane may stand while the other works."""
    cands = [_cand(1, {1: 1}, secs=60, model="A1"), _cand(2, {1: 2}, secs=132, model="P1S")]
    rows, _surplus, _trunc = plan_engine.cover(
        {1: demand}, cands, {1}, None, _lanes(("A1", 1), ("P1S", 1), prep=0, gap=0)
    )
    picked = _picked(rows)
    assert picked.get(1, 0) + 2 * picked.get(2, 0) >= demand
    assert max(picked.get(1, 0) * 60, picked.get(2, 0) * 132) <= bound


def test_c2_r1b_the_winner_changes_before_the_tail():
    cands = [_cand(1, {1: 3}, secs=600), _cand(2, {1: 4}, secs=780)]
    rows, surplus, _trunc = plan_engine.cover({1: 10}, cands, {1}, None, _lanes(("A1", 1), prep=0, gap=0))
    assert _picked(rows) == {2: 1, 1: 2}
    assert surplus == {}


@pytest.mark.parametrize("busy", [0.0, 3600.0])
def test_a_b_ab_keeps_two_small_plates(busy):
    """The r1 counterexample: different classes still meet on the established key."""
    cands = [_cand(1, {1: 1}, secs=60), _cand(2, {2: 1}, secs=60), _cand(3, {1: 1, 2: 1}, secs=600)]
    rows, _surplus, _trunc = plan_engine.cover(
        {1: 1, 2: 1}, cands, {1, 2}, None, _lanes(("A1", 1, busy), prep=0, gap=0)
    )
    assert _picked(rows) == {1: 1, 2: 1}


def test_the_last_part_takes_the_exact_plate_unless_a_wasteful_one_is_faster():
    wasteful = _cand(2, {1: 4}, secs=60)
    rows, _s, _t = plan_engine.cover(
        {1: 1}, [wasteful, _cand(1, {1: 1}, secs=60)], {1}, None, _lanes(("A1", 1), prep=0, gap=0)
    )
    assert _picked(rows) == {1: 1}
    rows, _s, _t = plan_engine.cover(
        {1: 1}, [wasteful, _cand(1, {1: 1}, secs=120)], {1}, None, _lanes(("A1", 1), prep=0, gap=0)
    )
    assert _picked(rows) == {2: 1}


def test_the_choice_does_not_depend_on_candidate_order():
    for seed in range(5):
        shuffled = list(PROTECT)
        random.Random(seed).shuffle(shuffled)
        rows, _s, _t = plan_engine.cover({2: 9}, shuffled, {2}, None, _lanes(("A1", 1)))
        assert _picked(rows) == {5: 3}


def test_lines_without_a_lane_keep_the_unscheduled_rule():
    rows, _s, _t = plan_engine.cover({1: 10}, HOLDERS, {1}, None, None)
    assert _picked(rows) == {2: 1}


class TestLookaheadMakespan:
    def test_the_lane_priority_prefix_matches_reserve(self):
        """An idle exact lane with a long prep is taken before an idle compatible one."""
        recipe = _cand(1, {1: 1}, secs=60, model="P1P")[2]
        capacity = FleetCapacity(
            [FleetMachine(1, "P1P", 0.0, 600, 0, True), FleetMachine(2, "P1S", 0.0, 0, 0, True)],
            allow_compatible=True,
        )
        for k, expected in ((1, 660), (2, 660), (3, 660), (20, 1140)):
            assert plan_engine._lookahead_makespan(capacity, recipe, k) == expected == _oracle(capacity, recipe, k)

    def test_the_formula_equals_repeated_reserve(self):
        rng = random.Random(20261021)
        models = ["A1", "A1 mini", "P1S", "P1P", "X1C"]
        compared = 0
        for _ in range(2000):
            machines = [
                FleetMachine(
                    i + 1,
                    rng.choice(models),
                    float(rng.choice([0, 0, rng.randint(1, 7200)])),
                    rng.choice([0, 60, 120, 600]),
                    rng.choice([0, 120, 300]),
                    True,
                )
                for i in range(rng.randint(1, 6))
            ]
            capacity = FleetCapacity(machines, allow_compatible=rng.random() < 0.5, auto_eject=rng.random() < 0.3)
            recipe = _cand(1, {1: 1}, secs=rng.choice([60, 132, 600, 780, 3600]), model=rng.choice(models))[2]
            if capacity.preview(recipe) is None:
                continue
            k = rng.randint(1, 80)
            assert plan_engine._lookahead_makespan(capacity, recipe, k) == _oracle(capacity, recipe, k)
            compared += 1
        assert compared > 1000

    @pytest.mark.parametrize("free_at, expected", [(0.9, 120.9), (0.1, 120.1)])
    def test_fractional_times_are_never_rounded(self, free_at, expected):
        """Codex r3 C3-M1: 0.9 / 0.1 must stay 120.9 / 120.1, not tie at 121."""
        capacity = _lanes(("A1", 1, free_at), prep=0, gap=0)
        recipe = _cand(1, {1: 1}, secs=60)[2]
        assert plan_engine._lookahead_makespan(capacity, recipe, 2) == pytest.approx(expected, abs=1e-9)
        assert plan_engine._lookahead_makespan(capacity, recipe, 2) == _oracle(capacity, recipe, 2)

    def test_an_applicable_operator_calendar_is_simulated(self):
        capacity = _lanes(("A1", 2), operator_hours=_night())
        recipe = _cand(1, {1: 1}, secs=3600)[2]
        assert plan_engine._lookahead_makespan(capacity, recipe, 7) == _oracle(capacity, recipe, 7)

    def test_the_ledger_is_never_touched(self):
        capacity = _lanes(("A1", 2, 50.0))
        before = [(m.printer_id, m.free_at) for m in capacity.machines]
        plan_engine._lookahead_makespan(capacity, _cand(1, {1: 1}, secs=60)[2], 9)
        assert [(m.printer_id, m.free_at) for m in capacity.machines] == before


def test_a_zero_simulation_budget_falls_back_to_the_current_key(monkeypatch):
    """A calendar forces the simulated oracle; with no budget the class is not fully compared."""
    monkeypatch.setattr(plan_engine, "LOOKAHEAD_SIM_BUDGET", 0)
    rows, _s, _t = plan_engine.cover({2: 9}, PROTECT, {2}, None, _lanes(("A1", 1), operator_hours=_night(12)))
    assert _picked(rows) == {3: 9}  # the next-print key, as before the lookahead
    monkeypatch.setattr(plan_engine, "LOOKAHEAD_SIM_BUDGET", 100_000)
    rows, _s, _t = plan_engine.cover({2: 9}, PROTECT, {2}, None, _lanes(("A1", 1), operator_hours=_night(12)))
    assert _picked(rows) != {3: 9}


def test_a_deadline_inside_the_lookahead_ends_the_cover_incomplete(monkeypatch):
    ticks = iter(range(100_000))
    monkeypatch.setattr(plan_engine.time, "monotonic", lambda: next(ticks))
    rows, surplus, truncated = plan_engine.cover({2: 9}, PROTECT, {2}, None, _lanes(("A1", 1)), deadline=4)
    assert (rows, surplus, truncated) == ([], {}, True)


def _cover_picks(demand, cands, capacity):
    rows, surplus, truncated = plan_engine.cover(dict(demand), cands, set(demand), None, capacity)
    assert truncated is False
    return _picked(rows), surplus


def test_the_closed_form_chooses_exactly_what_the_simulated_oracle_chooses(monkeypatch):
    """Randomized small lines: mixed models and yields, overlapping supports, uneven demand."""
    rng = random.Random(7)
    models = ["A1", "P1S", "X1C"]
    for _ in range(150):
        parts = list(range(1, rng.randint(2, 4)))
        cands = []
        for plate_id in range(1, rng.randint(3, 7)):
            covered = rng.sample(parts, rng.randint(1, len(parts)))
            cands.append(
                _cand(
                    plate_id,
                    {p: rng.randint(1, 5) for p in covered},
                    secs=rng.choice([60, 300, 600, 900, 1800]),
                    model=rng.choice(models),
                )
            )
        demand = {p: rng.randint(1, 12) for p in parts}
        specs = [(m, rng.randint(1, 2), float(rng.choice([0, 0, 300]))) for m in rng.sample(models, rng.randint(1, 3))]
        prep, gap = rng.choice([0, 120]), rng.choice([0, 300])

        fast = _cover_picks(demand, cands, _lanes(*specs, prep=prep, gap=gap))
        with monkeypatch.context() as patched:
            patched.setattr(plan_engine, "_closed_form_makespan", lambda *a, **k: None)
            patched.setattr(plan_engine, "LOOKAHEAD_SIM_BUDGET", 10**9)
            oracle = _cover_picks(demand, cands, _lanes(*specs, prep=prep, gap=gap))
        assert fast == oracle


@pytest.mark.parametrize(
    "budget, expected",
    [
        # The holder class (5x: 2 prints, 10x: 1) is compared in full on the first
        # step and wins with 10x; the protect class, next in order, is not — it
        # and every later step choose on the next-print key.
        (3, {2: 1, 30: 9}),
        # Cannot pay the holder class's 2 + 1 on the first step: it spends
        # nothing and takes a 5x on the next-print key; with 5 left both runs
        # cost 1, it is compared, and the 5x finishes first.
        (2, {1: 2, 30: 9}),
        # Budget for everything: both classes cover their work soonest.
        (100_000, {2: 1, 31: 3}),
    ],
)
def test_the_budget_falls_between_and_inside_classes(monkeypatch, budget, expected):
    monkeypatch.setattr(plan_engine, "LOOKAHEAD_SIM_BUDGET", budget)
    slow_protect = [_cand(30, {2: 1}, secs=120 * M), _cand(31, {2: 3}, secs=300 * M)]
    demand = {1: 10, 2: 9}
    rows, _s, _t = plan_engine.cover(
        demand, [*HOLDERS, *slow_protect], set(demand), None, _lanes(("A1", 1), operator_hours=_night(12))
    )
    assert _picked(rows) == expected


def test_a_member_whose_lanes_did_not_move_is_not_simulated_again(monkeypatch):
    """A calendar farm simulates; a member on a lane the step did not touch reuses its run.

    The P1S plate wins every step and only its lane moves, so the A1 member's
    idle lane is the same state with fewer prints asked — the prefix of the run
    it already made. Re-simulating it each step cost plate-fit its time budget.
    """
    calls = []
    real = plan_engine._simulated_makespan

    def spy(capacity, recipe, k, *args, **kwargs):
        calls.append((recipe.printer_model, k))
        return real(capacity, recipe, k, *args, **kwargs)

    monkeypatch.setattr(plan_engine, "_simulated_makespan", spy)
    cands = [_cand(1, {1: 10}, secs=60 * M, model="P1S"), _cand(2, {1: 1}, secs=30 * M, model="A1")]
    rows, _s, _t = plan_engine.cover(
        {1: 40}, cands, {1}, None, _lanes(("P1S", 1), ("A1", 1), operator_hours=_night(12))
    )
    assert _picked(rows) == {1: 4}
    assert [c for c in calls if c[0] == "A1"] == [("A1", 40)]
    assert [c for c in calls if c[0] == "P1S"] == [("P1S", 4), ("P1S", 3), ("P1S", 2), ("P1S", 1)]


def test_a_class_the_budget_cannot_pay_in_full_spends_nothing(monkeypatch):
    """Every member's run is paid for before any is made: a class whose cheap
    member fits the budget and whose other does not used to spend the budget on
    the cheap one and fall back anyway — on a calendar farm, the whole budget
    for no comparison at all."""
    calls = []
    real = plan_engine._simulated_makespan

    def spy(capacity, recipe, k, *args, **kwargs):
        calls.append((recipe.printer_model, k))
        return real(capacity, recipe, k, *args, **kwargs)

    monkeypatch.setattr(plan_engine, "_simulated_makespan", spy)
    monkeypatch.setattr(plan_engine, "LOOKAHEAD_SIM_BUDGET", 3)
    # A slow 10-up plate and a quick single: the single wins the next-print key
    # every step, so the remainder counts down by one.
    cands = [_cand(1, {1: 10}, secs=1200 * M, model="P1S"), _cand(2, {1: 1}, secs=5 * M, model="A1")]
    rows, _s, _t = plan_engine.cover(
        {1: 30}, cands, {1}, None, _lanes(("P1S", 1), ("A1", 1), operator_hours=_night(12))
    )
    assert _picked(rows) == {2: 30}
    # Unaffordable (1-3 + R > 3) until two remain; then both runs fit: 1 + 2.
    assert calls == [("P1S", 1), ("A1", 2)]


@pytest.mark.parametrize("budget, first", [(1000, 1), (2000, 4)])
def test_a_limited_budget_goes_to_classes_by_their_best_key(monkeypatch, budget, first):
    """The policy (owner, 2026-10-22; Codex C3-I1): classes are compared in the
    order of their best member's established key, so the budget reaches the
    likely winners first. Under a budget that cannot compare every class this
    is a CHOICE, not an equivalence: r3's order by the parts covered spent the
    1000 on class A and picked plate 3; this order spends it on class B, falls
    back in A and picks plate 1. With budget for both, both orders agree on 4.

    A fractional free_at keeps the closed form out; each class costs 999 + 1.
    """
    monkeypatch.setattr(plan_engine, "LOOKAHEAD_SIM_BUDGET", budget)
    cands = [
        _cand(1, {1: 1}, secs=100),
        _cand(2, {1: 999}, secs=1000),
        _cand(3, {2: 1}, secs=50),
        _cand(4, {2: 999}, secs=500),
    ]
    demand = {1: 999, 2: 999}
    for order in ([0, 1, 2, 3], [3, 2, 1, 0], [2, 0, 3, 1]):
        rows, _s, truncated = plan_engine.cover(
            dict(demand), [cands[i] for i in order], set(demand), None, _lanes(("A1", 1, 0.5), prep=0, gap=0)
        )
        assert truncated is False
        assert rows[0].plate_id == first
