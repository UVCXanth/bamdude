"""The CAD installer keeps the proof of who owns its tree through a crash of its owner (spec §8, Codex A-R1).

Nothing of the installer runs before its owner has it: the bootstrap waits for an explicit "go", and EOF or any
other first line ends it unrun. Before anything is spawned the staging holds the owner's record and the launch's
token, and the bootstrap's own record is durable before it is released — so a crash at any point leaves either
nothing that ran or a record that names it. A later install reclaims a staging only on a positive proof that its
writer is gone: a record that cannot be read, a process that cannot be read and a scan that cannot be completed
all keep it. On POSIX the bootstrap watches its owner's pipe and takes its whole group with it when the owner dies.
"""

from __future__ import annotations

import contextlib
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass, field
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


# --- a launch whose bootstrap never got its record: what each reclaim pass proved ---------------------------------
#
# A reclaim may lawfully refuse: a process that may hold the token and cannot be read keeps the staging and its
# holders untouched. So the test never waits for a death after one silent pass. It asks the very calls the reclaim
# makes — ``_writer_may_live`` (the outer reason) and ``_end_why`` (the inner one, and how many holders it ended) —
# through wrappers that return their answers unchanged, judges each pass by that answer, and repeats a pass only
# after a refusal of observation, while a budget lasts. A claimed proof with a live holder, or a staging the proof
# did not remove, fails at once: a repeat must never hide an unsafe answer. The processes the test started are
# known by (pid, create_time) as they appear — on a Windows venv the launcher AND the interpreter it starts — and
# only those are ever signalled by its cleanup.

_GENERIC = "an unreleased bootstrap not proven ended"
_RETRYABLE = frozenset({"a possible holder unreadable", "a holder's user unreadable"})  # observation refusals only
_RETRY_SECONDS = 30.0  # what the test always gave a reclaim's result; never raised or cut to hide a failure
_READY_SECONDS = 30.0
_UNSET = object()


@dataclass
class _Pass:
    outer: object = _UNSET  # what _writer_may_live answered; _UNSET when the pass never asked it
    inner: list = field(default_factory=list)  # every (why, ended) _end_why answered inside the pass
    seconds: float = 0.0
    staging: bool = True
    alive: list = field(default_factory=list)  # the test's own recorded processes still running after the pass

    def describe(self) -> str:
        outer = "<never asked>" if self.outer is _UNSET else repr(self.outer)
        inner = [f"{why!r} ended={ended}" for why, ended in self.inner] or ["<no token proof>"]
        return f"outer={outer} inner={inner} {self.seconds:.2f}s staging={self.staging} alive={self.alive}"


