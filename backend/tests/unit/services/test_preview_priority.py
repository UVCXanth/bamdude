"""Priority on the real chain (spec §4.2, plan A3): only a sliced (high) arrival interrupts an active STEP (low);
the low attempt ends as the internal ``preempted`` with its service work proven over, without any task
cancellation and without a service restart; after the hand-off a high waits instead of interrupting."""

from __future__ import annotations

import asyncio
import io
import time
import zipfile
from pathlib import Path

import pytest

from backend.app.services.preview_protocol import C_CANCEL_SECONDS
from backend.app.services.preview_runtime import PreviewRuntime

ROOT = Path(__file__).resolve().parents[4]


def _sliced() -> bytes:
    content = io.BytesIO()
    with zipfile.ZipFile(content, "w") as archive:
        archive.writestr("Metadata/plate_1.gcode", "G1 X1 Y2\n")
    return content.getvalue()


def _heavy_stl(path: Path) -> Path:
    import trimesh

    path.write_bytes(trimesh.creation.torus(1.0, 0.3, major_sections=600, minor_sections=600).export(file_type="stl"))
    return path


def _box() -> bytes:
    import trimesh

    return trimesh.creation.box().export(file_type="stl")


async def _identity(runtime):
    return runtime.service.process.pid, runtime.epoch, len(runtime.restarts), runtime.uncertain


@pytest.fixture
async def runtime(tmp_path):
    rt = PreviewRuntime(tmp_path / "preview")
    await rt.start()
    assert rt.ready
    try:
        yield rt
    finally:
        await rt.stop()


def run_sent(runtime) -> asyncio.Event:
    """Set when a run command has really been SENT to the service (not merely numbered)."""
    sent = asyncio.Event()
    original = runtime._rpc

    async def rpc(command, operation=None, **kwargs):
        if operation is None and command.operation == "run":
            sent.set()
        return await original(command, operation, **kwargs)

    runtime._rpc = rpc
    return sent


@pytest.mark.asyncio
async def test_a_sliced_arrival_preempts_an_active_low_with_proof_and_no_restart(runtime, tmp_path):
    heavy = _heavy_stl(tmp_path / "heavy.stl")
    before = await _identity(runtime)
    low_seen = {}

    async def low():
        async with runtime.attempt({"mesh": (heavy, "stl")}, priority="low") as result:
            low_seen["outcome"], low_seen["files"] = result.outcome, dict(result.files)
        low_seen["cancelling"] = asyncio.current_task().cancelling()

    events = []
    real_cancel, real_release = runtime._cancel, runtime.slot.release

    async def slow_cancel(command):
        await asyncio.sleep(0.5)  # a proof that takes a moment: the slot must still wait for it
        await real_cancel(command)
        events.append("proof_of_end")

    def release(ticket=None):
        events.append(("release", ticket.priority if ticket else None))
        real_release(ticket)

    runtime._cancel, runtime.slot.release = slow_cancel, release
    sent = run_sent(runtime)
    low_task = asyncio.create_task(low())
    await asyncio.wait_for(sent.wait(), 30)  # the run command is out: the revoke must race the reply
    await asyncio.sleep(0.5)  # the service is rendering
    started = time.monotonic()
    async with runtime.attempt({"sliced": (_sliced(), "3mf"), "mesh": (_box(), "stl")}) as high:
        waited = time.monotonic() - started
        assert high.outcome == "ok" and "output" in high.files
    await low_task
    assert low_seen == {"outcome": "preempted", "files": {}, "cancelling": 0}  # no Task.cancel, nothing published
    assert events.index("proof_of_end") < events.index(("release", "low"))  # the slot is released after the reap
    assert waited < C_CANCEL_SECONDS + 5
    assert await _identity(runtime) == before


