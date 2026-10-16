"""The owned launcher of the CAD component installer's WHOLE process tree (spec §8, plan A7, Codex A-R1).

A direct-child kill is no proof of a tree: pip may start processes of its own. The command is started behind a
bootstrap that runs it only on an explicit ``go`` line from its owner — EOF or anything else ends it unrun — sent
once the tree is owned (a Windows Job Object with kill-on-close, or a new POSIX session). From then on the
bootstrap watches the owner's pipe: when the owner dies, however it dies, the pipe closes and the bootstrap takes
its whole group with it (POSIX; on Windows the Job closes with its owner's handle).

With ``records`` (the CAD installer's staging) the proof also survives a crash of the owner: the launch's token is
on disk BEFORE the spawn and the bootstrap's own record (pid, start, boot, user) BEFORE its go, both through
``part_render_tree``. A crash at any point leaves either nothing that ran or a record that names it; a proven end
removes them. When the command ends (or its timeout passes) the whole tree is ended, and the call returns only
after the end is PROVEN: the job reports no active process, or no process is left in the session's group. An
unproven end raises TreeUnproven and leaves the records (plus one per survivor) for the next install to judge.
Runs in the calling thread with plain Popen and reader threads (no asyncio subprocess), so it works under Windows'
--reload too. Only a bounded tail of stdout/stderr is kept.
"""

from __future__ import annotations

import collections
import os
import signal
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

TAIL_BYTES = 64 * 1024
PROOF_SECONDS = 30.0
GO = b"go\n"
_LAUNCH_NAME = "installer"

BOOT = (
    "import os, runpy, sys, threading\n"
    "if sys.stdin.buffer.readline() != b'go\\n':\n"
    "    os._exit(75)\n"  # EOF or anything else: the owner never released this run
    "control = os.dup(0)\n"  # the owner's pipe, from here only its liveness; not inherited by the target (PEP 446)
    "null = os.open(os.devnull, os.O_RDONLY)\n"
    "os.dup2(null, 0)\n"
    "os.close(null)\n"
    "def watch():\n"
    "    while os.read(control, 4096):\n"
    "        pass\n"
    "    if os.name != 'nt':\n"  # the owner is gone: nothing of its tree may outlive it
    "        import signal\n"
    "        os.killpg(os.getpgid(0), signal.SIGKILL)\n"
    "    os._exit(70)\n"
    "threading.Thread(target=watch, daemon=True).start()\n"
    "target = sys.argv[1:]\n"
    "if target and target[0].startswith('--bamdude-launch='):\n"
    "    target = target[1:]\n"
    "if target and target[0] == '-m':\n"
    "    sys.argv = [target[1]] + target[2:]\n"
    "    runpy.run_module(target[1], run_name='__main__', alter_sys=True)\n"
    "else:\n"
    "    sys.argv = target\n"
    "    runpy.run_path(target[0], run_name='__main__')\n"
)


class RecordUnwritable(RuntimeError):
    """The bootstrap's record could not be made durable: it was never released, and its end is proven."""


class TreeUnproven(RuntimeError):
    """The command's process tree could not be proven ended; whatever it may write to must be kept. ``survivors``
    names the processes of the tree still alive when the proof gave up, as [pid, create_time] (best effort)."""

    def __init__(self, message: str, survivors: list[list] | None = None):
        super().__init__(message)
        self.survivors = survivors or []


def _identities(pids) -> list[list]:
    import psutil

    out = []
    for pid in pids:
        try:
            out.append([pid, psutil.Process(pid).create_time()])
        except psutil.Error:
            continue
    return out


def _members(process: subprocess.Popen, owner) -> list[list]:
    """The tree as it stands just before it is ended: the bootstrap, its descendants and (POSIX) the session's
    group — what a failed proof reports as possible survivors."""
    import psutil

    pids = {process.pid}
    try:
        pids.update(child.pid for child in psutil.Process(process.pid).children(recursive=True))
    except psutil.Error:
        pass
    if os.name != "nt":
        for proc in psutil.process_iter(["pid"]):
            try:
                if os.getpgid(proc.info["pid"]) == owner:
                    pids.add(proc.info["pid"])
            except (ProcessLookupError, psutil.Error, PermissionError):
                continue
    return _identities(sorted(pids))


def _still_alive(identities: list[list]) -> list[list]:
    """The identities not positively ended: a process that cannot be read stays (no proof)."""
    import psutil

    alive = []
    for pid, created in identities:
        try:
            if psutil.Process(pid).create_time() == created:
                alive.append([pid, created])
        except psutil.NoSuchProcess:
            continue
        except psutil.Error:
            alive.append([pid, created])
    return alive


def _bootstrapped(cmd: list[str], interpreter: str, token: str) -> list[str]:
    from backend.app.services.part_render_tree import launch_arg

    if len(cmd) < 2 or cmd[0] != sys.executable:
        raise ValueError("run_tree runs this interpreter's own -m module or script")
    return [interpreter, "-c", BOOT, launch_arg(token), *cmd[1:]]


class _Tail:
    def __init__(self, stream):
        self._chunks: collections.deque[bytes] = collections.deque()
        self._size = 0
        self._thread = threading.Thread(target=self._read, args=(stream,), daemon=True)
        self._thread.start()

    def _read(self, stream) -> None:
        try:
            for chunk in iter(lambda: stream.read(8192), b""):
                self._chunks.append(chunk)
                self._size += len(chunk)
                while self._size > TAIL_BYTES and len(self._chunks) > 1:
                    self._size -= len(self._chunks.popleft())
        finally:
            stream.close()

    def text(self) -> str:
        self._thread.join(timeout=5)
        data = b"".join(self._chunks)[-TAIL_BYTES:]
        return data.decode("utf-8", errors="replace")


