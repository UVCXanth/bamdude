"""The two moments an outside owner of an attempt needs (spec §4.1/§4.2, plan A4): the slot's admission — from which
a job's budgets run and whose deadline the owner sets — and the hand-off of an ok result, the point of no return
after which a DELETE answers cancel_too_late. Both are synchronous callbacks inside the attempt."""

from __future__ import annotations

import asyncio
import time

import pytest

from backend.app.services.preview_runtime import PreviewRuntime


def _box() -> bytes:
    import trimesh

    return trimesh.creation.box().export(file_type="stl")


def _heavy(path):
    import trimesh

    path.write_bytes(trimesh.creation.torus(1.0, 0.3, major_sections=900, minor_sections=900).export(file_type="stl"))
    return path


@pytest.fixture
async def runtime(tmp_path):
    rt = PreviewRuntime(tmp_path / "preview")
    from backend.tests.preview_support import started

    await started(rt)
    try:
        yield rt
    finally:
        await rt.stop()


@pytest.mark.asyncio
async def test_on_admit_runs_when_the_slot_is_granted_not_while_waiting(runtime):
    events = []
    holding = asyncio.Event()
    release = asyncio.Event()

    async def first():
        async with runtime.attempt({"mesh": (_box(), "stl")}) as result:
            assert result.outcome == "ok"
            holding.set()
            await release.wait()  # the slot stays held while the caller publishes

    def admit():
        events.append(("admitted", runtime.slot.locked()))
        return None

    task = asyncio.create_task(first())
    await holding.wait()
    second = asyncio.create_task(_run(runtime, admit))
    await asyncio.sleep(0.5)
    assert events == []  # still waiting for the slot
    release.set()
    await task
    assert await second == "ok"
    assert events == [("admitted", True)]


async def _run(runtime, admit=None, hand_off=None, inputs=None):
    async with runtime.attempt(inputs or {"mesh": (_box(), "stl")}, on_admit=admit, on_hand_off=hand_off) as result:
        return result.outcome


@pytest.mark.asyncio
async def test_the_deadline_on_admit_returns_bounds_the_attempt(runtime, tmp_path):
    heavy = _heavy(tmp_path / "heavy.stl")
    started = time.monotonic()
    outcome = await _run(runtime, admit=lambda: time.monotonic_ns() + int(1.5e9), inputs={"mesh": (heavy, "stl")})
    assert outcome == "timeout"
    assert time.monotonic() - started < 15  # the owner's 1.5 s, not the default active budget


@pytest.mark.asyncio
async def test_on_hand_off_marks_only_an_ok_result_and_before_the_caller_sees_it(runtime, tmp_path):
    marks = []

    async with runtime.attempt({"mesh": (_box(), "stl")}, on_hand_off=lambda: marks.append("handed_off")) as result:
        assert result.outcome == "ok" and marks == ["handed_off"]
    bad = tmp_path / "bad.stl"
    bad.write_bytes(b"solid nothing\nendsolid nothing\n" * 20)
    async with runtime.attempt({"mesh": (bad, "stl")}, on_hand_off=lambda: marks.append("bad")) as result:
        assert result.outcome != "ok"
    assert marks == ["handed_off"]  # a failure is no publication: nothing to protect from a DELETE
