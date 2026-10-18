"""Synthetic whole-plate arithmetic, including independent exhaustive checks."""

import time
from fractions import Fraction
from itertools import product
from types import SimpleNamespace

import pytest

from backend.app.schemas.plate_fit import PlateFitRequest
from backend.app.services import plate_fit as fit


def snapshot(parts, plates, quantity=1000):
    return fit.Snapshot(1, quantity, 1, parts, plates, "a" * 64, [])


def solve(s, lo, hi, direction=1):
    return fit.solve(s, lo, hi, direction, time.monotonic() + 5)


def test_nearest_can_be_three_times_the_order_and_browse_at_twenty_thousand():
    s = snapshot(
        [fit.Part(1, "Part A", 1, Fraction(0), 0), fit.Part(2, "Part B", 1, Fraction(0), 0)],
        [fit.Plate(1, (1000, 0)), fit.Plate(2, (0, 3000))],
    )
    assert solve(s, 1001, fit.MAX_QUANTITY)[0].quantity == 3000
    assert solve(s, 1, 999, -1) == (None, "none")
    assert solve(s, 1, 19999, -1)[0].quantity == 18000
    assert solve(s, 20001, fit.MAX_QUANTITY)[0].quantity == 21000


def test_same_quantity_can_use_a_different_mix_than_the_greedy():
    s = snapshot([fit.Part(1, "Part A", 1, Fraction(0), 0)], [fit.Plate(1, (6,)), fit.Plate(2, (4,))])
    result, status = solve(s, 8, 8)
    assert status == "found" and result.quantity == 8
    assert [(r.plate_id, r.count) for r in result.runs] == [(2, 2)]


def test_stock_offsets_can_prove_no_solution():
    s = snapshot(
        [fit.Part(1, "Part A", 1, Fraction(0), 3), fit.Part(2, "Part B", 1, Fraction(0), 0)],
        [fit.Plate(1, (10, 0)), fit.Plate(2, (0, 16))],
    )
    assert solve(s, 1, fit.MAX_QUANTITY) == (None, "none")


def test_bonus_rounds_once_for_the_whole_order():
    s = snapshot(
        [fit.Part(1, "Part A", 3, Fraction(3, 10), 2), fit.Part(2, "Part B", 1, Fraction(1, 20), 1)],
        [fit.Plate(1, (7, 0)), fit.Plate(2, (0, 5))],
    )
    exact = [
        n for n in range(1, 201) if (s.parts[0].required(n) - 2) % 7 == 0 and (s.parts[1].required(n) - 1) % 5 == 0
    ]
    result, status = solve(s, 1, 200)
    assert status == "found" and result.quantity == min(exact)
    assert result.parts[0].required == 3 * result.quantity + (3 * result.quantity + 9) // 10


@pytest.mark.parametrize("offsets", [(0, 0), (1, 2), (3, 0)])
def test_mixed_plate_answers_match_exhaustive_small_integer_search(offsets):
    s = snapshot(
        [fit.Part(1, "Part A", 3, Fraction(0), offsets[0]), fit.Part(2, "Part B", 1, Fraction(0), offsets[1])],
        [fit.Plate(1, (4, 1)), fit.Plate(2, (2, 3)), fit.Plate(3, (3, 0))],
    )
    exact = set()
    for counts in product(range(21), repeat=3):
        a = offsets[0] + sum(p.yields[0] * n for p, n in zip(s.plates, counts, strict=True))
        b = offsets[1] + sum(p.yields[1] * n for p, n in zip(s.plates, counts, strict=True))
        if a == b * 3 and 1 <= b <= 20:
            exact.add(b)
    for low, high, direction in [(1, 20, 1), (1, 20, -1), (8, 14, 1), (8, 14, -1)]:
        possible = [n for n in exact if low <= n <= high]
        result, status = solve(s, low, high, direction)
        assert status == ("found" if possible else "none")
        if possible:
            assert result.quantity == (min(possible) if direction == 1 else max(possible))


def test_timeout_never_claims_no_solution_or_nearest(monkeypatch):
    import scipy.optimize

    s = snapshot([fit.Part(1, "Part A", 1, Fraction(0), 0)], [fit.Plate(1, (1,))])
    monkeypatch.setattr(scipy.optimize, "milp", lambda *a, **k: SimpleNamespace(status=1, x=[3, 3, 0]))
    assert solve(s, 1, 5) == (None, "limited")
    assert fit.solve(s, 1, 5, 1, 0) == (None, "limited")


def test_solver_output_is_rechecked_with_exact_integer_arithmetic(monkeypatch):
    import scipy.optimize

    s = snapshot([fit.Part(1, "Part A", 1, Fraction(0), 0)], [fit.Plate(1, (7,))])
    monkeypatch.setattr(scipy.optimize, "milp", lambda *a, **k: SimpleNamespace(status=0, x=[8, 1, 0]))
    assert solve(s, 1, 20) == (None, "limited")


async def test_browse_is_sorted_unique_and_stays_near_the_typed_quantity():
    s = snapshot([fit.Part(1, "Part A", 1, Fraction(0), 0)], [fit.Plate(1, (12,))], quantity=20_000)
    result = await fit.proposals(s, PlateFitRequest(around=20_000, steps=3))
    assert [o.quantity for o in result["options"]] == [19968, 19980, 19992, 20004, 20016, 20028]


def test_large_change_needs_a_fresh_acknowledgement_and_stale_basis_is_refused():
    s = snapshot([fit.Part(1, "Part A", 1, Fraction(0), 0)], [fit.Plate(1, (1,))], quantity=1000)
    confirm = SimpleNamespace(
        basis=s.basis, acknowledge_large_change=False, runs=[SimpleNamespace(plate_id=1, count=1100)]
    )
    assert fit.confirm(s, 1100, confirm).quantity == 1100
    confirm.runs[0].count = 1101
    with pytest.raises(fit.FitError, match="large_change"):
        fit.confirm(s, 1101, confirm)
    confirm.acknowledge_large_change = True
    assert fit.confirm(s, 1101, confirm).quantity == 1101
    confirm.basis = "b" * 64
    with pytest.raises(fit.FitError, match="stale"):
        fit.confirm(s, 1101, confirm)
