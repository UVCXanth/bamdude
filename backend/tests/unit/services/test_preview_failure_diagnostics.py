"""A failed preview says why, and a child's rename never fails it (CI 39059567831, win-x64-cp313/cp314).

Two separate questions. The parent's watchdog counts the attempt's staging bytes every 50 ms while the child renames
its own files into place (the converter's stage marker, result.json and mesh.stl; the PNG child's picture): a file
renamed between the listing and its stat must not end the attempt — before this, the service's catch-all turned the
FileNotFoundError into render_failed, at the stage the marker had just reached. And every failure reaches the parent
log with its stage, a closed reason, which process decided it and that process's exit code — never a path, stderr or
an exception's text."""

from __future__ import annotations

import io
import json
import logging
import os
import pathlib
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend.app.services.preview_protocol import STEP_WATCHDOG_BYTES, Command, PreviewError

ROOT = Path(__file__).resolve().parents[4]
CRASH = 0xC0000005


class _Child:
    """A disposable child the test controls: it runs for ``seconds``, then ends with ``code``; what it wrote is in
    its root before the parent first polls."""

    def __init__(self, seconds: float = 0.3, code: int = 0):
        self._end = time.monotonic() + seconds
        self.stopped = False

        class _P:
            def poll(inner):
                return code if time.monotonic() >= self._end else None

        self.process = _P()

    def rss(self):
        return 1

    def stop(self):
        self.stopped = True


class _Vanished:
    """The listing's entry of a file a child renamed right after the listing: stat'ed late it is gone (what a POSIX
    DirEntry does; a Path-based poll stats the path again)."""

    def __init__(self, path: Path, fired: list):
        self.name, self.path, self._fired = path.name, str(path), fired

    def is_file(self, *, follow_symlinks=True):
        return True

    def is_symlink(self):
        return False

    def stat(self, *, follow_symlinks=True):
        self._fired.append("entry_stat")
        raise FileNotFoundError(2, "No such file or directory", self.path)


class _Listing:
    def __init__(self, entries):
        self.entries = entries

    def __enter__(self):
        return iter(self.entries)

    def __exit__(self, *exc):
        return False

    def __iter__(self):
        return iter(self.entries)


def _rename_between_listing_and_stat(monkeypatch, root: Path, name: str, new_name: str) -> list:
    """The child's rename of ``name`` landing between the watchdog's listing and its stat, deterministically,
    whichever way the watchdog lists. A Path-based poll (is_file, then stat — on 3.13+ its iterdir itself lists
    through scandir and keeps only the paths) gets a real rename right after its is_file; a scandir-based poll gets
    an entry that is gone when stat'ed. Each fires once, from the moment the file exists; ``fired`` proves the race
    was exercised."""
    fired = []
    real_is_file = pathlib.Path.is_file
    real_scandir = os.scandir
    listed = []

    def is_file(self, *args, **kwargs):
        answer = real_is_file(self, *args, **kwargs)
        if answer and "path" not in fired and self.parent == root and self.name == name:
            os.replace(self, self.with_name(new_name))
            fired.append("path")
        return answer

    def scandir(path="."):
        if listed or Path(path) != root or not (root / name).exists():
            return real_scandir(path)
        listed.append(True)
        with real_scandir(path) as it:
            entries = [e for e in it if e.name != name]
        return _Listing([*entries, _Vanished(root / name, fired)])

    monkeypatch.setattr(pathlib.Path, "is_file", is_file)
    monkeypatch.setattr(os, "scandir", scandir)
    return fired


def _service(tmp_path, **config):
    import backend.app.preview_service as module

    return module, module.Service({"cache": str(tmp_path / "cache"), **config})


def _deadline(seconds: float = 30) -> int:
    return time.monotonic_ns() + int(seconds * 1e9)


# --- the watchdog and a child's renames ----------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("operation", "name", "new_name"),
    [
        ("convert", "stage.part", "stage"),
        ("cad_png", "0f3e.png", "preview.png"),
        ("convert", "mesh.stl.part", "mesh.stl"),
    ],
)
async def test_a_file_the_child_renames_during_the_byte_poll_does_not_end_the_attempt(
    tmp_path, monkeypatch, operation, name, new_name
):
    module, service = _service(tmp_path)
    root = tmp_path / "attempt"
    root.mkdir()
    (root / name).write_bytes(b"transfer")
    (root / "result.json").write_text(json.dumps({"outcome": "ok"}), encoding="utf-8")
    monkeypatch.setattr(module, "PreviewProcess", lambda *a, **k: _Child())
    fired = _rename_between_listing_and_stat(monkeypatch, root, name, new_name)

    result = await service.render(root, operation, _deadline(), rss_limit=STEP_WATCHDOG_BYTES, fail_on_error=False)

    assert fired, "the race was not exercised: the watchdog lists the staging by neither Path nor scandir"
    assert result["outcome"] == "ok"