@pytest.mark.asyncio
async def test_a_normal_arrival_never_interrupts_an_active_low(runtime, tmp_path):
    heavy = _heavy_stl(tmp_path / "heavy.stl")
    order = []

    async def low():
        async with runtime.attempt({"mesh": (heavy, "stl")}, priority="low") as result:
            order.append(("low", result.outcome))

    sent = run_sent(runtime)
    low_task = asyncio.create_task(low())
    await asyncio.wait_for(sent.wait(), 30)
    async with runtime.attempt({"mesh": (_box(), "stl")}, wait_seconds=120) as result:
        order.append(("normal", result.outcome))
    await low_task
    assert order == [("low", "ok"), ("normal", "ok")]


@pytest.mark.asyncio
async def test_after_hand_off_a_sliced_arrival_waits_for_the_publication(runtime):
    seen = {}

    async def high():
        async with runtime.attempt({"sliced": (_sliced(), "3mf"), "mesh": (_box(), "stl")}) as result:
            seen["high"] = result.outcome

    async with runtime.attempt({"mesh": (_box(), "stl")}, priority="low") as low:
        assert low.outcome == "ok" and "preview" in low.files
        ticket = runtime.slot.holder
        task = asyncio.create_task(high())
        await asyncio.sleep(0.3)
        assert not ticket.revoke.is_set() and runtime.slot.holder is ticket  # the publication is never interrupted
        assert low.files["preview"].exists() and "high" not in seen
    await task
    assert seen == {"high": "ok"} and not runtime.slot.locked()


@pytest.fixture
async def cad_runtime(tmp_path):
    from backend.tests.cad_lane import cad_app_dir

    rt = PreviewRuntime(tmp_path / "preview", app_dir=cad_app_dir())
    await rt.start()
    try:
        yield rt
    finally:
        await rt.stop()


@pytest.mark.requires_cad
@pytest.mark.asyncio
async def test_a_sliced_arrival_preempts_a_running_step_converter(cad_runtime, tmp_path):
    import subprocess
    import sys

    from backend.tests.cad_lane import located
    from backend.tests.unit.services.test_preview_step_runtime import _DENSE

    dense = tmp_path / "dense.step"
    subprocess.run([sys.executable, "-c", _DENSE, str(located().site), str(dense)], cwd=ROOT, check=True, timeout=300)
    before = await _identity(cad_runtime)
    seen = {}

    async def step():
        async with cad_runtime.attempt({"mesh": (dense, "step")}) as result:
            seen["outcome"] = result.outcome

    sent = run_sent(cad_runtime)
    task = asyncio.create_task(step())
    await asyncio.wait_for(sent.wait(), 30)
    await asyncio.sleep(1.0)  # the converter is meshing
    async with cad_runtime.attempt({"sliced": (_sliced(), "3mf"), "mesh": (_box(), "stl")}) as high:
        assert high.outcome == "ok"
    await task
    assert seen == {"outcome": "preempted"}
    assert await _identity(cad_runtime) == before


@pytest.mark.asyncio
async def test_an_stl_behind_an_active_low_gets_its_picture_with_the_default_wait(runtime, tmp_path, monkeypatch):
    """The doors (upload, ZIP, the STL batch) pass no wait: an STL arriving while a STEP converts must not end
    'busy' only because the STEP outlasts the ordinary queue budget (review A-I4)."""
    from backend.app.services import preview_runtime as pr

    monkeypatch.setattr(pr, "QUEUE_SECONDS", 0.3)  # far shorter than the low below
    heavy = _heavy_stl(tmp_path / "heavy.stl")
    order = []

    async def low():
        async with runtime.attempt({"mesh": (heavy, "stl")}, priority="low") as result:
            order.append(("low", result.outcome))

    sent = run_sent(runtime)
    low_task = asyncio.create_task(low())
    await asyncio.wait_for(sent.wait(), 30)
    async with runtime.attempt({"mesh": (_box(), "stl")}) as result:  # no wait_seconds, as every door
        order.append(("normal", result.outcome))
    await low_task
    assert order == [("low", "ok"), ("normal", "ok")]
