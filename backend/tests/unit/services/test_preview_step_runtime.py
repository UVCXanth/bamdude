"""STEP through the real preview chain: main → guardian → preview service → guardian → disposable children
(spec §6, plan A3). Missing CAD is nonfatal; the converter and the PNG child run in sequence under one slot, one
attempt id and one absolute deadline; the watchdog is the only source of resource_limit."""

from __future__ import annotations

import hashlib
import io
import json
import logging
import subprocess
import sys
import time
import zipfile
from pathlib import Path

import pytest

from backend.app import step_runtime
from backend.app.services.preview_protocol import STEP_WATCHDOG_BYTES
from backend.app.services.preview_runtime import PreviewRuntime

ROOT = Path(__file__).resolve().parents[4]
BOX = ROOT / "backend" / "tests" / "fixtures" / "step" / "authored" / "box_mm.step"


def fake_broken_bundle(app_dir: Path) -> None:
    """A bundle whose receipt matches this catalog and interpreter but whose OCP cannot be imported."""
    catalog = step_runtime.load_catalog()
    selection = step_runtime.select(catalog)
    target = step_runtime.bundle_dir(app_dir, selection.key, catalog.digest)
    (target / "site" / "OCP").mkdir(parents=True)
    (target / "site" / "OCP" / "__init__.py").write_text("raise ImportError('DLL load failed')\n", encoding="utf-8")
    (target / "receipt.json").write_text(json.dumps(step_runtime.receipt_for(catalog, selection)), encoding="utf-8")


async def _identity(runtime: PreviewRuntime):
    return runtime.service.process.pid, runtime.epoch, len(runtime.restarts), runtime.uncertain


def _stl_box() -> bytes:
    import trimesh

    return trimesh.creation.box().export(file_type="stl")


@pytest.fixture
async def runtime_without_cad(tmp_path):
    runtime = PreviewRuntime(tmp_path / "preview", app_dir=tmp_path / "app-without-cad")
    await runtime.start()
    assert runtime.ready
    try:
        yield runtime
    finally:
        await runtime.stop()


@pytest.mark.asyncio
async def test_b1_four_steps_without_cad_then_stl_on_the_same_service(runtime_without_cad):
    runtime = runtime_without_cad
    before = await _identity(runtime)
    sequence = runtime.sequence
    for _ in range(4):
        async with runtime.attempt({"mesh": (BOX, "step")}) as result:
            assert result.outcome == "cad_unavailable" and not result.files
    assert runtime.sequence == sequence  # no command reached the service
    async with runtime.attempt({"mesh": (_stl_box(), "stl")}) as result:
        assert result.outcome == "ok" and "preview" in result.files
    assert await _identity(runtime) == before


@pytest.mark.asyncio
async def test_b1_service_side_cad_failure_is_nonfatal_too(tmp_path):
    """The bundle passes main's gate but its import fails in the converter: still cad_unavailable, four times,
    then an STL on the same service PID, epoch and restart count."""
    app = tmp_path / "app"
    fake_broken_bundle(app)
    runtime = PreviewRuntime(tmp_path / "preview", app_dir=app)
    await runtime.start()
    try:
        before = await _identity(runtime)
        for _ in range(4):
            async with runtime.attempt({"mesh": (BOX, "step")}) as result:
                assert (result.outcome, result.stage) == ("cad_unavailable", "cad_import")
        async with runtime.attempt({"mesh": (_stl_box(), "stl")}) as result:
            assert result.outcome == "ok"
        assert await _identity(runtime) == before
    finally:
        await runtime.stop()


@pytest.mark.asyncio
async def test_step_and_sliced_are_refused_before_any_command(runtime_without_cad):
    sequence = runtime_without_cad.sequence
    async with runtime_without_cad.attempt({"mesh": (BOX, "step"), "sliced": (b"PK", "3mf")}) as result:
        assert result.outcome == "protocol_error"
    assert runtime_without_cad.sequence == sequence


@pytest.fixture
async def cad_runtime(tmp_path):
    from backend.tests.cad_lane import cad_app_dir

    runtime = PreviewRuntime(tmp_path / "preview", app_dir=cad_app_dir())
    await runtime.start()
    assert runtime.ready
    try:
        yield runtime
    finally:
        await runtime.stop()


@pytest.mark.requires_cad
@pytest.mark.asyncio
async def test_a_real_step_becomes_a_png_through_both_children(cad_runtime, caplog):
    from PIL import Image

    caplog.set_level(logging.INFO, logger="backend.app.services.preview_runtime")
    async with cad_runtime.attempt({"mesh": (BOX, "step")}) as result:
        assert (result.outcome, result.kind, result.stage) == ("ok", "step", "png")
        assert result.input_digests["mesh"] == hashlib.sha256(BOX.read_bytes()).hexdigest()
        with Image.open(result.files["preview"]) as image:
            assert image.format == "PNG" and image.getbbox() is not None
        attempt_id = result.attempt_id
    assert f"Preview attempt start attempt={attempt_id} kind=step" in caplog.text
    assert f"Preview attempt={attempt_id} kind=step outcome=ok stage=png" in caplog.text
    assert str(BOX) not in caplog.text and str(cad_runtime.root) not in caplog.text  # no private paths


