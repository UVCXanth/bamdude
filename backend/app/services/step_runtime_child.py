"""The owned launcher of the CAD component installer's WHOLE process tree (spec §8, plan A7).

A direct-child kill is no proof of a tree: pip may start processes of its own. The command is started behind a
bootstrap that holds it on its first stdin line until the tree is owned — a Windows Job Object with kill-on-close,
or a new POSIX session — so nothing of it runs outside the owner. When the command ends (or its timeout passes),
the whole tree is ended and the call returns only after the end is PROVEN: the job reports no active process, or
no process is left in the session's group. An unproven end raises TreeUnproven — the caller keeps what that tree
may still write to. Runs in the calling thread with plain Popen and reader threads (no asyncio subprocess), so it
works under Windows' --reload too. Only a bounded tail of stdout/stderr is kept.
"""

from __future__ import annotations

import collections
import os
import signal
import subprocess
import sys
import threading
import time

TAIL_BYTES = 64 * 1024
PROOF_SECONDS = 30.0

BOOT = (
    "import runpy, sys\n"
    "sys.stdin.readline()\n"  # held here until the parent owns the tree
    "target = sys.argv[1:]\n"
    "if target and target[0] == '-m':\n"
    "    sys.argv = [target[1]] + target[2:]\n"
    "    runpy.run_module(target[1], run_name='__main__', alter_sys=True)\n"
    "else:\n"
    "    sys.argv = target\n"
    "    runpy.run_path(target[0], run_name='__main__')\n"
)


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
    import psutil

    alive = []
    for pid, created in identities:
        try:
            if psutil.Process(pid).create_time() == created:
                alive.append([pid, created])
        except psutil.Error:
            continue
    return alive


def _bootstrapped(cmd: list[str], interpreter: str) -> list[str]:
    if len(cmd) < 2 or cmd[0] != sys.executable:
        raise ValueError("run_tree runs this interpreter's own -m module or script")
    return [interpreter, "-c", BOOT, *cmd[1:]]


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


def _tree_gone(owner, timeout: float) -> bool:
    """End every process of the tree and prove none is left."""
    if os.name == "nt":
        try:
            return owner.end_tree(timeout)
        finally:
            owner.close()
    return _posix_group_gone(owner, timeout)


def _posix_group_gone(owner: int, timeout: float) -> bool:
    """POSIX: kill the session's group, then prove by a scan that no live process is left in it."""
    import psutil

    try:
        os.killpg(owner, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass  # gone, or (macOS) a group whose reaped leader the OS will not signal: the scan below decides
    deadline = time.monotonic() + timeout
    while True:
        left = []
        for proc in psutil.process_iter(["pid"]):
            try:
                if os.getpgid(proc.info["pid"]) == owner and proc.status() != psutil.STATUS_ZOMBIE:
                    left.append(proc.info["pid"])
            except (ProcessLookupError, psutil.Error, PermissionError):
                continue
        if not left:
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.05)


def run_tree(
    cmd: list[str],
    *,
    timeout: float,
    cwd=None,
    env=None,
    capture_output: bool = True,
    text: bool = True,
) -> subprocess.CompletedProcess:
    """Run ``[sys.executable, '-m', module, ...]`` or ``[sys.executable, script, ...]`` as an owned tree. Raises
    subprocess.TimeoutExpired after ending the tree, or TreeUnproven when its end cannot be proven."""
    from backend.app.services.worker_containment import contained_interpreter

    del capture_output, text  # always captured as a bounded text tail
    kwargs = {"start_new_session": True} if os.name != "nt" else {}
    interpreter, env = contained_interpreter(env)  # never a venv redirector the Job could miss
    process = subprocess.Popen(
        _bootstrapped(cmd, interpreter),
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
    timed_out = False
    try:
        process.stdin.write(b"\n")  # released: from here every process it starts is owned
        process.stdin.close()
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
    finally:
        members = _members(process, owner)
        proven = _tree_gone(owner, PROOF_SECONDS)
        if process.poll() is None:
            try:
                process.wait(timeout=PROOF_SECONDS)
            except subprocess.TimeoutExpired:
                proven = False
    if not proven:
        raise TreeUnproven("the installer's process tree could not be proven ended", _still_alive(members))
    if timed_out:
        raise subprocess.TimeoutExpired(cmd, timeout, output=out.text(), stderr=err.text())
    return subprocess.CompletedProcess(cmd, process.returncode, out.text(), err.text())
