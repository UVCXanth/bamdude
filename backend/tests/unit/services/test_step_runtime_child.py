"""The owned launcher of the CAD installer's whole process tree (spec §8, plan A7): a direct-child kill is no proof
of a tree. The command is held at a bootstrap until the tree is owned (a Windows Job / a POSIX session), a grandchild
it leaves behind is ended before the call returns, a timeout ends the whole tree and waits for the proof, an
unproven tree is an error of its own, and only a bounded tail of the output is kept."""

from __future__ import annotations

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
import subprocess, sys, time
from pathlib import Path
out = Path(sys.argv[1])
g = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
out.write_text(str(g.pid))
{tail}
"""


def _alive(pid: int) -> bool:
    try:
        return psutil.Process(pid).status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False


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
    assert not _alive(int(marker.read_text()))  # owned with the tree, not left running


def test_a_timeout_ends_the_whole_tree_and_waits_for_it(tmp_path):
    marker = tmp_path / "grandchild.pid"
    script = _script(tmp_path, GRANDCHILD.format(tail="time.sleep(120)"))
    started = time.monotonic()
    with pytest.raises(subprocess.TimeoutExpired):
        child.run_tree([sys.executable, str(script), str(marker)], timeout=3)
    assert time.monotonic() - started < 60
    assert not _alive(int(marker.read_text()))


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
