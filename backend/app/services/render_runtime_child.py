"""The parent side of ``render_runtime provision``: one runner, one parent log (inv-local-microservice-parent-log).

Every caller in the app -- the in-app update today -- runs the CHECKED-OUT module of the install in a child process,
because the running process may hold older code and an older pin. The parent logs a start, exactly one outcome with
its elapsed time and the run's id, and a reason that is bounded and never names the install (implementation
consilium 2026-10-13, NL-I-R1 / NL-I-M1). The child's stdout is not read; its stderr is drained to EOF and only its
tail is kept, so a noisy child can neither block on a full pipe nor fill the parent's memory or log.

The child is a ``subprocess.Popen`` owned by a thread of its own from the spawn to the reap, never an asyncio
subprocess: ``uvicorn --reload`` on Windows runs the app on a SelectorEventLoop, which has no subprocess transport
(consilium r2 SP2-R1), and a checkout started that way must provision as well as a service.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import secrets
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path, PurePath, PureWindowsPath

logger = logging.getLogger(__name__)

STDERR_TAIL = 4096  # bytes of the child's stderr kept; the rest is read and dropped
REASON_CHARS = 240  # the longest reason the parent log carries
KILL_WAIT = 10.0  # seconds a killed child gets to be reaped
_READ = 65536


@dataclass(frozen=True)
class ProvisionRun:
    """How one run ended: ``provisioned`` / ``no_build`` (exit 3) / ``failed`` / ``timed_out`` / ``cancelled``
    (raised, never returned) / ``not_started``; ``reason`` is the redacted, bounded last line of the child's stderr."""

    outcome: str
    elapsed: float
    reason: str | None = None


def _spellings(path: PurePath) -> set[str]:
    """Every way a child names ``path``: as given, resolved, with forward slashes, and as ``str(OSError)`` quotes a
    filename -- with ``repr()``, which doubles every Windows backslash. A root directory names nothing."""
    paths = [path]
    if isinstance(path, Path):
        with contextlib.suppress(OSError, RuntimeError):
            paths.append(path.resolve())
    plain = {spelling for p in paths if len(p.parts) > 1 for spelling in (str(p), p.as_posix())}
    return plain | {repr(s)[1:-1] for s in plain}


def redact(line: str, app_dir: PurePath) -> str:
    """One line of the child's stderr, fit for the parent log.

    Every spelling of the install path becomes ``<install>`` and every spelling of the user's home ``~`` (an
    interpreter or a venv outside the install names it, and with it the user); Windows paths match in any case.
    Control characters become spaces; the result is at most ``REASON_CHARS`` long.
    """
    replacements = [(spelling, "<install>") for spelling in _spellings(app_dir)]
    with contextlib.suppress(RuntimeError, KeyError):  # no home to name
        replacements += [(spelling, "~") for spelling in _spellings(Path.home())]
    flags = re.IGNORECASE if isinstance(app_dir, PureWindowsPath) or sys.platform == "win32" else 0
    for spelling, token in sorted(replacements, key=lambda r: len(r[0]), reverse=True):
        line = re.sub(re.escape(spelling), token, line, flags=flags)
    line = "".join(ch if ch.isprintable() else " " for ch in line).strip()
    return line if len(line) <= REASON_CHARS else line[: REASON_CHARS - 1] + "…"


def _last_line(tail: bytes, truncated: bool) -> str | None:
    text = tail.decode("utf-8", "replace").rstrip()
    before, newline, last = text.rpartition("\n")
    if truncated and not newline:
        # the line began before the kept tail: its head -- where a path would sit -- is gone, so it says nothing safe
        return f"(the child's last line is longer than {STDERR_TAIL} bytes)"
    return last.strip() or None


def _drain(stream) -> tuple[bytes, bool]:
    """Read to EOF, keeping the last ``STDERR_TAIL`` bytes and whether anything before them was dropped."""
    tail = bytearray()
    truncated = False
    while chunk := stream.read(_READ):
        tail += chunk
        if len(tail) > STDERR_TAIL:
            del tail[: len(tail) - STDERR_TAIL]
            truncated = True
    return bytes(tail), truncated


def _argv(app_dir: Path) -> list[str]:
    return [
        sys.executable,
        "-m",
        "backend.app.services.render_runtime",
        "provision",
        "--runtime",
        str(app_dir / "runtime"),
    ]