class _OwnTree:
    """The holder this test starts, and every process of it by (pid, create_time) as it appeared — the only
    processes its cleanup signals, each only while its pid still names the same process."""

    def __init__(self, token: str, seconds: float = 120):
        self.marker = tree.launch_arg(token)
        self.seconds = seconds
        # The rule contained_interpreter applies: in a Windows venv sys.executable is a redirector that starts the
        # real interpreter, with the same command line, as its own child.
        self.redirector = contained_interpreter(None)[0] != sys.executable
        self.launcher: subprocess.Popen | None = None
        self.known: dict[int, float] = {}

    def __enter__(self) -> _OwnTree:
        self.launcher = subprocess.Popen(
            [sys.executable, "-c", f"import time; time.sleep({self.seconds})", self.marker]
        )
        self._note(self.launcher.pid)
        return self

    def _note(self, pid: int) -> None:
        with contextlib.suppress(psutil.Error):
            self.known.setdefault(pid, psutil.Process(pid).create_time())

    def ready(self, seconds: float = _READY_SECONDS) -> None:
        """Until every process of the expected tree carries the token — the launcher's argv alone is not the tree."""
        deadline = time.monotonic() + seconds
        while not self._complete():
            assert time.monotonic() < deadline, f"the test's own tree never became ready: known={sorted(self.known)}"
            time.sleep(0.05)

    def _complete(self) -> bool:
        launcher = psutil.Process(self.launcher.pid)
        kids = launcher.children()  # one look, recorded while their parent lives, never asked of a dead one
        for kid in kids:
            self._note(kid.pid)
        if self.marker not in (launcher.cmdline() or []):
            return False
        if not self.redirector:
            return True
        # Only a holder already recorded makes the tree ready: one seen but not recorded could not be cleaned up.
        holders = [kid for kid in kids if kid.pid in self.known and self.marker in (_cmdline(kid) or [])]
        assert len(holders) <= 1, f"the launcher started {len(holders)} holders of the token"
        return len(holders) == 1

    def alive(self) -> list[int]:
        """The recorded processes still running: a zombie, or a pid that now names another process, has ended."""
        running = []
        for pid, created in self.known.items():
            try:
                process = psutil.Process(pid)
                if process.create_time() != created or process.status() == psutil.STATUS_ZOMBIE:
                    continue
            except psutil.NoSuchProcess:
                continue
            running.append(pid)
        return sorted(running)

    def __exit__(self, exc_type, exc, tb) -> bool:
        problems = []
        for pid, created in self.known.items():
            try:
                process = psutil.Process(pid)
                if process.create_time() != created:
                    continue  # the pid names another process now: never signalled
                process.kill()
                process.wait(timeout=10)
            except psutil.NoSuchProcess:
                continue
            except (psutil.Error, OSError) as error:
                problems.append(f"pid={pid} {type(error).__name__}")
        with contextlib.suppress(Exception):
            self.launcher.wait(timeout=10)  # reaped (POSIX)
        if self.redirector and len(self.known) < 2:
            problems.append("the interpreter the launcher starts was never seen: the tree's end is unproven")
        if problems:
            message = "the test's own tree was not proven ended: " + "; ".join(problems)
            if exc is None:
                raise AssertionError(message)
            exc.add_note(message)  # never in place of the failure that brought the test here
        return False


def _cmdline(process: psutil.Process) -> list[str] | None:
    try:
        return process.cmdline()
    except psutil.Error:
        return None


class _Reclaims:
    """Every pass of the reclaim over one staging, traced through the very calls it makes."""

    def __init__(self, monkeypatch, own: _OwnTree, staging: Path, retry_seconds: float = _RETRY_SECONDS):
        self.own, self.staging, self.retry_seconds = own, staging, retry_seconds
        self.passes: list[_Pass] = []
        real_writer, real_end = sr._writer_may_live, tree._end_why

        def writer(path, *args, **kwargs):
            current = self.passes[-1]
            assert current.outer is _UNSET, "one pass asked _writer_may_live twice"
            current.outer = real_writer(path, *args, **kwargs)
            return current.outer

        def end(*args, **kwargs):
            answer = real_end(*args, **kwargs)
            self.passes[-1].inner.append(answer)
            return answer

        monkeypatch.setattr(sr, "_writer_may_live", writer)
        monkeypatch.setattr(tree, "_end_why", end)

    def describe(self) -> str:
        return "\n".join(f"  pass {n}: {p.describe()}" for n, p in enumerate(self.passes, 1))

    def _fail(self, why: str):
        raise AssertionError(f"{why}\n{self.describe()}")

    def one(self) -> _Pass:
        current = _Pass()
        self.passes.append(current)
        began = time.monotonic()
        try:
            sr._reclaim_staging(self.staging.parent)
        except Exception as error:  # an exception is no refusal: never retried
            current.seconds = time.monotonic() - began
            self._fail(f"the reclaim raised {type(error).__name__}")
        current.seconds = time.monotonic() - began
        current.staging = self.staging.exists()
        current.alive = self.own.alive()
        return current

    def retryable(self, current: _Pass) -> bool:
        return current.outer == _GENERIC and bool(current.inner) and current.inner[-1][0] in _RETRYABLE

    def until_proven(self) -> _Pass:
        deadline = None
        while True:
            current = self.one()
            if current.outer is _UNSET:
                self._fail("the pass left no trace of _writer_may_live")
            if current.outer is None:  # a claimed proof: everything it claims must hold, now
                if current.alive or current.staging:
                    self._fail("the reclaim claimed a proven end, yet the test's tree runs or its staging is left")
                return current
            if not current.staging:
                self._fail("the reclaim refused, yet the staging is gone")
            if not self.retryable(current):
                self._fail("a refusal outside the closed retry list")
            if deadline is None:  # the first pass never counts against the budget (a cold one took 19 s)
                deadline = time.monotonic() + self.retry_seconds
            if time.monotonic() >= deadline:
                self._fail("the retry budget is spent and the end is still not proven")
            time.sleep(0.2)


