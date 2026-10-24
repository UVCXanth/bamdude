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

import asyncio
import collections
import contextlib
import logging
import os
import signal
import subprocess
import sys
import threading
import time
import uuid
import weakref
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

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


class TreeStopped(RuntimeError):
    """The run was stopped by its owner (spec stage C R6). ``started`` False: the command never ran — stopped before
    the launch, or before its bootstrap was released (its end proven); True: it ran and its whole tree was ended,
    the end proven."""

    def __init__(self, started: bool):
        super().__init__("stopped after its start" if started else "stopped before it ran")
        self.started = started


class TreeUnproven(RuntimeError):
    """The command's process tree could not be proven ended; whatever it may write to must be kept. ``survivors``
    names the processes of the tree still alive when the proof gave up, as [pid, create_time] (best effort)."""

    def __init__(self, message: str, survivors: list[list] | None = None):
        super().__init__(message)
        self.survivors = survivors or []


class SpawnFailed(RuntimeError):
    """The command could not be started at all (the OS refused the process): nothing of it runs."""


class TreeFailed(RuntimeError):
    """The run broke after its spawn (its cause chained), and its whole tree was then ended, the end proven."""


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

    return [interpreter, "-c", BOOT, launch_arg(token), *cmd[1:]]


def _named_interpreter(cmd: list[str], interpreter) -> str:
    """The interpreter a caller names for its own command (the Windows installer's embedded Python, run by the
    build): a real interpreter that IS ``cmd[0]``. Never a Windows venv's python.exe — a redirector that starts the
    real interpreter as its own child before the Job is attached. BOOT is plain stdlib, so any CPython runs it."""
    path = os.fspath(interpreter)
    try:
        same = len(cmd) >= 2 and os.path.isfile(path) and os.path.samefile(cmd[0], path)
    except OSError:
        same = False
    if not same:
        raise ValueError("run_tree runs the named interpreter's own -m module or script")
    here = Path(path).resolve().parent
    if os.name == "nt" and any((d / "pyvenv.cfg").exists() for d in (here, here.parent)):
        raise ValueError("a venv's python.exe is a redirector, not an interpreter a Job can own from its spawn")
    return path


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


