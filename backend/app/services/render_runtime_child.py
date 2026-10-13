"""The parent side of ``render_runtime provision``: one runner, one parent log (inv-local-microservice-parent-log).

Every caller in the app -- the in-app update today -- runs the CHECKED-OUT module of the install in a child process,
because the running process may hold older code and an older pin. The parent logs a start, exactly one outcome with
its elapsed time and the run's id, and a reason that is bounded and never names the install (implementation
consilium 2026-10-13, NL-I-R1 / NL-I-M1). The child's stdout is not read; its stderr is drained to EOF and only its
tail is kept, so a noisy child can neither block on a full pipe nor fill the parent's memory or log.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import secrets
import sys
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


def redact(line: str, app_dir: PurePath) -> str:
    """One line of the child's stderr, fit for the parent log.

    Every spelling of the install path becomes ``<install>``: as given, resolved, with forward slashes, and as
    ``str(OSError)`` quotes a filename -- with ``repr()``, which doubles every Windows backslash. Windows paths match
    in any case. Control characters become spaces; the result is at most ``REASON_CHARS`` long.
    """
    paths = [app_dir]
    if isinstance(app_dir, Path):
        with contextlib.suppress(OSError, RuntimeError):
            paths.append(app_dir.resolve())
    plain = {spelling for p in paths for spelling in (str(p), p.as_posix())}
    spellings = plain | {repr(s)[1:-1] for s in plain}
    flags = re.IGNORECASE if isinstance(app_dir, PureWindowsPath) else 0
    for spelling in sorted(filter(None, spellings), key=len, reverse=True):
        line = re.sub(re.escape(spelling), "<install>", line, flags=flags)
    line = "".join(ch if ch.isprintable() else " " for ch in line).strip()
    return line if len(line) <= REASON_CHARS else line[: REASON_CHARS - 1] + "…"


def _last_line(tail: bytes, truncated: bool) -> str | None:
    text = tail.decode("utf-8", "replace").rstrip()
    before, newline, last = text.rpartition("\n")
    if truncated and not newline:
        # the line began before the kept tail: its head -- where a path would sit -- is gone, so it says nothing safe
        return f"(the child's last line is longer than {STDERR_TAIL} bytes)"
    return last.strip() or None


async def _drain(stream: asyncio.StreamReader) -> tuple[bytes, bool]:
    """Read to EOF, keeping the last ``STDERR_TAIL`` bytes and whether anything before them was dropped."""
    tail = bytearray()
    truncated = False
    while chunk := await stream.read(_READ):
        tail += chunk
        if len(tail) > STDERR_TAIL:
            del tail[: len(tail) - STDERR_TAIL]
            truncated = True
    return bytes(tail), truncated


async def _finish(process: asyncio.subprocess.Process) -> tuple[bytes, bool]:
    said = await _drain(process.stderr)
    await process.wait()
    return said


async def _stop(process: asyncio.subprocess.Process, finished: asyncio.Future) -> bool:
    """Kill the child and wait for it to be reaped (its stderr still drains); ``True`` once it is."""
    with contextlib.suppress(ProcessLookupError):
        if process.returncode is None:
            process.kill()
    try:
        await asyncio.wait({finished}, timeout=KILL_WAIT)
    finally:
        if not finished.done():
            finished.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await finished
    return process.returncode is not None


async def run_provision(app_dir: Path, *, trigger: str, timeout: float | None = None) -> ProvisionRun:
    """``python -m backend.app.services.render_runtime provision --runtime <app_dir>/runtime`` in ``app_dir``.

    Never raises for the child's sake -- a missing runtime is a missing feature, reported as ``runtime_missing`` --
    except ``CancelledError``, after the child is killed and reaped. ``timeout`` bounds the whole run.
    """
    run_id = secrets.token_hex(4)
    logger.info("Render runtime provisioning %s started (%s)", run_id, trigger)
    started = time.monotonic()
    try:
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "backend.app.services.render_runtime",
            "provision",
            "--runtime",
            str(app_dir / "runtime"),
            cwd=str(app_dir),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
    except OSError as exc:
        elapsed = time.monotonic() - started
        logger.warning(
            "Render runtime provisioning %s did not start after %.1f s: %s", run_id, elapsed, type(exc).__name__
        )
        return ProvisionRun("not_started", elapsed)

    finished = asyncio.ensure_future(_finish(process))
    try:
        done, _ = await asyncio.wait({finished}, timeout=timeout)
    except asyncio.CancelledError:
        stopped = await _stop(process, finished)
        logger.info(
            "Render runtime provisioning %s cancelled after %.1f s; the child %s",
            run_id,
            time.monotonic() - started,
            "was stopped" if stopped else "did not exit after the kill",
        )
        raise
    elapsed = time.monotonic() - started
    if not done:
        stopped = await _stop(process, finished)
        logger.warning(
            "Render runtime provisioning %s timed out after %.1f s; the child %s",
            run_id,
            elapsed,
            "was stopped" if stopped else "did not exit after the kill",
        )
        return ProvisionRun("timed_out", elapsed)

    last = _last_line(*finished.result())
    reason = redact(last, app_dir) if last else None
    if process.returncode == 0:
        logger.info("Render runtime provisioning %s: provisioned in %.1f s", run_id, elapsed)
        return ProvisionRun("provisioned", elapsed)
    if process.returncode == 3:
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
        process.returncode,
        reason or "no message",
    )
    return ProvisionRun("failed", elapsed, reason)
