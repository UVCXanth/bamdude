"""PR87-R1: actual greedy loops, incomplete results and owned cancellation."""

import asyncio
import threading
import time
from fractions import Fraction
from types import SimpleNamespace

import pytest

from backend.app.schemas.plate_fit import PlateFitRequest
from backend.app.services import plan_engine, plate_fit as fit, stock_offers, stock_pick
from backend.tests.unit.services.test_plan_engine import _cand, _ctx, _line, _part
from backend.tests.unit.services.test_plate_fit import snapshot


def timed_farm(monkeypatch):
    s = snapshot([fit.Part(1, "Part A", 1, Fraction(0), 0)], [fit.Plate(1, (1,), 60), fit.Plate(2, (1,), 60)], 90)
    for _, _, recipe in s.candidates:
        recipe.printer_model = "P1S"
    s.capacity = plan_engine.FleetCapacity([plan_engine.FleetMachine(i, "P1S") for i in (1, 2)])
    clock = [0.0]
    original = plan_engine._pick_key

    def advance(*args):
        clock[0] += 0.2
        return original(*args)

    monkeypatch.setattr(fit.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(plan_engine, "_pick_key", advance)
    return s, clock


async def test_R1_expiry_inside_current_cover_keeps_both_directional_turns(monkeypatch):
    s, clock = timed_farm(monkeypatch)
    original = fit.greedy_option
    attempts = []

    def observed(snapshot, quantity, **kwargs):
        attempts.append(quantity)
        return original(snapshot, quantity, **kwargs)

    monkeypatch.setattr(fit, "greedy_option", observed)
    result = await fit.proposals(s, PlateFitRequest(around=90))
    assert result["current"] == result["lower"] == result["upper"] == "limited"
    assert not result["options"]
    assert attempts == [90, 89, 91]
    assert clock[0] < 7  # Cooperative interruption, not the 36+ score-unit full cover.


async def test_R1_expired_preceding_line_never_starts_the_selected_cover(monkeypatch):
    s, _clock = timed_farm(monkeypatch)
    preceding, target = _line(1, 1, 90), _line(2, 2, 10)
    preceding.mode = target.mode = "product"
    s.line_id, s.quantity = 2, 10
    s.parts = [fit.Part(2, "Part B", 1, Fraction(0), 0)]
    s.plates = [fit.Plate(3, (1,), 60)]
    s.candidates = [_cand(3, 2, {2: 1}, secs=60, model="P1S")]
    s.context = _ctx([preceding, target], [_part(1, 1, "Part A", 1), _part(2, 2, "Part B", 1)])
    s.recipes = {1: [_cand(1, 1, {1: 1}, secs=60, model="P1S")], 2: s.candidates}
    s.supply = stock_offers.Supply(
        {i: stock_pick.Suggestion(i, 0, 0, 0, 0, 1, None, None) for i in (1, 2)}, {1: {1: 0}, 2: {2: 0}}
    )
    original = plan_engine.cover
    covers = []

    def observed(outstanding, *args, **kwargs):
        covers.append(set(outstanding))
        return original(outstanding, *args, **kwargs)

    monkeypatch.setattr(plan_engine, "cover", observed)
    result = await fit.proposals(s, PlateFitRequest(around=10))
    assert result["current"] == result["lower"] == result["upper"] == "limited"
    assert not result["options"]
    assert covers and all(ids == {1} for ids in covers)


def test_R1_apply_revalidation_is_bounded_before_any_stock_or_queue_write(monkeypatch):
    s, clock = timed_farm(monkeypatch)
    confirmation = SimpleNamespace(
        basis=s.basis, acknowledge_large_change=False, runs=[SimpleNamespace(plate_id=1, count=90)]
    )
    with pytest.raises(fit.FitError, match="busy"):
        fit.confirm(s, 90, confirmation)
    assert clock[0] < 7
    assert all(machine.free_at == 0 for machine in s.capacity.machines)


def test_R1_optional_deadline_preserves_the_ordinary_fleet_mix():
    candidates = [_cand(1, 1, {1: 3}, secs=60, model="P1S"), _cand(2, 1, {1: 2}, secs=25, model="A1 Mini")]
    capacity = plan_engine.FleetCapacity([plan_engine.FleetMachine(1, "P1S"), plan_engine.FleetMachine(2, "A1 Mini")])
    ordinary = plan_engine.cover({1: 20}, candidates, {1}, None, capacity.copy())
    bounded = plan_engine.cover({1: 20}, candidates, {1}, None, capacity.copy(), deadline=time.monotonic() + 60)
    assert ordinary == bounded
    assert not bounded[2]


@pytest.mark.parametrize("extended", [False, True])
async def test_R1_cancelled_preview_retains_admission_until_worker_exits(monkeypatch, extended):
    s = snapshot([fit.Part(1, "Part A", 1, Fraction(0), 0)], [fit.Plate(1, (1,), 60)], 10)
    entered, release = threading.Event(), threading.Event()
    slot = asyncio.Semaphore(1)
    next_owner = asyncio.Event()

    def blocked(*args, **kwargs):
        entered.set()
        assert release.wait(5)
        return None, True

    monkeypatch.setattr(fit, "greedy_option", blocked)

    async def first():
        async with slot:
            await fit.proposals(s, PlateFitRequest(around=10, extended_search=extended))

    async def second():
        async with slot:
            next_owner.set()

    task = asyncio.create_task(first())
    try:
        assert await asyncio.to_thread(entered.wait, 5)
        task.cancel()
        await asyncio.sleep(0)
        task.cancel()
        await asyncio.sleep(0)
        assert slot.locked() and not task.done()
        successor = asyncio.create_task(second())
        await asyncio.sleep(0)
        assert not next_owner.is_set()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        await successor
        assert next_owner.is_set() and not slot.locked()
    finally:
        release.set()
        if not task.done():
            with pytest.raises(asyncio.CancelledError):
                await task