@pytest.mark.asyncio
async def test_a_stage_marker_renamed_under_the_poll_leaves_the_step_to_finish(tmp_path, monkeypatch):
    """The CI signature: before, this ended render_failed at stage=transfer in the converter's first second."""
    module, service = _service(tmp_path, app_dir=str(tmp_path))
    root = tmp_path / "attempt"
    root.mkdir()
    fired = _rename_between_listing_and_stat(monkeypatch, root, "stage.part", "stage")

    def spawn(module_name, bootstrap, cache, **kwargs):
        if module_name == "backend.app.services.step_thumbnail":
            (root / "stage.part").write_text("transfer", encoding="ascii")
            (root / "result.json").write_text(
                json.dumps({"outcome": "ok", "stage": "mesh_write", "triangles": 12}), encoding="utf-8"
            )
        else:
            (root / "preview.png").write_bytes(b"\x89PNG\r\n\x1a\n")
            (root / "result.json").write_text(json.dumps({"outcome": "ok"}), encoding="utf-8")
        return _Child()

    async def fake_get(store, ref, path, deadline):
        path.write_bytes(b"ISO-10303-21;")

    monkeypatch.setattr(module, "PreviewProcess", spawn)
    monkeypatch.setattr(module, "get", fake_get)
    monkeypatch.setattr(service, "cad_site", lambda cad: tmp_path)
    progress = {"stage": "snapshot"}

    await service.step(root, _command(), None, progress)

    assert fired and progress["stage"] == "png"


def _command(attempt: str = "a" * 32) -> Command:
    return Command.parse(
        {
            "protocol_version": 2,
            "app_generation": "g",
            "service_epoch": "e",
            "attempt_id": attempt,
            "attempt_seq": 1,
            "operation": "run",
            "deadline_monotonic_ns": _deadline(90),
            "manifest": [{"role": "mesh", "key": f"{attempt}_mesh", "kind": "step", "size": 1, "digest": "b" * 64}],
            "cad": {"manifest_digest": "c" * 64, "bundle_key": "win-x64-cp312"},
        },
        "g",
        "e",
    )


# --- every failure names its stage, its closed reason, who decided it and that child's exit code -------------------


@pytest.mark.requires_cad
@pytest.mark.asyncio
async def test_a_native_crash_reaches_the_parent_with_its_own_exit_code(tmp_path):
    """The real guardian and converter: a native fault (the converter's access_violation seam; Windows error
    dialogs are off in the converter and in its Job) ends with no result, and the parent sees the CRASH's code —
    0xC0000005 on Windows, 128 + SIGSEGV on POSIX — not what an overflowing SystemExit makes of it."""
    import signal

    from backend.tests.cad_lane import located

    module, service = _service(tmp_path)
    root = tmp_path / "attempt"
    root.mkdir()
    (root / "input.step").write_bytes((ROOT / "backend/tests/fixtures/step/authored/box_mm.step").read_bytes())
    deadline = _deadline(120)
    bootstrap = {"root": str(root), "deadline": deadline, "site": str(located().site), "faults": ["access_violation"]}
    with pytest.raises(PreviewError) as err:
        await service.render(
            root,
            "convert",
            deadline,
            module="backend.app.services.step_thumbnail",
            bootstrap=bootstrap,
            rss_limit=STEP_WATCHDOG_BYTES,
            fail_on_error=False,
        )
    crash = CRASH if os.name == "nt" else 128 + signal.SIGSEGV
    assert (err.value.outcome, err.value.why, err.value.by, err.value.exit_code) == (
        "render_failed",
        "no_result",
        "convert",
        crash,
    )


@pytest.mark.asyncio
async def test_a_child_that_ends_without_a_result_names_no_result_and_its_exit_code(tmp_path, monkeypatch):
    module, service = _service(tmp_path)
    monkeypatch.setattr(module, "PreviewProcess", lambda *a, **k: _Child(seconds=0.1, code=CRASH))
    with pytest.raises(PreviewError) as err:
        await service.render(tmp_path, "convert", _deadline(), rss_limit=STEP_WATCHDOG_BYTES, fail_on_error=False)
    assert (err.value.outcome, err.value.why, err.value.by, err.value.exit_code) == (
        "render_failed",
        "no_result",
        "convert",
        CRASH,
    )


