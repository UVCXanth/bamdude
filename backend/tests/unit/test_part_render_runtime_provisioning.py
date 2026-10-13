"""A native install without its pinned Node installs it at start, once (part-render-startup-provisioning-spec).

The children are REAL processes started by the shared runner: an installed tree in ``tmp_path`` whose
``render_runtime`` is a stand-in that records how it was started, then waits, fails or hangs -- or the real
stdlib-only module with a manifest on a local archive.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
import sys
import tarfile
import threading
import time
import zipfile
from pathlib import Path

import psutil
import pytest

from backend.app.services import part_render_runtime, part_render_scheduler, render_runtime, render_runtime_child
from backend.app.services.part_render_runtime import PartRenderRuntime

PROVISION = ["-m", "backend.app.services.render_runtime", "provision", "--runtime"]

# Records itself, then waits for a "go" file (or forever), says one line on stderr and exits.
_STAND_IN = """
import json, os, sys, time
here = os.getcwd()
with open(os.path.join(here, "children.jsonl"), "a") as out:
    out.write(json.dumps({{"argv": sys.orig_argv[1:], "cwd": here, "pid": os.getpid()}}) + "\\n")
while {wait} and not os.path.exists(os.path.join(here, "go")):
    time.sleep(0.05)
sys.stderr.write({said!r} + "\\n")
sys.exit({code})
"""


def _tree(app_dir: Path, module: str) -> Path:
    services = app_dir / "backend" / "app" / "services"
    services.mkdir(parents=True)
    for package in (app_dir / "backend", app_dir / "backend" / "app", services):
        (package / "__init__.py").write_text("", encoding="utf-8")
    (services / "render_runtime.py").write_text(module, encoding="utf-8")
    return app_dir


def _stand_in(tmp_path: Path, *, code: int = 0, said: str = "render-runtime: done", wait: bool = False) -> Path:
    return _tree(tmp_path / "install", _STAND_IN.format(code=code, said=said, wait=wait))


def _children(app_dir: Path) -> list[dict]:
    path = app_dir / "children.jsonl"
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()] if path.is_file() else []


def _gone(pid: int) -> bool:
    try:
        return psutil.Process(pid).status() == psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return True


async def _until(predicate, deadline: float = 30.0) -> None:
    end = time.monotonic() + deadline
    while not predicate():
        assert time.monotonic() < end, "timed out waiting"
        await asyncio.sleep(0.05)


def _runtime(app_dir: Path, monkeypatch, kind: str = "native") -> PartRenderRuntime:
    monkeypatch.setattr(part_render_runtime.install_kind, "kind", lambda _: kind)
    runtime = PartRenderRuntime(app_dir.parent / "data", None, app_dir=app_dir)
    runtime.node_reason = "runtime_missing"
    return runtime


@pytest.mark.asyncio
async def test_a_native_install_without_node_provisions_it_once(tmp_path, monkeypatch):
    app_dir = _stand_in(tmp_path, wait=True)
    runtime = _runtime(app_dir, monkeypatch)
    runtime.start_provisioning()
    assert runtime.node_reason == "runtime_provisioning"
    await _until(lambda: _children(app_dir))
    child = _children(app_dir)[0]
    assert child["argv"] == [*PROVISION, str(app_dir / "runtime")]
    assert Path(child["cwd"]).samefile(app_dir)
    task = runtime.provisioning
    runtime.start_provisioning()  # once per process
    assert runtime.provisioning is task
    (app_dir / "go").touch()
    await asyncio.wait_for(task, 60)
    runtime.start_provisioning()
    assert runtime.provisioning is task and len(_children(app_dir)) == 1


@pytest.mark.parametrize(
    ("kind", "reason"),
    [
        ("docker", "runtime_missing"),
        ("windows_installer", "runtime_missing"),
        ("native", "no_runtime"),
        ("native", None),
    ],
)
def test_nothing_is_provisioned_where_it_does_not_belong(tmp_path, monkeypatch, kind, reason):
    async def never(*args, **kwargs):
        raise AssertionError("the runner must not be called")

    monkeypatch.setattr(part_render_runtime.render_runtime_child, "run_provision", never)
    runtime = _runtime(tmp_path / "install", monkeypatch, kind=kind)
    runtime.node_reason = reason
    runtime.start_provisioning()
    assert runtime.provisioning is None and runtime.node_reason == reason


@pytest.mark.asyncio
async def test_the_monitor_does_not_overwrite_the_provisioning_state(tmp_path, monkeypatch):
    app_dir = _stand_in(tmp_path, wait=True)
    runtime = _runtime(app_dir, monkeypatch)
    runtime.start_provisioning()
    await _until(lambda: _children(app_dir))
    runtime.resolve_node()  # what the monitor does every 30 s; nothing is installed yet
    assert runtime.node_reason == "runtime_provisioning"
    (app_dir / "go").touch()
    await asyncio.wait_for(runtime.provisioning, 60)
    assert runtime.node_reason == "runtime_missing"  # the stand-in installed nothing: the monitor will say so
    assert runtime.node_refresh_at == 0.0  # it said "provisioned": the monitor looks on its next tick


@pytest.mark.asyncio
async def test_a_failed_provisioning_is_logged_without_the_install_path(tmp_path, monkeypatch, caplog):
    # a real OSError as the CLI prints it: repr() doubles every Windows backslash (consilium NL-I-R1)
    exc = PermissionError(13, "Permission denied", str(tmp_path / "install" / "runtime" / "node"))
    app_dir = _stand_in(tmp_path, code=1, said=f"render-runtime: {exc}")
    runtime = _runtime(app_dir, monkeypatch)
    with caplog.at_level(logging.INFO):
        runtime.start_provisioning()
        await asyncio.wait_for(runtime.provisioning, 60)
    assert runtime.node_reason == "runtime_missing"
    assert "started (startup)" in caplog.text
    assert "failed after" in caplog.text and "Permission denied" in caplog.text and "<install>" in caplog.text
    assert tmp_path.name not in caplog.text
    runtime.start_provisioning()  # no retry in this process (spec P5)
    assert len(_children(app_dir)) == 1


@pytest.mark.asyncio
async def test_a_provisioning_that_outlives_its_budget_is_killed(tmp_path, monkeypatch, caplog):
    monkeypatch.setattr(render_runtime_child, "PROVISION_SECONDS", 3.0)
    app_dir = _stand_in(tmp_path, wait=True)  # never told to go
    runtime = _runtime(app_dir, monkeypatch)
    with caplog.at_level(logging.INFO):
        runtime.start_provisioning()
        await asyncio.wait_for(runtime.provisioning, 60)
    assert _gone(_children(app_dir)[0]["pid"])
    assert "timed out after" in caplog.text
    assert runtime.node_reason == "runtime_missing"


@pytest.mark.asyncio
async def test_stop_takes_the_provisioning_child_with_it(tmp_path, monkeypatch, caplog):
    # spec P8 through the REAL stop(), not cancel_provisioning alone (consilium r1)
    app_dir = _stand_in(tmp_path, wait=True)
    runtime = _runtime(app_dir, monkeypatch)
    with caplog.at_level(logging.INFO):
        runtime.start_provisioning()
        await _until(lambda: _children(app_dir))
        await asyncio.wait_for(runtime.stop(), 60)
    assert runtime.provisioning.done()
    assert _gone(_children(app_dir)[0]["pid"])
    assert "cancelled after" in caplog.text


@pytest.mark.asyncio
async def test_stop_waits_for_a_provisioning_whose_spawn_is_slower_than_the_kill_wait(tmp_path, monkeypatch, caplog):
    # consilium r3 SP3-R1 through the REAL stop(): it does not return while the child its spawn holds is alive.
    # KILL_WAIT is made short so the test does not sit out the real one; the order is what is proven.
    monkeypatch.setattr(render_runtime_child, "KILL_WAIT", 0.5)
    app_dir = _stand_in(tmp_path, wait=True)
    runtime = _runtime(app_dir, monkeypatch)
    spawn = render_runtime_child._spawn
    loop = asyncio.get_running_loop()
    entered, gate, spawned = asyncio.Event(), threading.Event(), []

    def gated(app):
        process = spawn(app)
        spawned.append(process)
        loop.call_soon_threadsafe(entered.set)
        if not gate.wait(30):
            process.kill()
        return process

    monkeypatch.setattr(render_runtime_child, "_spawn", gated)
    with caplog.at_level(logging.INFO):
        runtime.start_provisioning()
        await asyncio.wait_for(entered.wait(), 10)
        stopping = asyncio.create_task(runtime.stop())
        try:
            await asyncio.sleep(render_runtime_child.KILL_WAIT * 3)
            assert spawned[0].poll() is None  # the child lives, its spawn not yet returned
            assert not stopping.done(), "stop() returned while the provisioning child lived"
        finally:
            gate.set()
        await asyncio.wait_for(stopping, 60)
    assert spawned[0].poll() is not None and runtime.provisioning.done()
    assert len([line for line in caplog.messages if "cancelled after" in line]) == 1


@pytest.mark.asyncio
async def test_the_process_start_provisions_a_native_install_without_node(tmp_path, monkeypatch):
    # the lifespan's door is where the process starts (spec P1, P5) -- a runtime a test builds starts nothing
    app_dir = _stand_in(tmp_path, wait=True)
    runtime = _runtime(app_dir, monkeypatch)

    async def started(base, app):
        await runtime.start()
        return runtime

    class Scheduler:
        def __init__(self, *args):
            pass

        def start_in_background(self):
            pass

    monkeypatch.setattr(part_render_scheduler, "start_part_render_runtime", started)
    monkeypatch.setattr(part_render_scheduler, "PartRenderScheduler", Scheduler)
    monkeypatch.setattr(part_render_scheduler, "scheduler", None)
    await part_render_scheduler.start_part_render(tmp_path / "data", app_dir)
    try:
        assert runtime.provisioning is not None
        assert runtime.node_reason == "runtime_provisioning"
        await _until(lambda: _children(app_dir))
    finally:
        await asyncio.wait_for(runtime.stop(), 60)
    assert _gone(_children(app_dir)[0]["pid"])


@pytest.mark.asyncio
async def test_a_runtime_started_on_its_own_provisions_nothing(tmp_path, monkeypatch):
    app_dir = _stand_in(tmp_path, wait=True)
    runtime = _runtime(app_dir, monkeypatch)
    await runtime.start()
    try:
        assert runtime.provisioning is None and runtime.node_reason == "runtime_missing"
    finally:
        await asyncio.wait_for(runtime.stop(), 60)


def _node_archive(tmp_path: Path, key: str) -> Path:
    top = f"node-v99.0.0-{key}"
    if key == "win-x64":
        path = tmp_path / f"{top}.zip"
        with zipfile.ZipFile(path, "w") as zf:
            zf.writestr(f"{top}/node.exe", b"MZ fake node")
            zf.writestr(f"{top}/LICENSE", b"MIT")
        return path
    path = tmp_path / f"{top}.tar.gz"
    with tarfile.open(path, "w:gz") as tf:
        for name, data in ((f"{top}/bin/node", b"#!fake node"), (f"{top}/LICENSE", b"MIT")):
            info = tarfile.TarInfo(name)
            info.size, info.mode = len(data), 0o755
            tf.addfile(info, io.BytesIO(data))
    return path


def _real_tree(tmp_path: Path, *, good: bool) -> Path:
    """The real stdlib-only module in an installed tree, its manifest pinning a local archive (``file://``)."""
    key = render_runtime.platform_key()
    archive = _node_archive(tmp_path, key)
    app_dir = _tree(tmp_path / "install", Path(render_runtime.__file__).read_text(encoding="utf-8"))
    data = archive.read_bytes()
    sha = hashlib.sha256(data).hexdigest() if good else "0" * 64
    entry = {"line": "99", "url": archive.as_uri(), "sha256": sha, "bytes": len(data)}
    manifest = {"lines": {"99": {"version": "v99.0.0"}}, "platforms": {key: entry}}
    (app_dir / "backend" / "app" / "data").mkdir()
    (app_dir / "backend" / "app" / "data" / "render_runtime.json").write_text(json.dumps(manifest), "utf-8")
    return app_dir


@pytest.mark.asyncio
@pytest.mark.parametrize("good", [True, False])
async def test_a_real_cli_provisions_node_and_the_parent_log_shows_it(tmp_path, monkeypatch, caplog, good):
    # the parent-log invariant: a REAL child, its success and its failure visible in the parent's log
    app_dir = _real_tree(tmp_path, good=good)
    runtime = _runtime(app_dir, monkeypatch)
    with caplog.at_level(logging.INFO):
        runtime.start_provisioning()
        await asyncio.wait_for(runtime.provisioning, 120)
    assert "started (startup)" in caplog.text
    if good:
        assert "provisioned in" in caplog.text
        assert render_runtime.locate(app_dir) is not None
        assert runtime.node_refresh_at == 0.0
    else:
        assert "failed after" in caplog.text and "sha256 or size does not match" in caplog.text
        assert runtime.node_reason == "runtime_missing" and render_runtime.locate(app_dir) is None


def test_on_the_reload_loop_a_native_checkout_provisions_at_start(tmp_path, monkeypatch):
    # consilium r2 SP2-R1: a dev checkout runs on the loop uvicorn --reload picks -- a SelectorEventLoop on Windows,
    # with no subprocess transport; the startup path runs the same runner as the update and must work there
    from uvicorn.config import Config
    from uvicorn.loops.asyncio import asyncio_loop_factory

    app_dir = _real_tree(tmp_path, good=True)
    runtime = _runtime(app_dir, monkeypatch)

    async def main():
        if sys.platform == "win32":
            assert isinstance(asyncio.get_running_loop(), asyncio.SelectorEventLoop)
        runtime.start_provisioning()
        await asyncio.wait_for(runtime.provisioning, 120)

    config = Config("backend.app.main:app", reload=True, loop="asyncio")
    with asyncio.Runner(loop_factory=asyncio_loop_factory(use_subprocess=config.use_subprocess)) as runner:
        runner.run(main())
    assert render_runtime.locate(app_dir) is not None
    assert runtime.node_refresh_at == 0.0
