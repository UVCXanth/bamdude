"""The parent side of ``render_runtime provision`` -- one runner for every caller, one parent log.

Implementation consilium 2026-10-13: NL-I-R1 (``str(OSError)`` quotes a Windows path with doubled backslashes, so a
plain replace left the install path in the log) and NL-I-M1 (``communicate()`` buffered all of stderr and the last
line was unbounded). The children below are REAL processes: an installed tree in ``tmp_path`` holding a copy of the
stdlib-only ``render_runtime`` module -- the same shape the Docker build provisions from -- or a stand-in module
that floods stderr or hangs.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
import sys
import tarfile
import time
import zipfile
from pathlib import Path, PureWindowsPath

import psutil
import pytest

from backend.app.services import render_runtime, render_runtime_child
from backend.app.services.render_runtime_child import REASON_CHARS, redact, run_provision

LOGGER = render_runtime_child.logger.name


def _tree(app_dir: Path, module: str) -> Path:
    """An installed tree whose ``backend.app.services.render_runtime`` is ``module`` (source text)."""
    services = app_dir / "backend" / "app" / "services"
    services.mkdir(parents=True)
    for package in (app_dir / "backend", app_dir / "backend" / "app", services):
        (package / "__init__.py").write_text("", encoding="utf-8")
    (services / "render_runtime.py").write_text(module, encoding="utf-8")
    return app_dir


def _node_archive(tmp_path: Path, key: str) -> Path:
    """An official-shaped archive for ``key``: ``node-v99.0.0-<key>/`` with the executable and the licence."""
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
            info.size = len(data)
            info.mode = 0o755
            tf.addfile(info, io.BytesIO(data))
    return path


def _real_install(tmp_path: Path, *, good: bool) -> tuple[Path, str]:
    """The real CLI in an installed tree, its manifest pinning a local archive (``file://``)."""
    key = render_runtime.platform_key()
    app_dir = _tree(tmp_path / "install", Path(render_runtime.__file__).read_text(encoding="utf-8"))
    archive = _node_archive(tmp_path, key)
    sha = hashlib.sha256(archive.read_bytes()).hexdigest() if good else "0" * 64
    manifest = {
        "lines": {"99": {"version": "v99.0.0"}},
        "platforms": {key: {"line": "99", "url": archive.as_uri(), "sha256": sha, "bytes": archive.stat().st_size}},
    }
    data = app_dir / "backend" / "app" / "data"
    data.mkdir()
    (data / "render_runtime.json").write_text(json.dumps(manifest), encoding="utf-8")
    return app_dir, key


# A stand-in CLI that writes its pid, floods stderr past any pipe buffer, then exits or hangs.
_NOISY = """
import os, sys, time
open(os.path.join(os.getcwd(), "child.pid"), "w").write(str(os.getpid()))
for _ in range({blocks}):
    sys.stderr.write("x" * 65536)
sys.stderr.write("\\n{last}\\n")
sys.stderr.flush()
if {hang}:
    time.sleep(600)
sys.exit({code})
"""


def _noisy(
    tmp_path: Path, *, blocks: int = 64, last: str = "render-runtime: the last word", hang: bool = False, code: int = 1
) -> Path:
    return _tree(tmp_path / "install", _NOISY.format(blocks=blocks, last=last, hang=hang, code=code))


def _child_is_gone(app_dir: Path) -> bool:
    pid = int((app_dir / "child.pid").read_text(encoding="utf-8"))
    try:
        return psutil.Process(pid).status() == psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return True


# --- redact: one sanitizer for every caller (NL-I-R1) ---------------------------------------------------------------


def test_a_real_oserror_on_this_machine_loses_the_install_path(tmp_path):
    # str(OSError) quotes the filename with repr(): on Windows every backslash is doubled
    line = "render-runtime: " + str(PermissionError(13, "Permission denied", str(tmp_path / "runtime" / "node")))
    said = redact(line, tmp_path)
    assert tmp_path.name not in said
    assert "Permission denied" in said and "<install>" in said


@pytest.mark.parametrize(
    "spell",
    [
        str,  # a plain message: "kept at C:\\Users\\op\\bamdude\\runtime\\node\\.win-x64.old"
        lambda p: repr(str(p))[1:-1],  # str(OSError): doubled backslashes
        lambda p: p.as_posix(),  # forward slashes
        lambda p: str(p).upper(),  # Windows paths are case-insensitive
    ],
)
def test_every_spelling_of_a_windows_install_path_is_redacted(spell):
    app_dir = PureWindowsPath("C:/Users/op/bamdude")
    line = f"render-runtime: win-x64: kept at {spell(app_dir / 'runtime' / 'node' / '.win-x64.old')}"
    said = redact(line, app_dir)
    assert "USERS" not in said.upper() and "BAMDUDE" not in said.upper()
    assert said.startswith("render-runtime: win-x64: kept at <install>")


def test_a_rename_error_names_both_paths_and_both_are_redacted():
    app_dir = PureWindowsPath("D:/BamDude")
    exc = PermissionError(5, "Access is denied", str(app_dir / "runtime" / "a"), None, str(app_dir / "runtime" / "b"))
    said = redact(f"render-runtime: the new runtime could not be put in place ({exc})", app_dir)
    assert "BamDude" not in said and said.count("<install>") == 2


def test_a_path_under_the_users_home_loses_the_home(tmp_path):
    # an interpreter or a venv outside the install (a dev checkout, pyenv) names the user's home -- and so the user
    home = Path.home()
    line = "render-runtime: " + str(FileNotFoundError(2, "No such file", str(home / ".pyenv" / "python")))
    said = redact(line, tmp_path / "elsewhere")
    assert str(home) not in said and repr(str(home))[1:-1] not in said
    assert "No such file" in said and "~" in said


def test_a_root_directory_is_never_taken_for_the_install_or_the_home(monkeypatch):
    # a service user whose home is "/" must not turn every separator of the reason into "~"
    monkeypatch.setattr(render_runtime_child.Path, "home", classmethod(lambda cls: Path("/")))
    said = redact("render-runtime: /srv/x/y: a reason", PureWindowsPath("C:/BamDude"))
    assert said == "render-runtime: /srv/x/y: a reason"


def test_control_characters_and_length_are_bounded():
    said = redact("render-runtime: \x1b[31mred\x1b[0m " + "y" * 10_000, PureWindowsPath("C:/x"))
    assert "\x1b" not in said
    assert len(said) <= REASON_CHARS


# --- the runner, with real children (NL-I-M1, the parent-log invariant) ---------------------------------------------


@pytest.mark.asyncio
async def test_a_child_that_floods_stderr_is_drained_and_its_reason_is_bounded(tmp_path, caplog):
    app_dir = _noisy(tmp_path, blocks=64)  # 4 MiB: a parent that does not drain would deadlock the child
    with caplog.at_level(logging.INFO, logger=LOGGER):
        run = await asyncio.wait_for(run_provision(app_dir, trigger="test"), 60)
    assert run.outcome == "failed"
    assert run.reason == "render-runtime: the last word"
    assert _child_is_gone(app_dir)
    assert len(caplog.text) < 4096


@pytest.mark.asyncio
async def test_a_single_megabyte_line_never_reaches_the_log_whole(tmp_path, caplog):
    app_dir = _noisy(tmp_path, blocks=16, last="")  # 1 MiB with no line break before the end
    with caplog.at_level(logging.INFO, logger=LOGGER):
        run = await asyncio.wait_for(run_provision(app_dir, trigger="test"), 60)
    assert run.outcome == "failed"
    assert len(run.reason) <= REASON_CHARS
    assert len(caplog.text) < 4096


@pytest.mark.asyncio
async def test_a_child_past_its_budget_is_killed_and_the_log_says_so(tmp_path, caplog):
    app_dir = _noisy(tmp_path, blocks=8, hang=True)
    with caplog.at_level(logging.INFO, logger=LOGGER):
        run = await asyncio.wait_for(run_provision(app_dir, trigger="test", timeout=3), 60)
    assert run.outcome == "timed_out"
    assert _child_is_gone(app_dir)
    assert "timed out after" in caplog.text


@pytest.mark.asyncio
async def test_a_cancelled_run_takes_its_child_with_it(tmp_path, caplog):
    app_dir = _noisy(tmp_path, blocks=8, hang=True)
    with caplog.at_level(logging.INFO, logger=LOGGER):
        task = asyncio.create_task(run_provision(app_dir, trigger="test"))
        for _ in range(600):
            if (app_dir / "child.pid").is_file():
                break
            await asyncio.sleep(0.05)
        await asyncio.sleep(0.5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 30)
    assert _child_is_gone(app_dir)
    assert "cancelled after" in caplog.text


@pytest.mark.asyncio
async def test_a_child_that_cannot_start_is_logged_with_its_time_and_no_path(tmp_path, monkeypatch, caplog):
    def refuse(app_dir):
        raise FileNotFoundError(2, "No such file or directory", str(tmp_path / "venv" / "python"))

    monkeypatch.setattr(render_runtime_child, "_spawn", refuse)
    with caplog.at_level(logging.INFO, logger=LOGGER):
        run = await run_provision(tmp_path, trigger="test")
    assert run.outcome == "not_started"
    assert "did not start after" in caplog.text and "FileNotFoundError" in caplog.text
    assert tmp_path.name not in caplog.text


@pytest.mark.asyncio
async def test_no_official_build_is_an_outcome_of_its_own_with_its_time(tmp_path, caplog):
    app_dir = _noisy(tmp_path, blocks=0, last="render-runtime: no official Node.js build for linux/armv6l", code=3)
    with caplog.at_level(logging.INFO, logger=LOGGER):
        run = await asyncio.wait_for(run_provision(app_dir, trigger="test"), 60)
    assert run.outcome == "no_build"
    assert "no official Node.js build" in caplog.text and " after " in caplog.text


@pytest.mark.asyncio
async def test_the_real_cli_provisions_node_and_the_parent_log_shows_start_and_outcome(tmp_path, caplog):
    app_dir, key = _real_install(tmp_path, good=True)
    with caplog.at_level(logging.INFO, logger=LOGGER):
        run = await asyncio.wait_for(run_provision(app_dir, trigger="test"), 120)
    assert run.outcome == "provisioned", run
    found = render_runtime.locate_in(app_dir / "runtime", key)
    assert found is not None and found.version == "v99.0.0"
    started = [r for r in caplog.records if "started (test)" in r.getMessage()]
    ended = [r for r in caplog.records if "provisioned in" in r.getMessage()]
    assert len(started) == 1 and len(ended) == 1
    run_id = started[0].getMessage().split()[3]
    assert run_id in ended[0].getMessage()


@pytest.mark.asyncio
async def test_the_real_cli_refusing_a_bad_archive_is_a_readable_failure_without_the_path(tmp_path, caplog):
    app_dir, _ = _real_install(tmp_path, good=False)
    with caplog.at_level(logging.INFO, logger=LOGGER):
        run = await asyncio.wait_for(run_provision(app_dir, trigger="test"), 120)
    assert run.outcome == "failed"
    assert "sha256 or size does not match the manifest" in run.reason
    assert "failed after" in caplog.text
    assert str(app_dir) not in caplog.text and app_dir.as_posix() not in caplog.text


def test_the_parent_keeps_only_the_tail_of_a_flood():
    stream = io.BytesIO(b"y" * (4 * 1024 * 1024) + b"\nrender-runtime: the end\n")
    tail, truncated = render_runtime_child._drain(stream)
    assert len(tail) <= render_runtime_child.STDERR_TAIL and truncated
    assert render_runtime_child._last_line(tail, truncated) == "render-runtime: the end"


# --- the loop uvicorn --reload runs the app on (consilium r2 SP2-R1) -------------------------------------------------


def _on_the_reload_loop(main):
    """Run ``main()`` on the loop the installed uvicorn picks for ``--reload --loop asyncio``: on Windows a
    SelectorEventLoop, which has no subprocess transport -- the documented dev start of a checkout."""
    from uvicorn.config import Config
    from uvicorn.loops.asyncio import asyncio_loop_factory

    config = Config("backend.app.main:app", reload=True, loop="asyncio")
    with asyncio.Runner(loop_factory=asyncio_loop_factory(use_subprocess=config.use_subprocess)) as runner:
        return runner.run(main())


def _is_the_reload_loop() -> None:
    if sys.platform == "win32":
        assert isinstance(asyncio.get_running_loop(), asyncio.SelectorEventLoop)


def test_on_the_reload_loop_the_real_cli_provisions(tmp_path, caplog):
    app_dir, key = _real_install(tmp_path, good=True)

    async def main():
        _is_the_reload_loop()
        return await asyncio.wait_for(run_provision(app_dir, trigger="test"), 120)

    with caplog.at_level(logging.INFO, logger=LOGGER):
        run = _on_the_reload_loop(main)
    assert run.outcome == "provisioned", run
    assert render_runtime.locate_in(app_dir / "runtime", key) is not None
    assert "provisioned in" in caplog.text


def test_on_the_reload_loop_a_failure_is_reported_with_its_reason(tmp_path):
    app_dir = _noisy(tmp_path, blocks=64)

    async def main():
        _is_the_reload_loop()
        return await asyncio.wait_for(run_provision(app_dir, trigger="test"), 60)

    run = _on_the_reload_loop(main)
    assert run.outcome == "failed" and run.reason == "render-runtime: the last word"
    assert _child_is_gone(app_dir)


def test_on_the_reload_loop_a_child_past_its_budget_is_killed(tmp_path, caplog):
    app_dir = _noisy(tmp_path, blocks=8, hang=True)

    async def main():
        _is_the_reload_loop()
        return await asyncio.wait_for(run_provision(app_dir, trigger="test", timeout=3), 60)

    with caplog.at_level(logging.INFO, logger=LOGGER):
        run = _on_the_reload_loop(main)
    assert run.outcome == "timed_out"
    assert _child_is_gone(app_dir)
    assert "timed out after" in caplog.text and "was stopped" in caplog.text


def test_on_the_reload_loop_a_cancelled_run_takes_its_child_with_it(tmp_path, caplog):
    app_dir = _noisy(tmp_path, blocks=8, hang=True)

    async def main():
        _is_the_reload_loop()
        task = asyncio.create_task(run_provision(app_dir, trigger="test"))
        for _ in range(600):
            if (app_dir / "child.pid").is_file():
                break
            await asyncio.sleep(0.05)
        await asyncio.sleep(0.5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 30)

    with caplog.at_level(logging.INFO, logger=LOGGER):
        _on_the_reload_loop(main)
    assert _child_is_gone(app_dir)
    assert "cancelled after" in caplog.text and "was stopped" in caplog.text


@pytest.mark.asyncio
async def test_a_run_cancelled_while_its_child_is_starting_still_ends_that_child(tmp_path, monkeypatch, caplog):
    # the watcher owns the child from the spawn on: a cancel that lands before the spawn returns still ends it
    app_dir = _noisy(tmp_path, blocks=0, hang=True)
    spawn = render_runtime_child._spawn
    entered = asyncio.Event()
    spawned = []
    loop = asyncio.get_running_loop()

    def slow_spawn(app):
        loop.call_soon_threadsafe(entered.set)
        time.sleep(1.0)
        spawned.append(spawn(app))
        return spawned[-1]

    monkeypatch.setattr(render_runtime_child, "_spawn", slow_spawn)
    with caplog.at_level(logging.INFO, logger=LOGGER):
        task = asyncio.create_task(run_provision(app_dir, trigger="test"))
        await asyncio.wait_for(entered.wait(), 10)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 30)
    assert len(spawned) == 1  # it did start, after the cancel
    assert spawned[0].poll() is not None and not psutil.pid_exists(spawned[0].pid)
    assert "cancelled after" in caplog.text and "was stopped" in caplog.text