def _step_children(monkeypatch, module, root, convert: dict, png: dict | None, *, png_file: bool, codes=(1, 0)):
    def spawn(module_name, bootstrap, cache, **kwargs):
        converter = module_name == "backend.app.services.step_thumbnail"
        (root / "result.json").write_text(json.dumps(convert if converter else png), encoding="utf-8")
        if not converter and png_file:
            (root / "preview.png").write_bytes(b"\x89PNG\r\n\x1a\n")
        return _Child(seconds=0.05, code=codes[0] if converter else codes[1])

    async def fake_get(store, ref, path, deadline):
        path.write_bytes(b"ISO-10303-21;")

    monkeypatch.setattr(module, "PreviewProcess", spawn)
    monkeypatch.setattr(module, "get", fake_get)


@pytest.mark.asyncio
async def test_a_converter_refusal_names_its_closed_reason_and_exit_code(tmp_path, monkeypatch):
    module, service = _service(tmp_path, app_dir=str(tmp_path))
    root = tmp_path / "attempt"
    root.mkdir()
    refusal = {"outcome": "render_failed", "why": "external_reference", "stage": "transfer"}
    _step_children(monkeypatch, module, root, refusal, None, png_file=False)
    monkeypatch.setattr(service, "cad_site", lambda cad: tmp_path)
    progress = {"stage": "snapshot"}
    with pytest.raises(PreviewError) as err:
        await service.step(root, _command(), None, progress)
    assert (err.value.outcome, err.value.why, err.value.by, err.value.exit_code) == (
        "render_failed",
        "external_reference",
        "convert",
        1,
    )
    assert progress["stage"] == "transfer"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("png", "png_file", "why"),
    [
        ({"outcome": "ok"}, False, "png_missing"),  # exit 0, says ok, left no picture
        ({"outcome": "render_failed", "why": "no_picture"}, False, "no_picture"),  # exit 0, says why
    ],
)
async def test_a_png_child_that_exits_0_without_a_picture_is_explained(tmp_path, monkeypatch, png, png_file, why):
    module, service = _service(tmp_path, app_dir=str(tmp_path))
    root = tmp_path / "attempt"
    root.mkdir()
    converted = {"outcome": "ok", "stage": "mesh_write", "triangles": 12}
    _step_children(monkeypatch, module, root, converted, png, png_file=png_file, codes=(0, 0))
    monkeypatch.setattr(service, "cad_site", lambda cad: tmp_path)
    progress = {"stage": "snapshot"}
    with pytest.raises(PreviewError) as err:
        await service.step(root, _command(), None, progress)
    assert (err.value.outcome, err.value.why, err.value.by, err.value.exit_code) == ("render_failed", why, "cad_png", 0)
    assert progress["stage"] == "png"


@pytest.mark.asyncio
@pytest.mark.parametrize("why", ["C:\\Users\\someone\\part.step", "Error: boom", "x" * 65, 7, None])
async def test_a_reason_that_is_not_a_closed_token_is_not_passed_on(tmp_path, monkeypatch, why):
    module, service = _service(tmp_path)
    (tmp_path / "result.json").write_text(json.dumps({"outcome": "render_failed", "why": why}), encoding="utf-8")
    monkeypatch.setattr(module, "PreviewProcess", lambda *a, **k: _Child(seconds=0.05, code=0))
    with pytest.raises(PreviewError) as err:
        await service.render(tmp_path, "mesh", _deadline())
    assert (err.value.why, err.value.by, err.value.exit_code) == (None, "mesh", 0)


@pytest.mark.asyncio
async def test_a_service_side_exception_is_named_by_class_only(tmp_path, monkeypatch):
    module, service = _service(tmp_path, staging=str(tmp_path / "staging"), url="nats://unused", token="t", bucket="b")
    (tmp_path / "staging").mkdir()
    secret = "C:\\Users\\someone\\Documents\\bracket.step"

    class _Transfer:
        def jetstream(self, **kwargs):
            return self

        async def object_store(self, bucket):
            return object()

    async def connect(*args, **kwargs):
        return _Transfer()

    async def closed(nc, **kwargs):
        return True

    async def step(root, command, store, progress):
        progress["stage"] = "transfer"
        raise FileNotFoundError(2, "No such file or directory", secret)

    monkeypatch.setattr(module.nats, "connect", connect)
    monkeypatch.setattr(module, "close_transfer", closed)
    monkeypatch.setattr(service, "step", step)

    reply = await service.run(_command())

    assert reply == {"outcome": "render_failed", "stage": "transfer", "why": "FileNotFoundError", "by": "service"}
    assert secret not in json.dumps(reply) and "No such file" not in json.dumps(reply)


