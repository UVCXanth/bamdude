"""The owned launcher of the CAD installer's whole process tree (spec §8, plan A7): a direct-child kill is no proof
of a tree. The command is held at a bootstrap until the tree is owned (a Windows Job / a POSIX session), a grandchild
it leaves behind is ended before the call returns, a timeout ends the whole tree and waits for the proof, an
unproven tree is an error of its own, and only a bounded tail of the output is kept."""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

import psutil
import pytest

from backend.app.services import step_runtime_child as child


def _script(tmp_path: Path, body: str) -> Path:
    path = tmp_path / "work.py"
    path.write_text(body, encoding="utf-8")
    return path


GRANDCHILD = """
import subprocess, sys, time, psutil
from pathlib import Path
out = Path(sys.argv[1])
g = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
(out.parent / "grandchild.created").write_text(str(psutil.Process(g.pid).create_time()))
out.write_text(str(g.pid))
{tail}
"""


def _alive(pid: int, created: float | None = None) -> bool:
    try:
        process = psutil.Process(pid)
        if created is not None and process.create_time() != created:
            return False  # a reused PID is not the reader this test launched
        if process.status() == psutil.STATUS_ZOMBIE:
            return False
        process.wait(timeout=0)  # no grace period: Windows status alone can describe a stale process-table entry
        return False
    except psutil.TimeoutExpired:
        return True
    except psutil.NoSuchProcess:
        return False


def test_the_liveness_oracle_does_not_mistake_a_terminated_process_entry_for_a_reader(monkeypatch):
    class Ended:
        def status(self):
            return psutil.STATUS_RUNNING  # a stale process-table entry is not a waitable live process

        def wait(self, timeout):
            assert timeout == 0
            return 1

    monkeypatch.setattr(psutil, "Process", lambda pid: Ended())
    assert not _alive(123)


def test_the_liveness_oracle_still_rejects_a_reader_that_has_not_ended(monkeypatch):
    class Reading:
        def status(self):
            return psutil.STATUS_RUNNING

        def wait(self, timeout):
            assert timeout == 0
            raise psutil.TimeoutExpired(timeout, pid=123)

    monkeypatch.setattr(psutil, "Process", lambda pid: Reading())
    assert _alive(123)


def test_the_liveness_oracle_does_not_mistake_a_reused_pid_for_its_reader(monkeypatch):
    class Replacement:
        def create_time(self):
            return 200.0

        def status(self):
            raise AssertionError("another process is not our reader")

    monkeypatch.setattr(psutil, "Process", lambda pid: Replacement())
    assert not _alive(123, created=100.0)


def test_a_command_runs_and_only_a_bounded_tail_of_its_output_is_kept(tmp_path):
    script = _script(tmp_path, "import sys\nfor i in range(20000): print('line', i)\nprint('last line')\n")
    result = child.run_tree([sys.executable, str(script)], timeout=60)
    assert result.returncode == 0
    assert len(result.stdout.encode()) <= child.TAIL_BYTES
    assert result.stdout.rstrip().endswith("last line")


def test_a_module_command_runs_as_with_python_m(tmp_path):
    result = child.run_tree([sys.executable, "-m", "pip", "--version"], timeout=120)
    assert result.returncode == 0 and "pip" in result.stdout


def test_a_grandchild_left_behind_is_ended_before_the_call_returns(tmp_path):
    marker = tmp_path / "grandchild.pid"
    script = _script(tmp_path, GRANDCHILD.format(tail=""))
    result = child.run_tree([sys.executable, str(script), str(marker)], timeout=60)
    assert result.returncode == 0
    assert not _alive(int(marker.read_text()), float((tmp_path / "grandchild.created").read_text()))


def test_a_timeout_ends_the_whole_tree_and_waits_for_it(tmp_path):
    marker = tmp_path / "grandchild.pid"
    script = _script(tmp_path, GRANDCHILD.format(tail="time.sleep(120)"))
    started = time.monotonic()
    with pytest.raises(subprocess.TimeoutExpired):
        child.run_tree([sys.executable, str(script), str(marker)], timeout=3)
    assert time.monotonic() - started < 60
    assert not _alive(int(marker.read_text()), float((tmp_path / "grandchild.created").read_text()))