def _own(process: subprocess.Popen):
    """Before the bootstrap is released: the owner of everything the command will start."""
    if os.name == "nt":
        from backend.app.services.worker_containment import WorkerContainment

        return WorkerContainment.attach(process.pid)
    return process.pid  # the session's group id (start_new_session at the spawn)


def _reaped(process: subprocess.Popen) -> bool:
    if process.poll() is None:
        try:
            process.wait(timeout=PROOF_SECONDS)
        except subprocess.TimeoutExpired:
            return False
    return True


def _tree_gone(owner, timeout: float) -> bool:
    """End every process of the tree and prove none is left."""
    if os.name == "nt":
        try:
            return owner.end_tree(timeout)
        finally:
            owner.close()
    return _posix_group_gone(owner, timeout)


def group_members(group: int) -> list[int] | None:
    """POSIX: the live processes of process group ``group``, or None when the scan proves nothing — a process
    that may be ours whose group cannot be read. Only a positive observation excludes one: another user's (its
    uids read, and not ours), no such process, a zombie."""
    import psutil

    from backend.app.services.part_render_tree import _uid

    mine = os.getuid()
    left = []
    for proc in psutil.process_iter(["pid", "uids"]):
        uid = _uid(proc.info.get("uids"))
        if uid is not None and uid != mine:
            continue  # positively another user's: not a process of our session
        pid = proc.info["pid"]
        try:
            if os.getpgid(pid) != group:
                continue
        except ProcessLookupError:
            continue
        except PermissionError:
            return None
        try:
            if proc.status() == psutil.STATUS_ZOMBIE:
                continue
        except psutil.NoSuchProcess:
            continue
        except psutil.AccessDenied:
            pass
        left.append(pid)
    return left


def _posix_group_gone(owner: int, timeout: float) -> bool:
    """POSIX: kill the session's group, then prove by a scan that no live process is left in it."""
    try:
        os.killpg(owner, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass  # gone, or (macOS) a group whose reaped leader the OS will not signal: the scan below decides
    deadline = time.monotonic() + timeout
    while True:
        left = group_members(owner)
        if left == []:
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.05)


def _record_survivors(records: Path, survivors: list[list]) -> None:
    from backend.app.services import part_render_tree as tree

    for pid, _created in survivors:
        try:
            tree.record(records / f"survivor-{pid}.pid", pid)
        except Exception:
            continue  # the bootstrap's record stays: the staging is kept either way


def _drop_records(records: Path) -> None:
    for name in (f"{_LAUNCH_NAME}.pid", f"{_LAUNCH_NAME}.launch"):
        try:
            (records / name).unlink(missing_ok=True)
        except OSError:
            pass  # a record of a proven-ended process proves itself ended to the next reader


def run_tree(
    cmd: list[str],
    *,
    timeout: float,
    records: Path | None = None,
    cwd=None,
    env=None,
    capture_output: bool = True,
    text: bool = True,
) -> subprocess.CompletedProcess:
    """Run ``[sys.executable, '-m', module, ...]`` or ``[sys.executable, script, ...]`` as an owned tree. Raises
    subprocess.TimeoutExpired after ending the tree, TreeUnproven when its end cannot be proven, RecordUnwritable
    when ``records`` could not hold the bootstrap's record (nothing was released)."""
    from backend.app.services import part_render_tree as tree
    from backend.app.services.worker_containment import contained_interpreter

    del capture_output, text  # always captured as a bounded text tail
    kwargs = {"start_new_session": True} if os.name != "nt" else {}
    interpreter, env = contained_interpreter(env)  # never a venv redirector the Job could miss
    token = tree.launch(records, _LAUNCH_NAME) if records is not None else uuid.uuid4().hex  # before the spawn
    process = subprocess.Popen(
        _bootstrapped(cmd, interpreter, token),
        cwd=cwd,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        **kwargs,
    )
    out, err = _Tail(process.stdout), _Tail(process.stderr)
    try:
        owner = _own(process)
    except Exception:
        process.kill()
        process.wait(timeout=30)
        raise
    if records is not None:
        try:
            tree.record(records / f"{_LAUNCH_NAME}.pid", process.pid)  # durable before its go
        except Exception as exc:
            process.stdin.close()  # EOF: it ends unrun
            proven = _tree_gone(owner, PROOF_SECONDS) and _reaped(process)
            if not proven:
                raise TreeUnproven("an unreleased bootstrap could not be proven ended") from exc
            _drop_records(records)
            raise RecordUnwritable(type(exc).__name__) from exc
    timed_out = False
    try:
        process.stdin.write(GO)  # released: from here every process it starts is owned
        process.stdin.flush()  # the pipe stays open: the bootstrap's watch on its owner
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
    finally:
        members = _members(process, owner)
        proven = _tree_gone(owner, PROOF_SECONDS) and _reaped(process)
        try:
            process.stdin.close()
        except OSError:
            pass
    if not proven:
        survivors = _still_alive(members)
        if records is not None:
            _record_survivors(records, survivors)
        raise TreeUnproven("the installer's process tree could not be proven ended", survivors)
    if records is not None:
        _drop_records(records)
    if timed_out:
        raise subprocess.TimeoutExpired(cmd, timeout, output=out.text(), stderr=err.text())
    return subprocess.CompletedProcess(cmd, process.returncode, out.text(), err.text())