# --- the PNG child names its own failures ---------------------------------------------------------------------------


def _run_render_child(monkeypatch, root: Path) -> dict:
    """The PNG child's main() in THIS process, so its renderer can be replaced. Operation mesh only: cad_png sets an
    RLIMIT_DATA on Linux, which in-process would cap pytest itself and every child it starts afterwards (cad_png
    runs in a real process below)."""
    from backend.app import preview_render

    request = {"root": str(root), "operation": "mesh", "kind": "stl", "deadline": _deadline()}
    stdin = SimpleNamespace(buffer=io.BytesIO((json.dumps(request) + "\n").encode()))
    monkeypatch.setattr(sys, "stdin", stdin)
    assert preview_render.main() == 0
    return json.loads((root / "result.json").read_text(encoding="utf-8"))


def _binary_stl(path: Path) -> None:
    import struct

    tri = struct.pack("<12fH", 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0)
    path.write_bytes(b"\0" * 80 + struct.pack("<I", 1) + tri)


def test_the_png_childs_own_exception_is_named_by_class_only(tmp_path, monkeypatch):
    import backend.app.services.stl_thumbnail as stl

    _binary_stl(tmp_path / "mesh.stl")
    picture = tmp_path / "0f3e.png"
    picture.write_bytes(b"\x89PNG\r\n\x1a\n")
    monkeypatch.setattr(stl, "generate_stl_thumbnail", lambda source, root: str(picture))
    real_replace = os.replace

    def replace(src, dst):
        if Path(src) == picture:
            raise PermissionError(5, "Access is denied", str(src))
        return real_replace(src, dst)

    monkeypatch.setattr(os, "replace", replace)
    result = _run_render_child(monkeypatch, tmp_path)
    assert result["outcome"] == "render_failed" and result["why"] == "PermissionError"
    assert "Access" not in json.dumps(result) and str(tmp_path) not in json.dumps(result)


@pytest.mark.parametrize("logged", [True, False])
def test_a_renderer_that_returns_no_picture_is_named(tmp_path, monkeypatch, logged):
    """generate_stl_thumbnail swallows its own failure and returns None: the class of the exception it logged, or
    no_picture — never the logged text, which carries the source path."""
    import backend.app.services.stl_thumbnail as stl

    _binary_stl(tmp_path / "mesh.stl")

    def nothing(source, root):
        if logged:
            try:
                raise ValueError(f"cannot read {source}")
            except ValueError as e:
                stl.logger.warning("Failed to generate STL thumbnail for %s: %s", source, e, exc_info=True)
        return None

    monkeypatch.setattr(stl, "generate_stl_thumbnail", nothing)
    result = _run_render_child(monkeypatch, tmp_path)
    assert (result["outcome"], result["why"]) == ("render_failed", "ValueError" if logged else "no_picture")
    assert str(tmp_path) not in json.dumps(result)


@pytest.mark.parametrize(("operation", "why"), [("cad_png", "mesh_invalid"), ("mesh", "no_picture")])
def test_a_real_png_child_that_exits_0_without_a_picture_says_why(tmp_path, operation, why):
    """The real child process, no fakes: a mesh it cannot use, exit code 0, and a closed reason in its result. An
    ASCII STL without a facet: too short for the binary check, and the renderer answers nothing on every OS (random
    bytes read as a binary STL is a MemoryError on Linux — a closed reason too, but not the same one)."""
    (tmp_path / "mesh.stl").write_bytes(b"solid empty\nendsolid empty\n")
    request = {"root": str(tmp_path), "operation": operation, "kind": "stl", "deadline": _deadline(120)}
    p = subprocess.run(
        [sys.executable, "-m", "backend.app.preview_render"],
        input=json.dumps(request) + "\n",
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=180,
    )
    result = json.loads((tmp_path / "result.json").read_text(encoding="utf-8"))
    assert p.returncode == 0 and not (tmp_path / "preview.png").exists()
    assert (result["outcome"], result["why"]) == ("render_failed", why)