def _proven_ended(owner, process: subprocess.Popen) -> bool:
    """End the tree and prove it, the bootstrap reaped too. An error while doing so is no proof (Codex C-I-R1)."""
    try:
        return _tree_gone(owner, PROOF_SECONDS) and _reaped(process)
    except Exception as exc:
        logger.warning("ending a CAD helper's process tree failed (%s): its end is not proven", type(exc).__name__)
        return False


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
    interpreter: str | os.PathLike | None = None,
    capture_output: bool = True,
    text: bool = True,
    stop: threading.Event | None = None,
) -> subprocess.CompletedProcess:
    """Run ``[sys.executable, '-m', module, ...]`` or ``[sys.executable, script, ...]`` as an owned tree — or, with
    ``interpreter``, that interpreter's own ``[interpreter, ...]`` (started itself, with ``env`` as given). Raises
    ValueError before any launch or spawn for any other command, subprocess.TimeoutExpired after ending the tree,
    TreeUnproven when its end cannot be proven, RecordUnwritable when ``records`` could not hold the launch or the
    bootstrap's record (nothing was released), SpawnFailed when the OS refused the process, TreeFailed when the
    run broke after its spawn (the tree ended, the end proven), TreeStopped when ``stop`` was set: before the
    launch nothing is started; later the tree is ended exactly as on a timeout, its end proven. No other exception
    leaves it once the process exists."""
    from backend.app.services import part_render_tree as tree
    from backend.app.services.worker_containment import contained_interpreter

    del capture_output, text  # always captured as a bounded text tail
    kwargs = {"start_new_session": True} if os.name != "nt" else {}
    if interpreter is not None:
        interpreter = _named_interpreter(cmd, interpreter)
    elif len(cmd) < 2 or cmd[0] != sys.executable:
        raise ValueError("run_tree runs this interpreter's own -m module or script")
    else:
        interpreter, env = contained_interpreter(env)  # never a venv redirector the Job could miss
    if stop is not None and stop.is_set():
        raise TreeStopped(started=False)  # not even a launch record
    try:
        token = tree.launch(records, _LAUNCH_NAME) if records is not None else uuid.uuid4().hex  # before the spawn
    except Exception as exc:
        raise RecordUnwritable(type(exc).__name__) from exc  # nothing was launched
    try:
        process = subprocess.Popen(
            _bootstrapped(cmd, interpreter, token),
            cwd=cwd,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            **kwargs,
        )
    except Exception as exc:  # the OS refused the process: Popen reaps what it forked before it raises
        if records is not None:
            _drop_records(records)
        raise SpawnFailed(type(exc).__name__) from exc
    # From here every way out either proves the tree ended or is TreeUnproven with its records kept: an unexpected
    # error never reads as "nothing ran" (Codex C-I-R1).
    out, err = _Tail(process.stdout), _Tail(process.stderr)
    try:
        owner = _own(process)
    except BaseException as exc:
        try:  # never released: the bootstrap started nothing, so it alone has to go
            process.kill()
            process.wait(timeout=PROOF_SECONDS)
        except Exception:
            raise TreeUnproven("a bootstrap that could not be owned could not be proven ended") from exc
        if records is not None:
            _drop_records(records)
        if isinstance(exc, Exception):
            raise TreeFailed(type(exc).__name__) from exc
        raise
    if records is not None:
        try:
            tree.record(records / f"{_LAUNCH_NAME}.pid", process.pid)  # durable before its go
        except Exception as exc:
            with contextlib.suppress(OSError):
                process.stdin.close()  # EOF: it ends unrun
            if not _proven_ended(owner, process):
                raise TreeUnproven("an unreleased bootstrap could not be proven ended") from exc
            _drop_records(records)
            raise RecordUnwritable(type(exc).__name__) from exc
    if stop is not None and stop.is_set():  # stopped inside the spawn: never released, it ends unrun
        with contextlib.suppress(OSError):
            process.stdin.close()
        if not _proven_ended(owner, process):
            raise TreeUnproven("an unreleased bootstrap could not be proven ended")
        if records is not None:
            _drop_records(records)
        raise TreeStopped(started=False)
    timed_out = stopped = False
    broke: BaseException | None = None
    try:
        process.stdin.write(GO)  # released: from here every process it starts is owned
        process.stdin.flush()  # the pipe stays open: the bootstrap's watch on its owner
        deadline = time.monotonic() + timeout
        while True:
            try:
                process.wait(timeout=max(0.0, min(0.1, deadline - time.monotonic())))
                break
            except subprocess.TimeoutExpired:
                if stop is not None and stop.is_set():
                    stopped = True
                    break
                if time.monotonic() >= deadline:
                    timed_out = True
                    break
    except BaseException as exc:  # the run broke: the tree is ended all the same before anything is concluded
        broke = exc
    try:
        members = _members(process, owner)
    except Exception:
        members = []  # a failed look at the tree is diagnostics lost, never a reason to leave it running
    proven = _proven_ended(owner, process)
    with contextlib.suppress(OSError):
        process.stdin.close()
    if not proven:
        try:
            survivors = _still_alive(members)
        except Exception:
            survivors = members
        if records is not None:
            _record_survivors(records, survivors)
        raise TreeUnproven("the installer's process tree could not be proven ended", survivors) from broke
    if records is not None:
        _drop_records(records)
    if broke is not None:
        if isinstance(broke, Exception):
            raise TreeFailed(type(broke).__name__) from broke
        raise broke  # an interruption of this thread goes on, the tree already over
    if stopped:
        raise TreeStopped(started=True)
    if timed_out:
        raise subprocess.TimeoutExpired(cmd, timeout, output=out.text(), stderr=err.text())
    return subprocess.CompletedProcess(cmd, process.returncode, out.text(), err.text())


