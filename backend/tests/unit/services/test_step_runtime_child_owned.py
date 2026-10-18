"""The app's owned run of the CAD helper (spec stage C R6; plan Task 3, consilium C-R1 and C2-M2): every run keeps
its own records; a run whose end is not proven keeps them and refuses the next; a stop before the spawn starts
nothing and one after it ends the whole tree with its proof; a cancellation — before the run, inside the spawn,
after the grandchild appeared, twice — returns only once the tree is proven over."""

from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import psutil
import pytest

from backend.app.services import part_render_tree as tree, step_runtime_child as child

ROOT = Path(__file__).resolve().parents[4]
SLEEPY = ROOT / "backend" / "tests" / "fixtures" / "windows_build" / "sleepy_helper.py"


@pytest.fixture
def tmp_path(install_tmp_path):
    return install_tmp_path


def _script(tmp_path: Path, name: str, body: str) -> list[str]:
    path = tmp_path / f"{name}.py"
    path.write_text(body, encoding="utf-8")
    return [sys.executable, str(path)]


def _alive(pid: int) -> bool:
    try:
        return psutil.Process(pid).status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False


def _gone_within(pid: int, seconds: float) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not _alive(pid):
            return True
        time.sleep(0.05)
    return not _alive(pid)


async def _marker_pid(marker: Path, seconds: float = 30.0) -> int:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if marker.exists() and marker.read_text(encoding="ascii").strip():
            return int(marker.read_text(encoding="ascii"))
        await asyncio.sleep(0.05)
    raise AssertionError("the grandchild never appeared")


def _snapshot(directory: Path) -> dict[str, bytes]:
    return {p.name: p.read_bytes() for p in sorted(directory.iterdir()) if p.is_file()}


# --- run_tree's stop -------------------------------------------------------------------------------------------


def test_a_stop_before_the_spawn_starts_nothing(tmp_path):
    records = tmp_path / "records"
    records.mkdir()
    stop = threading.Event()
    stop.set()
    with pytest.raises(child.TreeStopped) as stopped:
        child.run_tree(_script(tmp_path, "ok", "pass\n"), timeout=30, records=records, stop=stop)
    assert stopped.value.started is False
    assert list(records.iterdir()) == []  # not even a launch record


def test_a_stop_ends_the_whole_tree_with_proof(tmp_path):
    marker = tmp_path / "grandchild.pid"
    stop = threading.Event()
    threading.Timer(2.0, stop.set).start()
    with pytest.raises(child.TreeStopped) as stopped:
        child.run_tree([sys.executable, str(SLEEPY), str(marker)], timeout=60, stop=stop)
    assert stopped.value.started is True
    assert _gone_within(int(marker.read_text(encoding="ascii")), 10)


# --- run_owned -------------------------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_outcomes_are_told_apart(tmp_path, caplog):
    root = tmp_path / ".owner"
    ok = await child.run_owned(_script(tmp_path, "ok", "print('done')\n"), owner_root=root, timeout=60, label="t")
    failed = await child.run_owned(
        _script(tmp_path, "bad", "raise SystemExit(1)\n"), owner_root=root, timeout=60, label="t"
    )
    slow = await child.run_owned(
        _script(tmp_path, "slow", "import time; time.sleep(30)\n"), owner_root=root, timeout=1, label="t"
    )
    assert (ok.outcome, ok.returncode) == ("ok", 0) and "done" in ok.stdout_tail
    assert (failed.outcome, failed.returncode) == ("failed", 1)
    assert slow.outcome == "timeout"
    assert not root.exists() or list(root.iterdir()) == []  # every proven run took its own records


@pytest.mark.asyncio
async def test_an_unproven_run_keeps_its_records_and_refuses_the_next(tmp_path, monkeypatch):
    root = tmp_path / ".owner"
    monkeypatch.setattr(child, "_tree_gone", lambda owner, timeout: False)
    first = await child.run_owned(_script(tmp_path, "ok", "pass\n"), owner_root=root, timeout=60, label="t")
    assert first.outcome == "unproven"
    (kept,) = list(root.iterdir())
    before = _snapshot(kept)
    assert child_owner_record(kept) in before

    def refuse(*args, **kwargs):
        raise AssertionError("no replacement while an earlier tree may live")

    monkeypatch.setattr(child, "run_tree", refuse)
    second = await child.run_owned(_script(tmp_path, "ok", "pass\n"), owner_root=root, timeout=60, label="t")
    assert second.outcome == "helper_unproven"
    assert list(root.iterdir()) == [kept] and _snapshot(kept) == before


def child_owner_record(directory: Path) -> str:
    from backend.app import step_runtime

    assert directory.is_dir()
    return step_runtime.OWNER_RECORD


@pytest.mark.asyncio
async def test_a_launch_without_its_owner_record_is_no_proof(tmp_path):
    root = tmp_path / ".owner"
    earlier = root / "earlier"
    earlier.mkdir(parents=True)
    tree.launch(earlier, "installer")
    answer = await child.run_owned(_script(tmp_path, "ok", "pass\n"), owner_root=root, timeout=60, label="t")
    assert answer.outcome == "helper_unproven" and earlier.exists()