class _UnreadableRow:
    """A process_iter row of a process that may hold the token and cannot be read."""

    pid = 2**22 + 11

    def __init__(self, info: dict, stall: float = 0.0):
        self.info, self.stall = info, stall

    def status(self):
        time.sleep(self.stall)
        raise psutil.AccessDenied(self.pid)


def _row(marker: str | None) -> dict:
    """``marker=None``: a process of this user whose command line cannot be read; otherwise one that carries the
    marker and whose user cannot be read — each in this platform's own row shape."""
    cmdline = None if marker is None else [sys.executable, marker]
    if os.name == "nt":
        user = tree._identity(psutil.Process()) if marker is None else None
        return {"cmdline": cmdline, "username": user, "name": Path(sys.executable).name, "ppid": os.getpid()}
    return {"cmdline": cmdline, "uids": psutil.Process().uids() if marker is None else None}


def _unreadable_scans(monkeypatch, info: dict, scans: int | None, stall: float = 0.0) -> None:
    """``psutil.process_iter`` yields one more, unreadable, row after the real ones — in the next ``scans``
    scans, or in every one (None)."""
    real = psutil.process_iter
    left = [scans]

    def rows(*args, **kwargs):
        yield from real(*args, **kwargs)
        if left[0] is None or left[0] > 0:
            if left[0] is not None:
                left[0] -= 1
            yield _UnreadableRow(info, stall)

    monkeypatch.setattr(psutil, "process_iter", rows)


def _launch(tmp_path: Path, **owner) -> tuple[Path, str]:
    """A staging whose installer launched and never got its bootstrap's record; its owner ended (or ``owner``)."""
    staging = _staging(tmp_path)
    token = tree.launch(staging, "installer")
    _own_record(staging / "owner.pid", pid=2**22 + 7, create_time=1.0, **owner)  # died before recording it
    return staging, token


def test_a_launch_whose_bootstrap_never_got_its_record_is_ended_then_reclaimed(tmp_path, monkeypatch):
    staging, token = _launch(tmp_path)
    with _OwnTree(token) as own:
        own.ready()
        proof = _Reclaims(monkeypatch, own, staging).until_proven()
        assert proof.outer is None  # it never got its go: ended, not trusted to read EOF
        assert not own.alive() and not staging.exists()


@pytest.mark.parametrize("unreadable", ["command line", "user"])
def test_a_scan_that_could_not_read_a_possible_holder_refuses_then_the_next_one_proves(
    tmp_path, monkeypatch, unreadable
):
    staging, token = _launch(tmp_path)
    with _OwnTree(token) as own:
        own.ready()
        _unreadable_scans(monkeypatch, _row(None if unreadable == "command line" else own.marker), scans=1)
        reclaims = _Reclaims(monkeypatch, own, staging)
        reclaims.until_proven()
        first, second = reclaims.passes
        reason = "a possible holder unreadable" if unreadable == "command line" else "a holder's user unreadable"
        assert first.outer == _GENERIC and first.inner == [(reason, 0)]  # nothing signalled on an unread scan
        assert first.staging and first.alive == sorted(own.known)
        assert second.outer is None and not second.staging and not second.alive


