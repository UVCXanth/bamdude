"""The CAD installer keeps the proof of who owns its tree through a crash of its owner (spec §8, Codex A-R1).

Nothing of the installer runs before its owner has it: the bootstrap waits for an explicit "go", and EOF or any
other first line ends it unrun. Before anything is spawned the staging holds the owner's record and the launch's
token, and the bootstrap's own record is durable before it is released — so a crash at any point leaves either
nothing that ran or a record that names it. A later install reclaims a staging only on a positive proof that its
writer is gone: a record that cannot be read, a process that cannot be read and a scan that cannot be completed
all keep it. On POSIX the bootstrap watches its owner's pipe and takes its whole group with it when the owner dies.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import psutil
import pytest

from backend.app import step_runtime as sr
from backend.app.services import part_render_tree as tree, step_runtime_child as child
from backend.app.services.worker_containment import contained_interpreter

POSIX = os.name != "nt"


def _script(tmp_path: Path, body: str, name: str = "target.py") -> Path:
    path = tmp_path / name
    path.write_text(body, encoding="utf-8")
    return path


def _bootstrap(script: Path) -> subprocess.Popen:
    interpreter, env = contained_interpreter(None)
    return subprocess.Popen(
        child._bootstrapped([sys.executable, str(script)], interpreter, "0" * 32),
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=env,
    )


@pytest.mark.parametrize("first_line", [None, b"\n", b"go now\n"], ids=["eof", "empty", "other"])
def test_the_bootstrap_runs_nothing_without_an_explicit_go(tmp_path, first_line):
    marker = tmp_path / "ran"
    process = _bootstrap(_script(tmp_path, f"from pathlib import Path\nPath(r'{marker}').write_text('ran')\n"))
    try:
        if first_line is None:
            process.stdin.close()  # the owner is gone before it ever said go
            assert process.wait(timeout=30) != 0
        else:
            process.stdin.write(first_line)  # the pipe stays open: the gate itself must refuse, not the watch
            process.stdin.flush()
            assert process.wait(timeout=30) == 75
        assert not marker.exists()
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=10)


def test_the_records_are_durable_before_the_target_runs(tmp_path):
    records = tmp_path / "staging"
    records.mkdir()
    seen = tmp_path / "seen.json"
    script = _script(
        tmp_path,
        "import json, sys\nfrom pathlib import Path\n"
        f"r = Path(r'{records}')\n"
        f"Path(r'{seen}').write_text(json.dumps([p.name for p in sorted(r.iterdir())]))\n",
    )
    result = child.run_tree([sys.executable, str(script)], timeout=60, records=records)
    assert result.returncode == 0
    assert json.loads(seen.read_text()) == ["installer.launch", "installer.pid"]
    assert sorted(p.name for p in records.iterdir()) == []  # a proven end takes its records with it


def test_a_record_that_cannot_be_written_releases_nothing(tmp_path, monkeypatch):
    records = tmp_path / "staging"
    records.mkdir()
    marker = tmp_path / "ran"
    script = _script(tmp_path, f"from pathlib import Path\nPath(r'{marker}').write_text('ran')\n")
    real = tree.record

    def refuse(path, pid):
        if path.name == "installer.pid":
            raise PermissionError(13, "denied")
        return real(path, pid)

    monkeypatch.setattr(tree, "record", refuse)
    with pytest.raises(child.RecordUnwritable):
        child.run_tree([sys.executable, str(script)], timeout=60, records=records)
    time.sleep(0.5)
    assert not marker.exists()  # without its record the bootstrap never got its go


# --- reclaim: only a positive proof that the writer is gone ------------------------------------------------------


def _own_record(path: Path, pid: int | None = None, **changes) -> None:
    """A record as ``part_render_tree.record`` writes it — of a live process, or (with a pid and create_time
    that name no process) of one that has ended."""
    if pid is None:
        tree.record(path, os.getpid())
        data = json.loads(path.read_text(encoding="ascii"))
    else:
        data = {"pid": pid, "create_time": 0.0, "boot": tree._boot_id(), "user": tree._identity(psutil.Process())}
    data.update(changes)
    path.write_text(json.dumps(data), encoding="ascii")


def _staging(tmp_path: Path, name: str = "attempt") -> Path:
    path = tmp_path / "own" / name
    path.mkdir(parents=True)
    (path / "partial").write_text("written by an installer", encoding="utf-8")
    return path


def test_a_staging_that_never_launched_is_reclaimed(tmp_path):
    staging = _staging(tmp_path)
    _own_record(staging / "owner.pid", pid=2**22 + 7, create_time=1.0)  # its owner died before any spawn
    sr._reclaim_staging(staging.parent)
    assert not staging.exists()


def test_a_staging_whose_bootstrap_lives_is_kept(tmp_path):
    staging = _staging(tmp_path)
    tree.launch(staging, "installer")
    _own_record(staging / "installer.pid")  # this very process stands in for a live bootstrap
    sr._reclaim_staging(staging.parent)
    assert staging.exists()


def test_a_staging_whose_bootstrap_ended_is_reclaimed(tmp_path):
    staging = _staging(tmp_path)
    tree.launch(staging, "installer")
    _own_record(staging / "installer.pid", pid=2**22 + 7, create_time=1.0)
    sr._reclaim_staging(staging.parent)
    assert not staging.exists()


def test_an_unreadable_record_keeps_its_staging(tmp_path):
    staging = _staging(tmp_path)
    tree.launch(staging, "installer")
    (staging / "installer.pid").write_text("{not json", encoding="ascii")
    sr._reclaim_staging(staging.parent)
    assert staging.exists()


def test_a_bootstrap_that_cannot_be_read_keeps_its_staging(tmp_path, monkeypatch):
    staging = _staging(tmp_path)
    tree.launch(staging, "installer")
    _own_record(staging / "installer.pid", pid=2**22 + 7, create_time=1.0)

    def denied(pid):
        raise psutil.AccessDenied(pid)

    monkeypatch.setattr(psutil, "Process", denied)
    sr._reclaim_staging(staging.parent)
    assert staging.exists()  # access denied is no proof that the writer ended


def test_a_launch_whose_bootstrap_never_got_its_record_is_ended_then_reclaimed(tmp_path):
    staging = _staging(tmp_path)
    token = tree.launch(staging, "installer")
    _own_record(staging / "owner.pid", pid=2**22 + 7, create_time=1.0)  # the owner died before recording it
    holder = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)", tree.launch_arg(token)])
    try:
        deadline = time.monotonic() + 30
        while tree.launch_arg(token) not in (psutil.Process(holder.pid).cmdline() or []):
            assert time.monotonic() < deadline
            time.sleep(0.05)
        sr._reclaim_staging(staging.parent)
        assert holder.wait(timeout=30) is not None  # it never got its go: ended, not trusted to read EOF
        assert not staging.exists()
    finally:
        if holder.poll() is None:
            holder.kill()
            holder.wait(timeout=10)


def test_a_staging_of_another_boot_is_reclaimed(tmp_path):
    if tree._boot_id() is None:
        pytest.skip("named skip: this platform does not say which boot it is")
    staging = _staging(tmp_path)
    tree.launch(staging, "installer")
    other = "bootid-1" if os.name == "nt" and tree._boot_id() != "bootid-1" else "00000000-0000-0000-0000-000000000001"
    _own_record(staging / "installer.pid", boot=other)
    sr._reclaim_staging(staging.parent)
    assert not staging.exists()


@pytest.mark.skipif(not POSIX, reason="named skip: process groups are POSIX")
def test_a_live_member_of_the_bootstraps_group_keeps_the_staging(tmp_path):
    """The bootstrap (the group's leader) ended, but a process it started still runs in its group."""
    staging = _staging(tmp_path)
    tree.launch(staging, "installer")
    pid_file = tmp_path / "member.pid"
    leader = subprocess.Popen(
        [
            sys.executable,
            "-c",
            "import subprocess, sys\n"
            "m = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])\n"
            f"open(r'{pid_file}', 'w').write(str(m.pid))\n",
        ],
        start_new_session=True,
    )
    _own_record(staging / "installer.pid", pid=leader.pid)
    leader.wait(timeout=30)
    member = int(pid_file.read_text())
    try:
        sr._reclaim_staging(staging.parent)
        assert staging.exists()  # the group still has a writer
        os.killpg(leader.pid, 9)
        psutil.wait_procs([psutil.Process(member)], timeout=10)
        sr._reclaim_staging(staging.parent)
        assert not staging.exists()  # every member positively gone
    finally:
        try:
            os.killpg(leader.pid, 9)
        except ProcessLookupError:
            pass


def test_an_owner_killed_mid_install_takes_its_whole_tree_with_it(tmp_path):
    """The owner holds the platform lock and runs a real tree (child + grandchild); it is killed outright — no
    finally runs. The tree must follow it (POSIX: the bootstrap's watch on the owner's pipe; Windows: the Job
    closes with its owner's handle), and the next lock holder reclaims the staging only once that is proven."""
    root = tmp_path / "root"
    staging = root / ".staging" / "linux-x64-cp312" / "attempt"
    staging.mkdir(parents=True)
    pids = tmp_path / "pids"
    worker = _script(
        tmp_path,
        "import os, subprocess, sys, time\n"
        "g = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])\n"
        f"open(r'{pids}', 'w').write(f'{{os.getpid()}} {{g.pid}}')\n"
        "time.sleep(120)\n",
        "worker.py",
    )
    installer = _script(
        tmp_path,
        "import os, sys\nfrom pathlib import Path\n"
        f"sys.path.insert(0, r'{Path(sr.__file__).resolve().parents[2]}')\n"
        "from backend.app import step_runtime as sr\n"
        "from backend.app.services import part_render_tree as tree\n"
        "from backend.app.services.step_runtime_child import run_tree\n"
        f"staging = Path(r'{staging}')\n"
        f"with sr._platform_lock(Path(r'{root}'), 'linux-x64-cp312', 10):\n"
        "    tree.record(staging / 'owner.pid', os.getpid())\n"
        f"    run_tree([sys.executable, r'{worker}'], timeout=120, records=staging)\n",
        "installer.py",
    )
    owner = subprocess.Popen([sys.executable, str(installer)])
    try:
        deadline = time.monotonic() + 30
        while not pids.exists() or len(pids.read_text().split()) < 2:
            assert time.monotonic() < deadline and owner.poll() is None
            time.sleep(0.05)
        writer, grandchild = (int(x) for x in pids.read_text().split())
        # Taken while they run: the tree may follow its owner before the next line could look them up (measured on
        # a GitHub Linux runner: NoSuchProcess), and a process object pins its identity against a reused PID.
        tree_procs = [psutil.Process(writer), psutil.Process(grandchild)]
        owner.kill()
        owner.wait(timeout=10)
        gone, alive = psutil.wait_procs(tree_procs, timeout=15)
        assert not [p for p in alive if p.status() != psutil.STATUS_ZOMBIE]  # the tree followed its owner
        with sr._platform_lock(root, "linux-x64-cp312", 10):
            sr._reclaim_staging(staging.parent)
        assert not staging.exists()
    finally:
        if owner.poll() is None:
            owner.kill()
            owner.wait(timeout=10)


@pytest.mark.skipif(not POSIX, reason="named skip: process groups are POSIX")
def test_a_group_whose_members_cannot_be_read_is_no_proof(monkeypatch):
    def unreadable(pid):
        raise PermissionError(1, "not permitted")

    monkeypatch.setattr(child.os, "getpgid", unreadable)
    assert child.group_members(os.getpid()) is None  # never an empty proof