# --- an earlier run's end, and the app's owned run (spec stage C R6) ---------------------------------------------


def drop_owner_records(owner_dir: Path) -> None:
    for path in owner_dir.iterdir():
        if path.is_file():
            path.unlink(missing_ok=True)


def prior_tree_gone(owner_dir: Path, *, log=None) -> bool:
    """True only when no CAD helper of an earlier run may still run (spec stage B R4, Codex B2-R1; stage C R6).
    Nothing is removed or rewritten until that is proven: a launch without a readable owner record is no proof; an
    owner that may live (paused between its launch and its spawn, say) keeps everything; only once the owner is
    proven dead do the bootstrap, its group and the launch token's holders get judged, by the same proof the CAD
    installer uses for its staging. Shared by the Windows build and the app."""
    from backend.app import step_runtime
    from backend.app.services import part_render_tree as tree

    say = log or logger.warning
    owner_dir = Path(owner_dir)
    if not owner_dir.is_dir():
        return True
    owner = owner_dir / step_runtime.OWNER_RECORD
    launched = (owner_dir / f"{step_runtime.INSTALLER}.launch").exists()
    if owner.exists():
        why = tree.recorded_running(owner)
        if why:
            say(f"a CAD helper of an earlier run may still run (its owner: {why})")
            return False
    elif launched:
        say("an earlier run launched a CAD helper and left no readable owner record: its end is not proven")
        return False
    if launched:
        why = step_runtime._writer_may_live(owner_dir)
        if why:
            say(f"a CAD helper of an earlier run may still run ({why})")
            return False
    drop_owner_records(owner_dir)
    return True


@dataclass(frozen=True)
class OwnedRun:
    """One owned run's end: ``ok`` / ``failed`` (with its code) / ``timeout`` / ``unproven`` (records kept) /
    ``helper_unproven`` (an earlier run's end not proven: nothing started). A cancelled run raises instead."""

    outcome: str
    returncode: int | None = None
    stdout_tail: str = ""


_RUN_LOCKS: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()


def _run_lock() -> asyncio.Lock:
    loop = asyncio.get_running_loop()
    lock = _RUN_LOCKS.get(loop)
    if lock is None:
        lock = _RUN_LOCKS[loop] = asyncio.Lock()
    return lock


def _drop_run(records: Path) -> None:
    with contextlib.suppress(OSError):
        drop_owner_records(records)
        records.rmdir()


_PROVEN_ENDS = (subprocess.TimeoutExpired, TreeStopped, RecordUnwritable, SpawnFailed, TreeFailed)
_RELAYED_EVENTS = 32


def _relay_staging_events(stderr: str | None, label: str, run_id: str) -> None:
    """The CAD helper's "staging kept" events (``step_runtime.staging_kept_event``) into this process's log —
    exactly that event, decoded and re-written from its closed fields; every other byte of the child's stderr stays
    in its bounded tail, never passed on (STEP ownership spec S-R6)."""
    from backend.app import step_runtime

    relayed = 0
    for line in (stderr or "").splitlines():
        event = step_runtime.parse_staging_kept(line)
        if event is None:
            continue
        logger.warning(
            "%s run=%s CAD staging kept op=%s outer=%s inner=%s ended=%d elapsed_ms=%d",
            label,
            run_id,
            event["op"],
            event["outer"],
            event["inner"],
            event["ended"],
            event["elapsed_ms"],
        )
        relayed += 1
        if relayed >= _RELAYED_EVENTS:
            return


def _stderr_of(task: asyncio.Future) -> str:
    """What the run's stderr tail holds, where ``run_tree`` gives one: its result, or the timeout it raised."""
    exc = task.exception()
    if exc is None:
        return task.result().stderr or ""
    if isinstance(exc, subprocess.TimeoutExpired) and isinstance(exc.stderr, str):
        return exc.stderr
    return ""