def test_nothing_runs_before_the_tree_is_owned(tmp_path, monkeypatch):
    marker = tmp_path / "ran"
    script = _script(tmp_path, f"from pathlib import Path\nPath(r'{marker}').write_text('x')\n")
    real = child._own
    seen = {}

    def slow_own(process):
        time.sleep(1.0)  # the window between the spawn and the ownership
        seen["ran_before_owned"] = marker.exists()
        return real(process)

    monkeypatch.setattr(child, "_own", slow_own)
    child.run_tree([sys.executable, str(script)], timeout=60)
    assert seen == {"ran_before_owned": False} and marker.exists()


def test_a_tree_whose_end_is_not_proven_is_an_error_of_its_own(tmp_path, monkeypatch):
    script = _script(tmp_path, "print('ok')\n")
    monkeypatch.setattr(child, "_tree_gone", lambda owner, timeout: False)
    with pytest.raises(child.TreeUnproven):
        child.run_tree([sys.executable, str(script)], timeout=60)


def test_a_failing_command_reports_its_exit_code_and_stderr_tail(tmp_path):
    script = _script(tmp_path, "import sys\nprint('boom', file=sys.stderr)\nsys.exit(7)\n")
    result = child.run_tree([sys.executable, str(script)], timeout=60)
    assert result.returncode == 7 and "boom" in result.stderr


def test_the_reader_holds_only_a_bounded_tail_in_memory():
    import io

    tail = child._Tail(io.BytesIO(b"x" * (child.TAIL_BYTES * 16)))
    assert len(tail.text()) == child.TAIL_BYTES
    assert sum(len(chunk) for chunk in tail._chunks) <= child.TAIL_BYTES + 8192  # one read past the bound at most


class _FakeJob:
    """Windows' job accounting as a sequence of ActiveProcesses answers: the kernel ends a process asynchronously."""

    def __init__(self, active):
        self.active = list(active)
        self.terminated = False

    def TerminateJobObject(self, handle, code):  # noqa: N802 — the Win32 name
        self.terminated = True
        return 1

    def QueryInformationJobObject(self, handle, klass, info, size, returned):  # noqa: N802
        info._obj.ActiveProcesses = self.active.pop(0) if len(self.active) > 1 else self.active[0]
        return 1


def test_a_job_is_proven_ended_only_once_it_reports_no_active_process(monkeypatch):
    from backend.app.services import worker_containment as wc

    job = _FakeJob([2, 1, 1, 0])
    monkeypatch.setattr(wc, "_windows_kernel32", lambda: job)
    assert wc.WorkerContainment(pid=1, _job_handle=7).end_tree(5) is True
    assert job.terminated and job.active == [0]  # it waited through every answer that still had a process


def test_a_job_that_keeps_a_process_is_not_proven_ended(monkeypatch):
    from backend.app.services import worker_containment as wc

    monkeypatch.setattr(wc, "_windows_kernel32", lambda: _FakeJob([1]))
    started = time.monotonic()
    assert wc.WorkerContainment(pid=1, _job_handle=7).end_tree(0.3) is False
    assert time.monotonic() - started >= 0.3


def test_a_job_whose_accounting_cannot_be_read_is_not_proven_ended(monkeypatch):
    from backend.app.services import worker_containment as wc

    class Unreadable(_FakeJob):
        def QueryInformationJobObject(self, handle, klass, info, size, returned):  # noqa: N802
            return 0

    monkeypatch.setattr(wc, "_windows_kernel32", lambda: Unreadable([0]))
    assert wc.WorkerContainment(pid=1, _job_handle=7).end_tree(5) is False


IN_A_WINDOWS_VENV = os.name == "nt" and getattr(sys, "_base_executable", sys.executable) != sys.executable


