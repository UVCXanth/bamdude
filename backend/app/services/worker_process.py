"""Small process-tree ownership helpers shared by local worker supervisors."""

from __future__ import annotations

import os
import signal

import psutil


def descendants(pid: int) -> list[psutil.Process]:
    try:
        return psutil.Process(pid).children(recursive=True)
    except psutil.NoSuchProcess:
        return []


def kill_owned_group(pid: int) -> bool:
    """Kill only a process group created by our own start_new_session spawn."""
    if os.name == "nt":
        raise RuntimeError("POSIX process groups are unavailable on Windows")
    try:
        os.killpg(pid, signal.SIGKILL)
        return True
    except ProcessLookupError:
        return False


def descendants_reaped(children: list[psutil.Process], *, timeout: float = 5) -> bool:
    def stopped(process: psutil.Process) -> bool:
        try:
            # A container without an init may leave an orphaned child as a
            # zombie. It has exited and cannot run, even if PID 1 never waits.
            return process.status() == psutil.STATUS_ZOMBIE
        except psutil.NoSuchProcess:
            return True

    _, alive = psutil.wait_procs([child for child in children if not stopped(child)], timeout=timeout)
    return all(stopped(child) for child in alive)