@pytest.mark.asyncio
async def test_a_dead_owner_with_no_holder_of_its_token_is_judged_over(tmp_path):
    from backend.app import step_runtime

    root = tmp_path / ".owner"
    earlier = root / "earlier"
    earlier.mkdir(parents=True)
    short = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        tree.record(earlier / step_runtime.OWNER_RECORD, short.pid)
        tree.launch(earlier, "installer")
    finally:
        short.kill()
        short.wait(timeout=30)
    answer = await child.run_owned(_script(tmp_path, "ok", "pass\n"), owner_root=root, timeout=60, label="t")
    assert answer.outcome == "ok" and not earlier.exists()


@pytest.mark.asyncio
async def test_two_runs_in_one_process_do_not_share_records(tmp_path, monkeypatch):
    root = tmp_path / ".owner"
    seen, active = [], []
    real = child.run_tree

    def watched(cmd, **kwargs):
        assert active == [], "two owned runs overlapped"
        active.append(kwargs["records"])
        seen.append(kwargs["records"])
        try:
            return real(cmd, **kwargs)
        finally:
            active.pop()

    monkeypatch.setattr(child, "run_tree", watched)
    cmd = _script(tmp_path, "nap", "import time; time.sleep(1)\n")
    first, second = await asyncio.gather(
        child.run_owned(cmd, owner_root=root, timeout=60, label="t"),
        child.run_owned(cmd, owner_root=root, timeout=60, label="t"),
    )
    assert first.outcome == second.outcome == "ok"
    assert len(seen) == 2 and seen[0] != seen[1] and seen[0].parent == seen[1].parent == root


@pytest.mark.asyncio
async def test_a_cancel_before_run_owned_starts_creates_nothing(tmp_path, monkeypatch):
    root = tmp_path / ".owner"
    monkeypatch.setattr(child, "run_tree", lambda *a, **k: pytest.fail("nothing may run"))
    task = asyncio.ensure_future(
        child.run_owned(_script(tmp_path, "ok", "pass\n"), owner_root=root, timeout=60, label="t")
    )
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert not root.exists() or list(root.iterdir()) == []


@pytest.mark.asyncio
async def test_a_cancel_inside_the_spawn_waits_for_the_proof(tmp_path, monkeypatch):
    root = tmp_path / ".owner"
    entered, release = threading.Event(), threading.Event()
    spawned = []
    real_popen = child.subprocess.Popen

    def barrier_popen(*args, **kwargs):
        entered.set()
        assert release.wait(60)
        process = real_popen(*args, **kwargs)
        spawned.append(process.pid)
        return process

    monkeypatch.setattr(child.subprocess, "Popen", barrier_popen)
    marker = tmp_path / "grandchild.pid"
    task = asyncio.ensure_future(
        child.run_owned([sys.executable, str(SLEEPY), str(marker)], owner_root=root, timeout=60, label="t")
    )
    assert await asyncio.to_thread(entered.wait, 30)
    task.cancel()
    await asyncio.sleep(0.2)
    assert not task.done()  # held by the spawn, not abandoned to it
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert spawned and not _alive(spawned[0])  # the bootstrap was never released and is proven over
    assert not marker.exists()  # the command never ran
    assert list(root.iterdir()) == []


@pytest.mark.asyncio
@pytest.mark.parametrize("cancels", [1, 2])
async def test_a_cancel_after_the_grandchild_appears_waits_for_the_tree(tmp_path, cancels):
    root = tmp_path / ".owner"
    marker = tmp_path / "grandchild.pid"
    task = asyncio.ensure_future(
        child.run_owned([sys.executable, str(SLEEPY), str(marker)], owner_root=root, timeout=120, label="t")
    )
    grandchild = await _marker_pid(marker)
    for _ in range(cancels):
        task.cancel()
        await asyncio.sleep(0)  # the second lands while the first is ending the tree
    with pytest.raises(asyncio.CancelledError):
        await task
    assert not _alive(grandchild)  # gone when the cancellation came back, not some time later
    assert list(root.iterdir()) == []


@pytest.mark.skipif(os.name != "nt", reason="named skip: the Selector loop matters only on Windows")
def test_the_owned_run_works_on_a_selector_loop(tmp_path):
    loop = asyncio.SelectorEventLoop()
    try:
        answer = loop.run_until_complete(
            child.run_owned(_script(tmp_path, "ok", "pass\n"), owner_root=tmp_path / ".owner", timeout=60, label="t")
        )
    finally:
        loop.close()
    assert answer.outcome == "ok"


@pytest.mark.asyncio
async def test_the_owned_run_logs_its_start_end_and_time_without_paths(tmp_path, caplog):
    caplog.set_level(logging.INFO, logger=child.__name__)
    await child.run_owned(
        _script(tmp_path, "ok", "pass\n"), owner_root=tmp_path / ".owner", timeout=60, label="CAD update"
    )
    lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith("CAD update")]
    assert len(lines) == 2, lines
    run_ids = {part for line in lines for part in line.split() if part.startswith("run=")}
    assert len(run_ids) == 1 and "elapsed_ms=" in lines[1] and "outcome=ok" in lines[1]
    assert not any(str(tmp_path) in line for line in lines)