def test_a_scan_that_never_reads_the_possible_holder_fails_in_the_budget_and_keeps_the_records(tmp_path, monkeypatch):
    staging, token = _launch(tmp_path)
    with _OwnTree(token) as own:
        own.ready()
        _unreadable_scans(monkeypatch, _row(None), scans=None)
        reclaims = _Reclaims(monkeypatch, own, staging, retry_seconds=1.0)
        with pytest.raises(AssertionError, match="the retry budget is spent"):
            reclaims.until_proven()
        assert len(reclaims.passes) >= 2
        assert all(p.inner == [("a possible holder unreadable", 0)] for p in reclaims.passes)
        assert (staging / "installer.launch").is_file() and (staging / "owner.pid").is_file()
        assert own.alive() == sorted(own.known)  # untouched, until the test's own cleanup
    assert not own.alive()


def test_a_slow_first_pass_does_not_spend_the_retry_budget(tmp_path, monkeypatch):
    staging, token = _launch(tmp_path)
    with _OwnTree(token) as own:
        own.ready()
        _unreadable_scans(monkeypatch, _row(None), scans=1, stall=1.5)
        reclaims = _Reclaims(monkeypatch, own, staging, retry_seconds=0.5)
        assert reclaims.until_proven().outer is None
        assert reclaims.passes[0].seconds >= 1.5 and len(reclaims.passes) == 2


def _owner_names_no_user(tmp_path, monkeypatch):
    return _launch(tmp_path, user=None)


def _owner_lives(tmp_path, monkeypatch):
    staging, token = _launch(tmp_path)
    _own_record(staging / "owner.pid")  # this very process: the owner may still run
    return staging, token


def _holder_survives_its_kill(tmp_path, monkeypatch):
    monkeypatch.setattr(tree, "_wait", lambda process, timeout: False)
    return _launch(tmp_path)


def _kill_denied(tmp_path, monkeypatch):
    def denied(self):
        raise psutil.AccessDenied(self.pid)

    monkeypatch.setattr(psutil.Process, "kill", denied)
    return _launch(tmp_path)


@pytest.mark.parametrize(
    "refusal",
    [_owner_names_no_user, _owner_lives, _holder_survives_its_kill, _kill_denied],
    ids=["owner-names-no-user", "owner-lives", "holder-survives-its-kill", "kill-denied"],
)
def test_a_refusal_outside_the_closed_list_fails_on_its_first_pass(tmp_path, monkeypatch, refusal):
    staging, token = refusal(tmp_path, monkeypatch)
    with _OwnTree(token) as own:
        own.ready()
        reclaims = _Reclaims(monkeypatch, own, staging)
        with pytest.raises(AssertionError, match="outside the closed retry list"):
            reclaims.until_proven()
        assert len(reclaims.passes) == 1 and staging.exists()
        monkeypatch.undo()  # the test's own cleanup kills for real
    assert not own.alive()


def test_a_claimed_proof_with_a_live_holder_fails_at_once(tmp_path, monkeypatch):
    staging, token = _launch(tmp_path)
    monkeypatch.setattr(tree, "end_launch_holders", lambda *args, **kwargs: True)  # a proof that ended nothing
    with _OwnTree(token) as own:
        own.ready()
        reclaims = _Reclaims(monkeypatch, own, staging)
        with pytest.raises(AssertionError, match="claimed a proven end"):
            reclaims.until_proven()
        assert len(reclaims.passes) == 1 and reclaims.passes[0].alive
    assert not own.alive()


def test_a_claimed_proof_whose_staging_was_not_removed_fails_at_once(tmp_path, monkeypatch):
    staging, token = _launch(tmp_path)
    with _OwnTree(token) as own:
        own.ready()
        monkeypatch.setattr(sr.shutil, "rmtree", lambda *args, **kwargs: None)  # ignore_errors hid a failure
        reclaims = _Reclaims(monkeypatch, own, staging)
        with pytest.raises(AssertionError, match="claimed a proven end"):
            reclaims.until_proven()
        assert len(reclaims.passes) == 1 and reclaims.passes[0].staging and not reclaims.passes[0].alive


def test_a_reclaim_that_raises_is_no_refusal(tmp_path, monkeypatch):
    staging, token = _launch(tmp_path)

    def broken(*args, **kwargs):
        raise RuntimeError("a reader broke")

    with _OwnTree(token) as own:
        own.ready()
        monkeypatch.setattr(tree, "launch_token", broken)
        reclaims = _Reclaims(monkeypatch, own, staging)
        with pytest.raises(AssertionError, match="the reclaim raised RuntimeError"):
            reclaims.until_proven()
        assert len(reclaims.passes) == 1


