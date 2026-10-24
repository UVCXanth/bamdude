"""The opt-in whole-plate search (PR #91, spec gh91 r2): bounded, request-local, honest about its limits.

A preview searches for 6 seconds, or 30 when the request asks for the extended search; the current quantity, the
lower and the upper direction share that one budget. Every canonical check of a candidate — the very
``greedy_option`` that confirm repeats under the database writer within its own 6 seconds — gets at most 3 seconds
(``CANDIDATE_SECONDS``) in both modes. A check that is cut short, or a found option that took longer, stops its
direction as ``limited``; a completed rejection is a proven «does not fit», whatever it cost, and the search goes
on within what is left of the budget. Confirm keeps 6 seconds.
"""

from fractions import Fraction
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from backend.app.schemas.plate_fit import PlateFitRequest
from backend.app.services import plate_fit as fit
from backend.tests.unit.services.test_plate_fit import snapshot


def _one_part(yields=(1,)):
    return snapshot([fit.Part(1, "Part A", 1, Fraction(0), 0)], [fit.Plate(1, yields)])


# --- the request ----------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("value", [1, 0, 30, "true", "false", None])
def test_the_search_mode_takes_only_an_explicit_boolean(value):
    with pytest.raises(ValidationError):
        PlateFitRequest(around=1000, extended_search=value)


def test_the_search_mode_is_the_short_one_unless_asked_for():
    assert PlateFitRequest(around=1000, extended_search=True).extended_search is True
    assert PlateFitRequest(around=1000).extended_search is False


# --- one budget, shared --------------------------------------------------------------------------------------------