@pytest.mark.requires_cad
@pytest.mark.asyncio
async def test_a_refused_step_names_its_stage_and_keeps_the_service(cad_runtime):
    bad = ROOT / "backend" / "tests" / "fixtures" / "step" / "authored" / "trunc_50.step"
    before = await _identity(cad_runtime)
    async with cad_runtime.attempt({"mesh": (bad, "step")}) as result:
        assert (result.outcome, result.stage) == ("render_failed", "transfer")
    assert await _identity(cad_runtime) == before


_DENSE = """
import sys
from pathlib import Path
from backend.app.step_preview_probe import activate_bundle
activate_bundle(Path(sys.argv[1]))
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace
from OCP.collections import Array1_double, Array1_int, Array2_gp_Pnt
from OCP.Geom import Geom_BSplineSurface
from OCP.gp import gp_Pnt
from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer
N = 300
poles = Array2_gp_Pnt(1, N, 1, N)
for i in range(1, N + 1):
    for j in range(1, N + 1):
        poles.SetValue(i, j, gp_Pnt(200.0 * (i - 1) / (N - 1), 200.0 * (j - 1) / (N - 1), 2.0 * (1 if (i + j) % 2 else -1)))
nk = N - 2
knots, mults = Array1_double(1, nk), Array1_int(1, nk)
for k in range(1, nk + 1):
    knots.SetValue(k, (k - 1) / (nk - 1))
    mults.SetValue(k, 4 if k in (1, nk) else 1)
face = BRepBuilderAPI_MakeFace(Geom_BSplineSurface(poles, knots, knots, mults, mults, 3, 3), 1e-6).Face()
writer = STEPControl_Writer()
writer.Transfer(face, STEPControl_AsIs)
writer.Write(sys.argv[2])
"""


@pytest.mark.requires_cad
@pytest.mark.asyncio
async def test_a_runaway_step_is_stopped_by_the_watchdog_four_times_and_slicing_still_works(cad_runtime, tmp_path):
    """The dense B-spline (6.8 MB, inside every input cap) grows in the mesher: the parent watchdog at
    STEP_WATCHDOG_BYTES ends it — resource_limit, proven end, no service restart or circuit — and a sliced
    attempt right after it runs normally (spec §7.1 G2 on the real chain)."""
    from backend.tests.cad_lane import located

    dense = tmp_path / "dense.step"
    subprocess.run([sys.executable, "-c", _DENSE, str(located().site), str(dense)], cwd=ROOT, check=True, timeout=300)
    before = await _identity(cad_runtime)
    for _ in range(4):
        started = time.monotonic()
        async with cad_runtime.attempt({"mesh": (dense, "step")}) as result:
            assert (result.outcome, result.stage) == ("resource_limit", "mesh"), result
            assert not result.files
        assert time.monotonic() - started < 60
    assert await _identity(cad_runtime) == before
    content = io.BytesIO()
    with zipfile.ZipFile(content, "w") as archive:
        archive.writestr("Metadata/plate_1.gcode", "G1 X1 Y2\n")
    async with cad_runtime.attempt({"sliced": (content.getvalue(), "3mf"), "mesh": (_stl_box(), "stl")}) as result:
        assert result.outcome == "ok" and "output" in result.files
    assert await _identity(cad_runtime) == before


# --- service-level unit checks (no real children) -----------------------------------------------------------


class _FakeChild:
    """Stands in for PreviewProcess in the service's render loop."""

    def __init__(self, root: Path, *, rss: int, exit_after: float, result: dict | None):
        self.root, self._rss, self.result = root, rss, result
        self.stopped = False
        self._end = time.monotonic() + exit_after

        class _P:
            def poll(inner):
                return 0xC0000005 if time.monotonic() >= self._end else None

        self.process = _P()

    def rss(self):
        return self._rss

    def stop(self):
        self.stopped = True
        if self.result is not None:
            (self.root / "result.json").write_text(json.dumps(self.result), encoding="utf-8")


@pytest.mark.asyncio
async def test_a_native_crash_near_the_limit_is_render_failed_not_resource_limit(tmp_path, monkeypatch):
    import backend.app.preview_service as module
    from backend.app.services.preview_protocol import PreviewError

    service = module.Service({"cache": str(tmp_path / "cache")})
    children = []

    def spawn(module_name, bootstrap, cache, **kwargs):
        child = _FakeChild(tmp_path, rss=STEP_WATCHDOG_BYTES - 1, exit_after=0.2, result=None)
        children.append(child)
        return child

    monkeypatch.setattr(module, "PreviewProcess", spawn)
    deadline = time.monotonic_ns() + int(30e9)
    with pytest.raises(PreviewError) as err:
        await service.render(tmp_path, "convert", deadline, rss_limit=STEP_WATCHDOG_BYTES, fail_on_error=False)
    assert err.value.outcome == "render_failed"  # no result, memory near the limit: still no OOM claim
    assert children[0].stopped