def _spawn(app_dir: Path) -> subprocess.Popen:
    return subprocess.Popen(
        _argv(app_dir),
        cwd=str(app_dir),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


@dataclass(frozen=True)
class _Ended:
    error: OSError | None = None  # the child never started
    returncode: int | None = None
    tail: bytes = b""
    truncated: bool = False


class _Watcher:
    """One child, owned by its own thread from the spawn to the reap: it drains stderr to EOF, waits for the exit and
    reports to the loop that started it. A kill asked before the spawn returned is honoured as soon as it does."""

    def __init__(self, app_dir: Path, loop: asyncio.AbstractEventLoop):
        self.app_dir = app_dir
        self.loop = loop
        self.ended: asyncio.Future = loop.create_future()
        self.process: subprocess.Popen | None = None
        self._killed = threading.Event()
        threading.Thread(target=self._run, name="render-runtime-provision", daemon=True).start()

    def _run(self) -> None:
        try:
            process = _spawn(self.app_dir)
        except OSError as exc:
            self._report(_Ended(error=exc))
            return
        self.process = process
        if self._killed.is_set():  # the run was stopped while its child was being started
            self._end(process)
        try:
            tail, truncated = _drain(process.stderr)
        finally:
            process.stderr.close()
        process.wait()
        self._report(_Ended(returncode=process.returncode, tail=tail, truncated=truncated))

    def _report(self, ended: _Ended) -> None:
        with contextlib.suppress(RuntimeError):  # the loop is closed: nobody waits for this run any more
            self.loop.call_soon_threadsafe(self._settle, ended)

    def _settle(self, ended: _Ended) -> None:
        if not self.ended.done():
            self.ended.set_result(ended)

    @staticmethod
    def _end(process: subprocess.Popen) -> None:
        with contextlib.suppress(OSError):
            if process.poll() is None:
                process.kill()

    def kill(self) -> None:
        self._killed.set()
        if (process := self.process) is not None:
            self._end(process)


async def _stop(watcher: _Watcher) -> bool:
    """Kill the child and wait for its watcher to reap it (stderr still drains); ``True`` once it has."""
    watcher.kill()
    await asyncio.wait({watcher.ended}, timeout=KILL_WAIT)
    return watcher.ended.done()


async def run_provision(app_dir: Path, *, trigger: str, timeout: float | None = None) -> ProvisionRun:
    """``python -m backend.app.services.render_runtime provision --runtime <app_dir>/runtime`` in ``app_dir``.

    Never raises for the child's sake -- a missing runtime is a missing feature, reported as ``runtime_missing`` --
    except ``CancelledError``, after the child is killed and reaped. ``timeout`` bounds the whole run.
    """
    run_id = secrets.token_hex(4)
    logger.info("Render runtime provisioning %s started (%s)", run_id, trigger)
    started = time.monotonic()
    watcher = _Watcher(app_dir, asyncio.get_running_loop())
    try:
        done, _ = await asyncio.wait({watcher.ended}, timeout=timeout)
    except asyncio.CancelledError:
        stopped = await _stop(watcher)
        logger.info(
            "Render runtime provisioning %s cancelled after %.1f s; the child %s",
            run_id,
            time.monotonic() - started,
            "was stopped" if stopped else "did not exit after the kill",
        )
        raise
    elapsed = time.monotonic() - started
    if not done:
        stopped = await _stop(watcher)
        logger.warning(
            "Render runtime provisioning %s timed out after %.1f s; the child %s",
            run_id,
            elapsed,
            "was stopped" if stopped else "did not exit after the kill",
        )
        return ProvisionRun("timed_out", elapsed)
    ended = watcher.ended.result()
    if ended.error is not None:
        logger.warning(
            "Render runtime provisioning %s did not start after %.1f s: %s", run_id, elapsed, type(ended.error).__name__
        )
        return ProvisionRun("not_started", elapsed)

    last = _last_line(ended.tail, ended.truncated)
    reason = redact(last, app_dir) if last else None
    if ended.returncode == 0:
        logger.info("Render runtime provisioning %s: provisioned in %.1f s", run_id, elapsed)
        return ProvisionRun("provisioned", elapsed)
    if ended.returncode == 3:
        # no official Node.js build for this machine (armv6, armel, musl ...): the fallback methods, as install.sh says
        logger.info(
            "Render runtime provisioning %s: no official Node.js build for this machine after %.1f s (%s); "
            "part thumbnails use the fallback",
            run_id,
            elapsed,
            reason or "exit 3",
        )
        return ProvisionRun("no_build", elapsed, reason)
    logger.warning(
        "Render runtime provisioning %s failed after %.1f s (exit %s): %s",
        run_id,
        elapsed,
        ended.returncode,
        reason or "no message",
    )
    return ProvisionRun("failed", elapsed, reason)