def test_a_refusal_whose_staging_is_gone_fails_at_once(tmp_path, monkeypatch):
    staging, token = _launch(tmp_path)
    real = sr._writer_may_live

    def refuses_and_removes(path, *args, **kwargs):  # a reclaim that deleted what it could not prove ended
        why = real(path, *args, **kwargs)
        sr.shutil.rmtree(path, ignore_errors=True)
        return why or _GENERIC

    monkeypatch.setattr(sr, "_writer_may_live", refuses_and_removes)
    with _OwnTree(token) as own:
        own.ready()
        _unreadable_scans(monkeypatch, _row(None), scans=None)
        reclaims = _Reclaims(monkeypatch, own, staging)
        with pytest.raises(AssertionError, match="the reclaim refused, yet the staging is gone"):
            reclaims.until_proven()
        assert len(reclaims.passes) == 1


def test_the_tests_own_tree_ends_whatever_ended_the_test(tmp_path):
    _, token = _launch(tmp_path)
    with pytest.raises(RuntimeError, match="the test broke"), _OwnTree(token) as own:
        own.ready()
        raise RuntimeError("the test broke")
    assert len(own.known) == (2 if own.redirector else 1) and not own.alive()


def test_the_cleanup_ends_every_recorded_process_not_only_the_launcher(tmp_path):
    """Each process is ended by its own recorded identity, never through the launcher: a dead launcher is no
    proof for anything else. (A Windows venv redirector happens to take its interpreter with it — it holds it in
    a kill-on-close Job, measured 2026-10-24 — so the test records a process of its own outside that tree.)"""
    _, token = _launch(tmp_path)
    with _OwnTree(token) as own:
        own.ready()
        other = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)", own.marker])
        own._note(other.pid)
        own.launcher.kill()  # it died first
        own.launcher.wait(timeout=10)
    try:
        assert not own.alive() and other.wait(timeout=10) is not None
    finally:
        if other.poll() is None:
            other.kill()
            other.wait(timeout=10)


@pytest.mark.skipif(contained_interpreter(None)[0] == sys.executable, reason="named skip: no venv redirector here")
def test_ready_waits_for_the_interpreter_the_launcher_starts(tmp_path, monkeypatch):
    """The launcher's argv is not the tree: until its interpreter shows up, the tree is not ready."""
    _, token = _launch(tmp_path)
    real = psutil.Process.children
    hidden = [5]

    def late(self, *args, **kwargs):  # the interpreter appears only after a few looks
        if hidden[0] > 0:
            hidden[0] -= 1
            return []
        return real(self, *args, **kwargs)

    monkeypatch.setattr(psutil.Process, "children", late)
    with _OwnTree(token) as own:
        own.ready()
        assert len(own.known) == 2 and hidden[0] == 0


def test_a_pid_that_names_another_process_now_is_never_signalled(tmp_path):
    _, token = _launch(tmp_path)
    stranger = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        with _OwnTree(token) as own:
            own.ready()
            own.known[stranger.pid] = psutil.Process(stranger.pid).create_time() - 1.0  # a reused pid
        assert stranger.poll() is None and not own.alive()
    finally:
        stranger.kill()
        stranger.wait(timeout=10)


def test_a_test_that_fails_before_its_tree_is_ready_still_ends_what_it_knew(tmp_path, monkeypatch):
    _, token = _launch(tmp_path)
    real = _OwnTree._complete
    monkeypatch.setattr(_OwnTree, "_complete", lambda self: real(self) and False)  # looks, records, never ready
    # A short holder: an interpreter the test never saw cannot outlive it for long.
    with pytest.raises(AssertionError, match="never became ready") as failed, _OwnTree(token, seconds=5) as own:
        own.ready(seconds=1)
    assert not own.alive()
    if own.redirector and len(own.known) < 2:
        assert "the tree's end is unproven" in "\n".join(getattr(failed.value, "__notes__", []))


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