def _settled(task: asyncio.Future, records: Path) -> tuple[str, int | None, str]:
    """The finished thread task's outcome; the run's records go only with a proven end. Only ``run_tree``'s own
    answers prove one — a command it refused before any launch (ValueError, re-raised), its proven ends and its
    result; any other exception proves nothing about the tree, so the records stay (Codex C-I-R1)."""
    exc = task.exception()
    if isinstance(exc, ValueError):
        _drop_run(records)  # refused before any launch: nothing was recorded or started
        raise exc
    if exc is not None and not isinstance(exc, _PROVEN_ENDS):
        if not isinstance(exc, TreeUnproven):
            logger.warning("a CAD helper run ended with %s, which proves nothing of its tree", type(exc).__name__)
        return "unproven", None, ""
    _drop_run(records)
    if exc is None:
        result = task.result()
        return ("ok" if result.returncode == 0 else "failed"), result.returncode, result.stdout or ""
    if isinstance(exc, subprocess.TimeoutExpired):
        return "timeout", None, ""
    if isinstance(exc, TreeStopped):
        return "stopped", None, ""
    return "failed", None, ""


async def run_owned(cmd: list[str], *, owner_root: Path, timeout: float, cwd=None, env=None, label: str) -> OwnedRun:
    """``run_tree`` for the app (spec stage C R6): one at a time in this process, its own records under
    ``owner_root/<run_id>/`` written before its launch, never while an earlier run's end is unproven; a
    cancellation stops the tree and returns only once its end is proven (a second one cannot cut that short). The
    parent log has its start and its end with the outcome and the time, never a path or the child's text."""
    async with _run_lock():
        return await _run_owned(cmd, Path(owner_root), timeout, cwd, env, label)


async def _run_owned(cmd, owner_root: Path, timeout: float, cwd, env, label: str) -> OwnedRun:
    from backend.app import step_runtime
    from backend.app.services import part_render_tree as tree

    run_id = uuid.uuid4().hex[:12]
    begun = time.monotonic()
    logger.info("%s run=%s start", label, run_id)

    def ended(outcome: str, returncode: int | None = None, tail: str = "") -> OwnedRun:
        elapsed = (time.monotonic() - begun) * 1000
        logger.info("%s run=%s outcome=%s rc=%s elapsed_ms=%d", label, run_id, outcome, returncode, elapsed)
        return OwnedRun(outcome, returncode, tail)

    earlier = sorted(p for p in owner_root.iterdir() if p.is_dir()) if owner_root.is_dir() else []
    for prior in earlier:
        if not prior_tree_gone(prior):
            return ended("helper_unproven")
        with contextlib.suppress(OSError):
            prior.rmdir()
    records = owner_root / run_id
    try:
        records.mkdir(parents=True)
        tree.record(records / step_runtime.OWNER_RECORD, os.getpid())  # before the launch
    except Exception:
        _drop_run(records)
        return ended("failed")
    stop = threading.Event()
    task = asyncio.ensure_future(
        asyncio.to_thread(run_tree, cmd, timeout=timeout, records=records, cwd=cwd, env=env, stop=stop)
    )  # created before the first await: no cancellation can leave the thread unwatched
    try:
        await asyncio.shield(task)
    except asyncio.CancelledError:
        stop.set()
        # The thread under the task cannot be cancelled: wait for its end through any further cancellation. (Not
        # preview_artifacts.owned: this module is the Docker CAD layer's, copied before the rest of the app.)
        while not task.done():
            try:
                await asyncio.shield(task)
            except BaseException:  # another cancellation, or the task's own end
                continue
        try:
            outcome = _settled(task, records)[0]
        except Exception:  # an error of the run itself never turns the cancellation into a failure
            outcome = "failed"
        ended(outcome)
        raise
    except Exception:
        pass  # the task's own exception: settled below
    try:
        _relay_staging_events(_stderr_of(task), label, run_id)
    except Exception:  # noqa: BLE001 - diagnostics only: never the run's outcome
        logger.debug("%s run=%s staging events could not be read", label, run_id)
    try:
        settled = _settled(task, records)
    except Exception:
        ended("failed")  # one terminal line on every way out
        raise
    return ended(*settled)
