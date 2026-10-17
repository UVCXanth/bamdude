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

from backend.app.services.library_preview import PublicationGate
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


# --- a backup's pause of the pictures (Codex A2-R2, A-r3) ----------------------------------------------------------
# Nothing waits for a pause inside the slot. A result that must be published finding the pictures paused is
# DEFERRED — nothing handed off, nothing kept, its end proven, the slot freed — and its owner retries after the
# pause; at entry it is deferred before anything is read. The slicing output needs no publication right: it is
# handed off without a lease, and only a lease lets a caller attach a library picture.


class _Pause:
    """A backup holding the pictures paused until ``lift()``."""

    def __init__(self, gate):
        self.gate, self.entered, self.lifted, self.task = gate, asyncio.Event(), asyncio.Event(), None

    def start(self) -> None:
        self.task = asyncio.create_task(self._hold())

    async def _hold(self):
        async with self.gate.pause(1):
            self.entered.set()
            await self.lifted.wait()

    async def lift(self):
        self.lifted.set()
        if self.task is not None:
            await self.task


def _pause_when_the_run_is_sent(rt, pause: _Pause) -> None:
    """The backup begins right as the run command goes out: the attempt reaches its hand-off under the pause."""
    original = rt._rpc

    async def rpc(command, operation=None, **kwargs):
        if operation is None and command.operation == "run" and pause.task is None:
            pause.start()
            await pause.entered.wait()
        return await original(command, operation, **kwargs)

    rt._rpc = rpc


def _staged(rt) -> list[Path]:
    return [p for p in (rt.staging / "main").rglob("*") if p.is_file()]


async def _attempt(rt, inputs, **kwargs):
    async with rt.attempt(inputs, **kwargs) as result:
        return result.outcome, set(result.files), result.publishable


@pytest.mark.asyncio
@pytest.mark.parametrize("priority", ["low", "normal"])
async def test_a_result_reaching_its_hand_off_under_a_pause_is_deferred_and_frees_the_slot(runtime, priority):
    gate = PublicationGate()
    pause = _Pause(gate)
    _pause_when_the_run_is_sent(runtime, pause)
    before = await _identity(runtime)
    try:
        attempt = _attempt(runtime, {"mesh": (_box(), "stl")}, priority=priority, publication=gate)
        assert await asyncio.wait_for(attempt, 30) == ("publication_deferred", set(), False)
        assert gate.paused() and gate.leases == 0  # it never waited for the backup
        assert not runtime.slot.locked() and _staged(runtime) == []
        assert await _identity(runtime) == before  # ended by the ordinary proof of end, no restart
    finally:
        await pause.lift()


@pytest.mark.asyncio
async def test_a_paused_gate_defers_an_attempt_before_it_reads_or_converts_anything(runtime, tmp_path):
    gate = PublicationGate()
    sent = run_sent(runtime)
    absent = {"mesh": (tmp_path / "absent.stl", "stl")}
    async with gate.pause(1), runtime.attempt(absent, publication=gate) as result:
        assert (result.outcome, result.attempt_id) == ("publication_deferred", None)  # the file was not read
    assert not sent.is_set() and not runtime.slot.locked()


@pytest.mark.asyncio
async def test_a_sliced_attempt_under_a_pause_keeps_its_output_without_a_right_to_publish(runtime):
    gate = PublicationGate()
    pause = _Pause(gate)
    _pause_when_the_run_is_sent(runtime, pause)
    try:
        sliced = _attempt(
            runtime,
            {"sliced": (_sliced(), "3mf"), "mesh": (_box(), "stl")},
            publication=gate,
            publication_optional=True,
        )
        outcome, files, publishable = await asyncio.wait_for(sliced, 30)
        assert outcome == "ok" and {"output", "preview"} <= files and publishable is False
        assert gate.paused() and gate.leases == 0  # it did not wait for the backup either
    finally:
        await pause.lift()


@pytest.mark.asyncio
async def test_a_closed_gate_revokes_a_required_publication_but_never_the_slicing_output(runtime):
    gate = PublicationGate()
    gate.close()  # a restore
    low = await _attempt(runtime, {"mesh": (_box(), "stl")}, priority="low", publication=gate)
    assert low == ("preempted", set(), False)
    outcome, files, publishable = await _attempt(
        runtime, {"sliced": (_sliced(), "3mf"), "mesh": (_box(), "stl")}, publication=gate, publication_optional=True
    )
    assert outcome == "ok" and "output" in files and publishable is False
    assert gate.leases == 0


@pytest.mark.requires_cad
@pytest.mark.asyncio
async def test_a_converted_step_reaching_its_hand_off_under_a_pause_is_deferred_and_slicing_goes_on(cad_runtime):
    """The real STEP chain (converter, PNG child): the picture is ready when the backup begins; the STEP is
    deferred at once and a sliced file gets its picture while the pause still holds."""
    from backend.app.step_runtime import PROBE_STEP

    gate = PublicationGate()
    pause = _Pause(gate)
    _pause_when_the_run_is_sent(cad_runtime, pause)
    before = await _identity(cad_runtime)
    try:
        step = _attempt(cad_runtime, {"mesh": (PROBE_STEP, "step")}, publication=gate)
        assert await asyncio.wait_for(step, 60) == ("publication_deferred", set(), False)
        sliced = await _attempt(
            cad_runtime,
            {"sliced": (_sliced(), "3mf"), "mesh": (_box(), "stl")},
            publication=gate,
            publication_optional=True,
        )
        assert sliced[0] == "ok" and gate.paused()
        assert await _identity(cad_runtime) == before and _staged(cad_runtime) == []
    finally:
        await pause.lift()


@pytest.mark.asyncio
async def test_after_hand_off_neither_a_pause_nor_a_sliced_arrival_interrupts_the_publication(runtime):
    gate, seen = PublicationGate(), {}
    paused = asyncio.Event()

    async def backup():
        async with gate.pause(30):
            paused.set()

    async def high():
        async with runtime.attempt({"sliced": (_sliced(), "3mf"), "mesh": (_box(), "stl")}) as result:
            seen["high"] = result.outcome

    async with runtime.attempt({"mesh": (_box(), "stl")}, priority="low", publication=gate) as low:
        assert low.outcome == "ok" and low.publishable and gate.leases == 1  # its lease is its right
        ticket = runtime.slot.holder
        copy, arrival = asyncio.create_task(backup()), asyncio.create_task(high())
        await asyncio.sleep(0.3)
        assert not paused.is_set()  # the pause waits for the publication in flight
        assert not ticket.revoke.is_set() and runtime.slot.holder is ticket and "high" not in seen
    await asyncio.wait_for(asyncio.gather(copy, arrival), 60)
    assert paused.is_set() and seen == {"high": "ok"} and gate.leases == 0


@pytest.mark.asyncio
async def test_an_attempts_log_lines_name_their_owner(runtime, caplog):
    import logging

    from backend.app.services.preview_runtime import PREVIEW_OWNER

    caplog.set_level(logging.INFO, logger="backend.app.services.preview_runtime")
    token = PREVIEW_OWNER.set("job=j7 file=42")
    try:
        async with runtime.attempt({"mesh": (_box(), "stl")}) as result:
            assert result.outcome == "ok"
            attempt = result.attempt_id
    finally:
        PREVIEW_OWNER.reset(token)
    lines = [r.getMessage() for r in caplog.records if f"attempt={attempt}" in r.getMessage()]
    assert any("start" in line and "job=j7 file=42" in line for line in lines), lines
    assert any("outcome=ok" in line and "job=j7 file=42" in line for line in lines), lines