@pytest.mark.asyncio
async def test_the_watchdog_is_the_parents_own_decision(tmp_path, monkeypatch):
    import backend.app.preview_service as module
    from backend.app.services.preview_protocol import PreviewError

    service = module.Service({"cache": str(tmp_path / "cache")})
    children = []

    def spawn(module_name, bootstrap, cache, **kwargs):
        child = _FakeChild(tmp_path, rss=STEP_WATCHDOG_BYTES + 1, exit_after=60, result=None)
        children.append((child, kwargs))
        return child

    monkeypatch.setattr(module, "PreviewProcess", spawn)
    with pytest.raises(PreviewError) as err:
        await service.render(
            tmp_path, "convert", time.monotonic_ns() + int(30e9), rss_limit=STEP_WATCHDOG_BYTES, job_memory=1 << 30
        )
    assert err.value.outcome == "resource_limit"
    child, kwargs = children[0]
    assert child.stopped and kwargs == {"job_memory_limit": 1 << 30}


@pytest.mark.asyncio
async def test_the_png_phase_inherits_the_absolute_deadline(tmp_path, monkeypatch):
    import backend.app.preview_service as module
    from backend.app.services.preview_protocol import Command

    service = module.Service({"cache": str(tmp_path / "cache"), "app_dir": str(tmp_path)})
    calls = []

    async def render(root, operation, deadline, kind="stl", **kwargs):
        calls.append((operation, deadline, kwargs.get("rss_limit"), kwargs.get("job_memory")))
        if operation == "convert":
            return {"outcome": "ok", "stage": "mesh_write", "triangles": 12}
        (root / "preview.png").write_bytes(b"\x89PNG\r\n\x1a\n")  # a PNG child that says ok leaves its picture
        return {"outcome": "ok"}

    async def fake_get(store, ref, path, deadline):
        path.write_bytes(b"ISO-10303-21;")

    monkeypatch.setattr(service, "render", render)
    monkeypatch.setattr(service, "cad_site", lambda cad: tmp_path)
    monkeypatch.setattr(module, "get", fake_get)
    deadline = time.monotonic_ns() + int(90e9)
    attempt = "a" * 32
    command = Command.parse(
        {
            "protocol_version": 2,
            "app_generation": "g",
            "service_epoch": "e",
            "attempt_id": attempt,
            "attempt_seq": 1,
            "operation": "run",
            "deadline_monotonic_ns": deadline,
            "manifest": [{"role": "mesh", "key": f"{attempt}_mesh", "kind": "step", "size": 1, "digest": "b" * 64}],
            "cad": {"manifest_digest": "c" * 64, "bundle_key": "win-x64-cp312"},
        },
        "g",
        "e",
    )
    progress = {"stage": "snapshot"}
    await service.step(tmp_path, command, None, progress)
    assert [c[0] for c in calls] == ["convert", "cad_png"]
    assert calls[0][1] == calls[1][1] == deadline  # the PNG child gets no fresh 120 s
    assert all(c[2] == STEP_WATCHDOG_BYTES and c[3] == 1 << 30 for c in calls)
    assert progress["stage"] == "png" and not (tmp_path / "input.step").exists()


def test_the_converter_is_an_allowlisted_guardian_module():
    from backend.app.worker_guardian import _PREVIEW_MODULES

    assert "backend.app.services.step_thumbnail" in _PREVIEW_MODULES


def test_job_memory_limit_sets_commit_and_die_on_unhandled(monkeypatch):
    if sys.platform != "win32":
        pytest.skip("named skip: Windows Job Object flags")
    import backend.app.services.worker_containment as wc

    seen = {}
    real = wc._windows_kernel32

    def capture():
        k = real()
        original = k.SetInformationJobObject

        def set_info(job, cls, info, size):
            import ctypes

            data = ctypes.cast(info, ctypes.POINTER(wc._JOBOBJECT_EXTENDED_LIMIT_INFORMATION)).contents
            seen["flags"], seen["limit"] = data.BasicLimitInformation.LimitFlags, data.JobMemoryLimit
            return original(job, cls, info, size)

        k.SetInformationJobObject = set_info
        return k

    monkeypatch.setattr(wc, "_windows_kernel32", capture)
    proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(5)"])
    try:
        containment = wc.WorkerContainment.attach(proc.pid, job_memory_limit=1 << 30)
        assert seen["limit"] == 1 << 30 and seen["flags"] & 0x200 and seen["flags"] & 0x400
        containment.close()  # kill-on-close
        assert proc.wait(timeout=10) is not None
    finally:
        if proc.poll() is None:
            proc.kill()


def test_stl_keeps_its_one_gib_contract():
    """The early STEP trigger does not change the STL/OBJ watchdog (RSS_BYTES) or add a Job commit limit."""
    import inspect

    import backend.app.preview_service as module
    from backend.app.services.preview_protocol import RSS_BYTES

    params = inspect.signature(module.Service.render).parameters
    assert params["rss_limit"].default == RSS_BYTES and params["job_memory"].default is None
    source = inspect.getsource(module.Service.run)
    assert 'self.render(root, "mesh", deadline, mesh.kind)' in source  # no STEP limits on the STL branch