@pytest.mark.parametrize("extended,seconds", [(False, 6), (True, 30)])
async def test_the_budget_keeps_time_for_both_directions(monkeypatch, extended, seconds):
    s = _one_part()
    clock = [100.0]
    turns = []

    def solve(_snapshot, low, high, direction, deadline, **kwargs):
        turns.append((low, high, deadline, kwargs))
        if low == high:
            return None, "none"
        if direction == -1:
            clock[0] = deadline
            return None, "limited"
        assert deadline > clock[0]
        return fit.option(s, low, [low]), "found"

    monkeypatch.setattr(fit.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(fit, "solve", solve)
    result = await fit.proposals(s, PlateFitRequest(around=1000, extended_search=extended))
    assert result["lower"] == "limited" and result["upper"] == "found"
    assert [v.quantity for v in result["options"]] == [1001]
    assert [turn[2] for turn in turns] == [100 + seconds / 3, 100 + seconds / 2, 100 + seconds]
    assert all(turn[3] == {"extended_search": extended} for turn in turns)
    assert fit.MAX_SECONDS == 6


@pytest.mark.parametrize("extended,cap,nodes", [(False, 1.5, 100_000), (True, 7.5, 500_000)])
@pytest.mark.parametrize("remaining", [0.25, 20])
def test_the_integer_solver_gets_more_time_never_past_its_turn(monkeypatch, extended, cap, nodes, remaining):
    import scipy.optimize

    s = _one_part((2,))
    options = []

    def limited(*args, **kwargs):
        options.append(kwargs["options"])
        return SimpleNamespace(status=1, x=[4, 2, 0])

    monkeypatch.setattr(fit.time, "monotonic", lambda: 100.0)
    monkeypatch.setattr(scipy.optimize, "milp", limited)
    assert fit.solve(s, 1, 5, 1, 100 + remaining, extended_search=extended) == (None, "limited")
    assert options == [{"time_limit": min(cap, remaining), "mip_rel_gap": 0.0, "node_limit": nodes}]


# --- each candidate's canonical check: 3 seconds, and what its answer proves -------------------------------------


class _Checks:
    """``greedy_option`` scripted per quantity — ``(answer, seconds)`` with answer ``found``/``reject``/``truncated``
    — on a fake clock; records the deadline each check was given."""

    def __init__(self, monkeypatch, snapshot_, script: dict[int, tuple[str, float]], start: float = 100.0):
        self.clock = [start]
        self.calls: list[tuple[int, float]] = []
        self.snapshot = snapshot_
        self.script = script
        monkeypatch.setattr(fit.time, "monotonic", lambda: self.clock[0])
        monkeypatch.setattr(fit, "greedy_option", self.check)

    def check(self, snapshot_, quantity, *, deadline=None):
        self.calls.append((quantity, deadline))
        answer, seconds = self.script.get(quantity, ("reject", 0.0))
        self.clock[0] += seconds
        if answer == "truncated":
            return None, True
        if answer == "found":
            runs = [quantity // self.snapshot.plates[0].yields[0]]
            return fit.option(self.snapshot, quantity, runs) or SimpleNamespace(quantity=quantity, runs=[]), False
        return None, False


def _integer_solver_proposes(monkeypatch, quantity: int, plates: int):
    import scipy.optimize

    monkeypatch.setattr(
        scipy.optimize, "milp", lambda *a, **k: SimpleNamespace(status=0, x=[quantity, plates, 0, 0, 0])
    )


@pytest.mark.parametrize(
    "seconds,expected", [(2.0, "found"), (3.0, "found"), (3.5, "limited")], ids=["under", "exactly", "over"]
)
def test_the_current_quantity_is_found_only_within_its_three_seconds(monkeypatch, seconds, expected):
    s = _one_part()
    checks = _Checks(monkeypatch, s, {7: ("found", seconds)})
    found, status = fit.solve(s, 7, 7, 1, 130.0)
    assert status == expected and (found is not None) == (expected == "found")
    assert checks.calls == [(7, 103.0)]  # start + 3, inside the caller's 130


@pytest.mark.parametrize(
    "seconds,expected", [(1.9, "found"), (2.0, "found"), (2.5, "limited")], ids=["inside", "at", "past"]
)
def test_a_found_option_must_also_land_inside_the_callers_shorter_deadline(monkeypatch, seconds, expected):
    """Codex review PF-R1: the deadline handed to a check does not stop a synchronous one by itself, so a found
    option that returns after its turn ended is unknown, even when it took less than the 3 candidate seconds."""
    s = _one_part()
    _Checks(monkeypatch, s, {7: ("found", seconds)})
    found, status = fit.solve(s, 7, 7, 1, 102.0)
    assert status == expected and (found is not None) == (expected == "found")


def test_a_completed_rejection_past_the_callers_deadline_is_still_proof(monkeypatch):
    s = _one_part()
    _Checks(monkeypatch, s, {7: ("reject", 2.5)})
    assert fit.solve(s, 7, 7, 1, 102.0) == (None, "none")  # «does not fit» is known, whatever it cost


def test_a_check_never_runs_past_the_callers_earlier_deadline(monkeypatch):
    s = _one_part()
    checks = _Checks(monkeypatch, s, {7: ("found", 0.5)})
    fit.solve(s, 7, 7, 1, 101.0)
    assert checks.calls == [(7, 101.0)]


def test_a_cut_short_check_at_the_edge_stops_the_direction(monkeypatch):
    s = _one_part()
    checks = _Checks(monkeypatch, s, {1: ("truncated", 3.0), 2: ("found", 0.1)})
    assert fit.solve(s, 1, 20, 1, 130.0) == (None, "limited")
    assert [q for q, _ in checks.calls] == [1]  # never skipped as if it did not fit


def test_a_slow_found_option_from_the_integer_solver_stops_the_direction(monkeypatch):
    s = _one_part((2,))
    _integer_solver_proposes(monkeypatch, 4, 2)
    checks = _Checks(monkeypatch, s, {4: ("found", 3.5), 5: ("found", 0.1), 6: ("found", 0.1)})
    assert fit.solve(s, 1, 20, 1, 130.0) == (None, "limited")
    assert [q for q, _ in checks.calls] == [1, 4]  # the farther 6 is never offered as the nearest


def test_a_slow_completed_rejection_is_proof_and_the_window_goes_on(monkeypatch):
    s = _one_part((2,))
    _integer_solver_proposes(monkeypatch, 4, 2)
    checks = _Checks(monkeypatch, s, {4: ("reject", 4.0), 5: ("reject", 0.1), 6: ("found", 0.1)})
    found, status = fit.solve(s, 1, 20, 1, 130.0)
    assert (status, found.quantity) == ("found", 6)
    assert [q for q, _ in checks.calls] == [1, 4, 5, 6]


def test_a_slow_completed_rejection_at_the_edge_lets_the_integer_solver_go_on(monkeypatch):
    s = _one_part((2,))
    _integer_solver_proposes(monkeypatch, 4, 2)
    checks = _Checks(monkeypatch, s, {1: ("reject", 5.0), 4: ("found", 0.2)})
    found, status = fit.solve(s, 1, 20, 1, 130.0)
    assert (status, found.quantity) == ("found", 4)
    assert [q for q, _ in checks.calls] == [1, 4]


def test_a_slow_found_option_in_the_window_stops_the_direction(monkeypatch):
    s = _one_part((2,))
    _integer_solver_proposes(monkeypatch, 4, 2)
    checks = _Checks(monkeypatch, s, {4: ("reject", 0.1), 5: ("found", 3.2), 6: ("found", 0.1)})
    assert fit.solve(s, 1, 20, 1, 130.0) == (None, "limited")
    assert [q for q, _ in checks.calls] == [1, 4, 5]


def test_a_completed_rejection_renews_no_budget(monkeypatch):
    """The turn is spent by a slow but completed «does not fit»: the next check does not start."""
    s = _one_part((2,))
    _integer_solver_proposes(monkeypatch, 4, 2)
    checks = _Checks(monkeypatch, s, {4: ("reject", 3.0), 5: ("found", 0.1)})
    assert fit.solve(s, 1, 20, 1, 103.0) == (None, "limited")
    assert [q for q, _ in checks.calls] == [1, 4]


def test_the_integer_solver_may_take_longer_than_a_check(monkeypatch):
    """The 3 seconds bound the canonical check confirm repeats, not the search for a candidate."""
    import scipy.optimize

    s = _one_part((2,))
    checks = _Checks(monkeypatch, s, {4: ("found", 0.2)})

    def slow_solver(*args, **kwargs):
        checks.clock[0] += 5.0
        return SimpleNamespace(status=0, x=[4, 2, 0, 0, 0])

    monkeypatch.setattr(scipy.optimize, "milp", slow_solver)
    found, status = fit.solve(s, 1, 20, 1, 130.0)
    assert (status, found.quantity) == ("found", 4)


def test_confirm_keeps_its_six_seconds(monkeypatch):
    s = _one_part()
    checks = _Checks(monkeypatch, s, {7: ("found", 4.0)})
    confirmation = SimpleNamespace(
        basis=s.basis,
        acknowledge_queue_change=False,
        acknowledge_large_change=True,
        runs=[SimpleNamespace(plate_id=1, count=7)],
    )
    assert fit.confirm(s, 7, confirmation).quantity == 7  # 4 s is past a preview check, not past confirm
    assert checks.calls == [(7, 106.0)]