@pytest.mark.skipif(not IN_A_WINDOWS_VENV, reason="named skip: only a Windows venv starts python through a redirector")
def test_a_late_attach_in_a_windows_venv_lets_nothing_escape_the_job(tmp_path, monkeypatch):
    """The venv's python.exe is a redirector that starts the real interpreter as its own child at once: attached
    late, that interpreter — and whatever it starts — ran outside the Job, and its end was "proven" by a Job that
    only ever held the redirector."""
    real_own = child._own

    def late(process):
        time.sleep(0.5)  # the redirector has long started the real interpreter by now
        return real_own(process)

    monkeypatch.setattr(child, "_own", late)
    marker = tmp_path / "grandchild.pid"
    script = _script(tmp_path, GRANDCHILD.format(tail=""))
    result = child.run_tree([sys.executable, str(script), str(marker)], timeout=60)
    assert result.returncode == 0
    assert not _alive(int(marker.read_text()), float((tmp_path / "grandchild.created").read_text()))


def test_a_contained_child_starts_the_base_interpreter_told_its_venv():
    from backend.app.services.worker_containment import contained_interpreter

    venv, base = r"C:\app\venv\Scripts\python.exe", r"C:\Python312\python.exe"
    exe, env = contained_interpreter({"A": "1"}, platform="nt", executable=venv, base=base)
    assert (exe, env) == (base, {"A": "1", "__PYVENV_LAUNCHER__": venv})
    assert contained_interpreter({"A": "1"}, platform="nt", executable=base, base=base) == (base, {"A": "1"})
    assert contained_interpreter(None, platform="posix", executable="/v/bin/python", base="/usr/bin/python3") == (
        "/v/bin/python",
        None,
    )


def test_every_contained_python_child_is_started_through_contained_interpreter():
    """A spawn of sys.executable attached to a Job afterwards is the race above; the guard reads the sources."""
    import ast

    root = Path(child.__file__).resolve().parents[1]
    offenders = []
    for path in root.rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        if "WorkerContainment.attach" not in text:
            continue
        for node in ast.walk(ast.parse(text)):
            if isinstance(node, ast.Call):
                name = getattr(node.func, "attr", getattr(node.func, "id", ""))
                if name in {"Popen", "create_subprocess_exec"} and node.args:
                    first = node.args[0]
                    program = first.elts[0] if isinstance(first, ast.List) and first.elts else first
                    if ast.unparse(program) == "sys.executable":
                        offenders.append(f"{path.relative_to(root)}:{node.lineno}")
    assert offenders == []


def test_a_group_the_os_will_not_signal_after_its_leader_was_reaped_is_still_scanned(monkeypatch):
    """macOS answers EPERM to killpg on a group whose leader is a reaped zombie (a lesson of PreviewProcess.stop):
    the proof goes on to its scan instead of failing the install with a bare PermissionError (review A-m10)."""

    def refuse(pgid, sig):
        raise PermissionError(1, "Operation not permitted")

    monkeypatch.setattr(child.os, "killpg", refuse, raising=False)
    monkeypatch.setattr(child, "group_members", lambda group: [])  # nothing left in the group
    monkeypatch.setattr(child.signal, "SIGKILL", 9, raising=False)
    assert child._posix_group_gone(424242, timeout=1) is True


# --- a named interpreter: the Windows installer's embedded Python owned whole by the build (stage B, Task 1) -----

BASE = getattr(sys, "_base_executable", sys.executable)  # another interpreter than this (Windows) venv's redirector
ROOT = Path(__file__).resolve().parents[4]

REPORTING_GRANDCHILD = """
import subprocess, sys, time
from pathlib import Path
out = Path(sys.argv[1])
(out.parent / "executable.txt").write_text(sys.executable, encoding="utf-8")
g = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
out.write_text(str(g.pid))
time.sleep(120)
"""


