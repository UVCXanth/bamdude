"""The opt-in search budget stays bounded, request-local and honest about limits."""

from fractions import Fraction
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from backend.app.schemas.plate_fit import PlateFitRequest
from backend.app.services import plate_fit as fit
from backend.tests.unit.services.test_plate_fit import snapshot


@pytest.mark.parametrize("extended,seconds", [(False, 6), (True, 30)])
async def test_search_budget_keeps_time_for_both_directions(monkeypatch, extended, seconds):
    s = snapshot([fit.Part(1, "Part A", 1, Fraction(0), 0)], [fit.Plate(1, (1,))])
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
    assert turns[0][2] == 100 + seconds / 3
    assert turns[1][2] == 100 + seconds / 2
    assert turns[2][2] == 100 + seconds
    assert all(turn[3].get("extended_search", False) is extended for turn in turns)
    assert fit.MAX_SECONDS == 6


@pytest.mark.parametrize("extended,cap,nodes", [(False, 1.5, 100_000), (True, 7.5, 500_000)])
@pytest.mark.parametrize("remaining", [0.25, 20])
def test_inner_solver_gets_more_time_without_exceeding_the_direction_deadline(
    monkeypatch, extended, cap, nodes, remaining
):
    import scipy.optimize

    s = snapshot([fit.Part(1, "Part A", 1, Fraction(0), 0)], [fit.Plate(1, (2,))])
    options = []

    def limited(*args, **kwargs):
        options.append(kwargs["options"])
        return SimpleNamespace(status=1, x=[4, 2, 0])

    monkeypatch.setattr(fit.time, "monotonic", lambda: 100.0)
    monkeypatch.setattr(scipy.optimize, "milp", limited)
    assert fit.solve(s, 1, 5, 1, 100 + remaining, extended_search=extended) == (None, "limited")
    assert options == [{"time_limit": min(cap, remaining), "mip_rel_gap": 0.0, "node_limit": nodes}]


@pytest.mark.parametrize("value", [1, 0, 30, "true", "false", None])
def test_search_mode_accepts_only_an_explicit_boolean(value):
    with pytest.raises(ValidationError):
        PlateFitRequest(around=1000, extended_search=value)


def test_search_mode_defaults_to_fast_for_each_request():
    assert PlateFitRequest(around=1000, extended_search=True).extended_search is True
    assert PlateFitRequest(around=1000).extended_search is False
