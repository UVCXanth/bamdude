"""Narrow, ownership-neutral filesystem helpers for local worker staging."""

from __future__ import annotations

import shutil
import stat
import time
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class CleanupResult:
    status: str
    path: Path
    error_type: str | None = None
    error_code: int | None = None


def _info(path: Path):
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & getattr(
        stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0
    ):
        raise ValueError("reparse_point")
    return info


def _entries(path: Path) -> list[Path]:
    before = _info(path)
    if not stat.S_ISDIR(before.st_mode):
        raise ValueError("not_directory")
    entries = list(path.iterdir())
    after = _info(path)
    if (before.st_dev, before.st_ino, before.st_mode) != (after.st_dev, after.st_ino, after.st_mode):
        raise ValueError("changed_during_scan")
    return entries


def cleanup_owned(path: Path, *, deadline: float | None = None) -> CleanupResult:
    """Delete only a caller-proven owned root; a failed syscall remains joined."""
    deadline = deadline if deadline is not None else time.monotonic() + 2.0
    last: OSError | ValueError | None = None
    for attempt in range(3):
        try:
            info = _info(path)
            if not stat.S_ISDIR(info.st_mode):
                raise ValueError("not_directory")
            shutil.rmtree(path)
            return CleanupResult("removed", path)
        except FileNotFoundError:
            return CleanupResult("absent", path)
        except (OSError, ValueError) as exc:
            last = exc
        delay = (0.1, 0.3)[attempt] if attempt < 2 else 0
        if not delay or time.monotonic() + delay >= deadline:
            break
        time.sleep(delay)
    assert last is not None
    return CleanupResult(
        "retained_error", path, type(last).__name__, getattr(last, "winerror", None) or getattr(last, "errno", None)
    )


def retained_entries(staging: Path, current: Path, runtime: str) -> list[tuple[Path, str, str]]:
    """Shallow, read-only classification; never inspect payload trees or follow links."""
    findings = []
    try:
        entries = _entries(staging)
    except FileNotFoundError:
        return findings
    except (OSError, ValueError) as exc:
        return [(staging, "unknown", type(exc).__name__)]
    for path in entries:
        if path == current:
            continue
        try:
            if len(path.name) != 32 or any(c not in "0123456789abcdef" for c in path.name):
                findings.append((path, "unknown", "unexpected_name"))
                continue
            if not stat.S_ISDIR(_info(path).st_mode):
                findings.append((path, "unknown", "not_directory"))
                continue
            outcome = _classify_generation(path, runtime)
            findings.append((path, outcome, "known_skeleton" if outcome == "empty_skeleton" else "retained_entries"))
        except FileNotFoundError:
            continue
        except (OSError, ValueError) as exc:
            findings.append((path, "unknown", type(exc).__name__))
    return findings


def _empty_directory(path: Path) -> bool:
    return not _entries(path)


def _classify_generation(root: Path, runtime: str) -> str:
    entries = {entry.name: entry for entry in _entries(root)}
    if set(entries) - {"main", "service"}:
        for entry in entries.values():
            _info(entry)
        return "retained_content"
    if "main" in entries and not _empty_directory(entries["main"]):
        return "retained_content"
    if "service" not in entries:
        return "empty_skeleton"
    service = entries["service"]
    if runtime == "preview":
        return "empty_skeleton" if _empty_directory(service) else "retained_content"
    service_entries = {entry.name: entry for entry in _entries(service)}
    if set(service_entries) - {"cache", "child.ready"}:
        for entry in service_entries.values():
            _info(entry)
        return "retained_content"
    if "cache" in service_entries and not _empty_directory(service_entries["cache"]):
        return "retained_content"
    if "child.ready" in service_entries:
        marker = _info(service_entries["child.ready"])
        if not stat.S_ISREG(marker.st_mode):
            raise ValueError("not_regular_file")
        if not 1 <= marker.st_size <= 32:
            return "retained_content"
    return "empty_skeleton"


_SIDES = ("main", "service")


def _hex32(name: str) -> bool:
    return len(name) == 32 and all(c in "0123456789abcdef" for c in name)