# --- main: the parent log line ------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("reply", "expected"),
    [
        ({"why": "external_reference", "by": "convert", "exit": 1}, ("external_reference", "convert", 1)),
        ({"why": "no_result", "by": "cad_png", "exit": CRASH}, ("no_result", "cad_png", CRASH)),
        ({"why": "C:\\secret\\x.step", "by": "convert", "exit": 1}, (None, "convert", 1)),
        ({"why": "no_result", "by": "uvicorn", "exit": "1"}, ("no_result", None, None)),
        ({"why": "no_result", "by": "convert", "exit": True}, ("no_result", "convert", None)),
        # JSON arrays and objects are unhashable: dropped like any other wrong form, never a TypeError (Codex D-M1)
        ({"why": "no_result", "by": [], "exit": 1}, ("no_result", None, 1)),
        ({"why": "no_result", "by": {}, "exit": 1}, ("no_result", None, 1)),
        ({"why": ["no_result"], "by": "mesh", "exit": {}}, (None, "mesh", None)),
        ({}, (None, None, None)),
    ],
)
def test_main_takes_only_closed_diagnostics_from_a_reply(reply, expected):
    from backend.app.services.preview_protocol import reply_diagnostics

    assert reply_diagnostics(reply) == expected


@pytest.mark.parametrize("by", [[], {}, ["convert"]])
def test_a_preview_error_drops_a_decider_of_the_wrong_type(by):
    error = PreviewError("render_failed", why="no_result", by=by, exit_code=1)
    assert (error.outcome, error.diagnostics()) == ("render_failed", {"why": "no_result", "exit": 1})


@pytest.mark.asyncio
@pytest.mark.parametrize("diagnostics", [{"by": []}, {"by": {}, "why": [], "exit": {}}, {"by": "mesh"}])
async def test_malformed_diagnostics_never_change_a_successful_render(tmp_path, monkeypatch, diagnostics):
    """The real chain: a service reply that carries diagnostics of a wrong type is still the ok it says, published
    with its picture — diagnostics decide nothing, not even by failing to parse."""
    import trimesh

    from backend.app.services.preview_protocol import decode
    from backend.app.services.preview_runtime import PreviewRuntime

    runtime = PreviewRuntime(tmp_path / "preview")
    await runtime.start()
    original = runtime._rpc

    async def rpc(command, operation=None, **kwargs):
        reply = await original(command, operation, **kwargs)
        if (operation or command.operation) == "run":
            reply = decode(json.dumps({**reply, **diagnostics}).encode())
        return reply

    monkeypatch.setattr(runtime, "_rpc", rpc)
    try:
        async with runtime.attempt({"mesh": (trimesh.creation.box().export(file_type="stl"), "stl")}) as result:
            assert result.outcome == "ok" and result.files["preview"].is_file()
            assert result.by == diagnostics.get("by") if diagnostics.get("by") == "mesh" else result.by is None
    finally:
        await runtime.stop()


@pytest.mark.requires_cad
@pytest.mark.asyncio
async def test_the_parent_log_names_stage_reason_source_and_exit_code(tmp_path, caplog):
    """The real chain: a STEP the converter refuses ends with one parent line naming all four, and no path."""
    from backend.app.services.preview_runtime import PreviewRuntime
    from backend.tests.cad_lane import cad_app_dir

    external = ROOT / "backend" / "tests" / "fixtures" / "step" / "authored" / "external_only.step"
    caplog.set_level(logging.INFO, logger="backend.app.services.preview_runtime")
    runtime = PreviewRuntime(tmp_path / "preview", app_dir=cad_app_dir())
    await runtime.start()
    try:
        async with runtime.attempt({"mesh": (external, "step")}) as result:
            assert (result.outcome, result.stage, result.why, result.by, result.exit_code) == (
                "render_failed",
                "transfer",
                "external_reference",
                "convert",
                1,
            )
            attempt_id = result.attempt_id
    finally:
        await runtime.stop()
    assert (
        f"Preview attempt={attempt_id} kind=step outcome=render_failed stage=transfer why=external_reference "
        "by=convert exit=1 " in caplog.text
    )
    assert str(external) not in caplog.text and str(tmp_path) not in caplog.text


@pytest.mark.parametrize("kind", ["step", "stl"])
def test_the_step_probe_report_names_a_failure_too(kind):
    """What the CI smoke prints on a failed render: the same closed fields, so a red run says why."""
    from backend.app import step_render_probe

    failed = SimpleNamespace(
        outcome="render_failed", files={}, stage="png", why="no_picture", by="cad_png", exit_code=0
    )
    report = step_render_probe.summary(failed, kind)
    assert report == {
        "outcome": "render_failed",
        "png": False,
        **({"stage": "png"} if kind == "step" else {}),
        "why": "no_picture",
        "by": "cad_png",
        "exit": 0,
    }