def test_a_foreign_interpreter_runs_the_whole_tree_owned(tmp_path):
    marker = tmp_path / "grandchild.pid"
    script = _script(tmp_path, REPORTING_GRANDCHILD)
    with pytest.raises(subprocess.TimeoutExpired):
        child.run_tree([BASE, str(script), str(marker)], timeout=3, interpreter=BASE)
    deadline = time.monotonic() + 10
    while _alive(int(marker.read_text())) and time.monotonic() < deadline:
        time.sleep(0.1)
    assert not _alive(int(marker.read_text()))  # a plain Popen grandchild: owned by the tree, ended with it
    assert os.path.samefile((tmp_path / "executable.txt").read_text(encoding="utf-8"), BASE)


def test_a_foreign_interpreter_must_be_the_command(tmp_path):
    marker = tmp_path / "ran"
    script = _script(tmp_path, f"from pathlib import Path\nPath(r'{marker}').write_text('x')\n")
    records = tmp_path / "records"
    records.mkdir()
    with pytest.raises(ValueError):
        child.run_tree([sys.executable, str(script)], timeout=30, interpreter=tmp_path / "missing" / "python.exe")
    with pytest.raises(ValueError):
        child.run_tree(["python-elsewhere", str(script)], timeout=30, interpreter=BASE, records=records)
    assert not marker.exists() and list(records.iterdir()) == []  # refused before any launch or spawn


@pytest.mark.skipif(not IN_A_WINDOWS_VENV, reason="named skip: only a Windows venv's python.exe is a redirector")
def test_a_venv_redirector_is_refused_as_a_foreign_interpreter(tmp_path):
    script = _script(tmp_path, "print('ok')\n")
    with pytest.raises(ValueError):
        child.run_tree([sys.executable, str(script)], timeout=30, interpreter=sys.executable)


OWNER = r"""
import sys
sys.path.insert(0, sys.argv[1])
from pathlib import Path
from backend.app.services import step_runtime_child as child
base, script, marker, records, mode = sys.argv[2:7]
if mode == "before_spawn":
    import subprocess, time
    def held(*args, **kwargs):  # the launch is recorded; the spawn never comes
        Path(records, "held").write_text("x")
        time.sleep(120)
    child.subprocess.Popen = held
child.run_tree([base, script, marker], timeout=120, interpreter=base, records=Path(records))
"""


def _owner(tmp_path: Path, mode: str):
    marker, records = tmp_path / "grandchild.pid", tmp_path / "records"
    records.mkdir()
    script = _script(tmp_path, REPORTING_GRANDCHILD)
    owner_py = tmp_path / "owner.py"
    owner_py.write_text(OWNER, encoding="utf-8")
    proc = subprocess.Popen(
        [sys.executable, str(owner_py), str(ROOT), BASE, str(script), str(marker), str(records), mode]
    )
    return proc, marker, records


def _wait_for(path: Path, seconds: float = 60) -> None:
    deadline = time.monotonic() + seconds
    while not path.exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    assert path.exists(), path


def test_the_owner_dying_after_the_go_takes_the_foreign_tree(tmp_path):
    proc, marker, records = _owner(tmp_path, "after_go")
    try:
        _wait_for(marker)
        grandchild = int(marker.read_text())
        proc.kill()
        proc.wait(timeout=30)
        deadline = time.monotonic() + 15
        while _alive(grandchild) and time.monotonic() < deadline:
            time.sleep(0.1)
        assert not _alive(grandchild)  # the Job (or the session) closed with its owner
    finally:
        if proc.poll() is None:
            proc.kill()


def test_an_owner_that_dies_before_the_spawn_starts_nothing(tmp_path):
    proc, marker, records = _owner(tmp_path, "before_spawn")
    try:
        _wait_for(records / "held")
        proc.kill()
        proc.wait(timeout=30)
        time.sleep(1.0)
        assert not marker.exists()  # nothing of the command ran
        names = {p.name for p in records.iterdir()}
        assert "installer.launch" in names and "installer.pid" not in names  # a launch that never got its go
    finally:
        if proc.poll() is None:
            proc.kill()