def quarantine_owned(path: Path, quarantine_root: Path, generation: str, side: str) -> CleanupResult:
    """Move ONE proven-dead, caller-owned attempt directory whole into ``<root>/<generation>/<attempt>/<side>``.

    Only a 32-hex attempt directory that is neither a link nor a junction, only onto the same filesystem (one atomic
    rename, never a copy), only under the normalised quarantine root: anything else is ``refused`` and stays where it
    was. Nothing renders or publishes from quarantine; its bytes and count stay inside the limits until reclaimed.
    """
    if not _hex32(path.name) or not _hex32(generation) or side not in _SIDES:
        return CleanupResult("refused", path, "invalid_name")
    try:
        info = _info(path)
        if not stat.S_ISDIR(info.st_mode):
            return CleanupResult("refused", path, "not_directory")
        quarantine_root.mkdir(parents=True, exist_ok=True)
        if _info(quarantine_root).st_dev != info.st_dev:
            return CleanupResult("refused", path, "cross_filesystem")
        parent = quarantine_root / generation / path.name
        parent.mkdir(parents=True, exist_ok=True)
        if quarantine_root.resolve() not in parent.resolve().parents:
            return CleanupResult("refused", path, "outside_root")
        target = parent / side
        path.rename(target)  # atomic on one filesystem; refuses an existing target
        return CleanupResult("quarantined", target)
    except FileNotFoundError:
        return CleanupResult("absent", path)
    except ValueError as exc:  # a link or junction: never followed, never moved
        return CleanupResult("refused", path, str(exc))
    except OSError as exc:
        return CleanupResult(
            "retained_error", path, type(exc).__name__, getattr(exc, "winerror", None) or getattr(exc, "errno", None)
        )


def _quarantined_attempts(quarantine_root: Path) -> list[Path]:
    found = []
    try:
        generations = _entries(quarantine_root)
    except FileNotFoundError:
        return found
    for generation in generations:
        if not _hex32(generation.name):
            continue
        try:
            found += [a for a in _entries(generation) if _hex32(a.name)]
        except (OSError, ValueError):
            continue
    return found


def quarantine_usage(quarantine_root: Path) -> tuple[int, int]:
    """(bytes, attempts) still held in quarantine — what admission counts against the staging limits."""
    total, attempts = 0, _quarantined_attempts(quarantine_root)
    for attempt in attempts:
        stack = [attempt]
        while stack:
            try:
                for entry in _entries(stack.pop()):
                    info = entry.lstat()
                    if stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode):
                        stack.append(entry)
                    else:
                        total += info.st_size
            except (OSError, ValueError):
                continue
    return total, len(attempts)


def reclaim_quarantine(quarantine_root: Path, *, deadline: float | None = None) -> list[CleanupResult]:
    """Bounded retry of every quarantined attempt's removal; empty generation folders go too."""
    deadline = deadline if deadline is not None else time.monotonic() + 2.0
    results = []
    for attempt in _quarantined_attempts(quarantine_root):
        if time.monotonic() >= deadline:
            break
        results.append(cleanup_owned(attempt, deadline=deadline))
    try:
        for generation in _entries(quarantine_root):
            if _hex32(generation.name) and _empty_directory(generation):
                generation.rmdir()
    except (OSError, ValueError):
        pass
    return results


def abandoned_attempts(service_root: Path) -> tuple[list[Path], list[Path]]:
    """List direct attempt directories only after the caller has reaped that service."""
    attempts, unknown = [], []
    try:
        entries = _entries(service_root)
    except FileNotFoundError:
        return attempts, unknown
    except (OSError, ValueError):
        return attempts, [service_root]
    for path in entries:
        if path.name in {"cache", "child.ready"}:
            continue
        try:
            info = _info(path)
            if len(path.name) == 32 and all(c in "0123456789abcdef" for c in path.name) and stat.S_ISDIR(info.st_mode):
                attempts.append(path)
            else:
                unknown.append(path)
        except (OSError, ValueError):
            unknown.append(path)
    return attempts, unknown
