"""The one synchronous compare-and-clear of a finished run's in-process context (spec printer-runtime-stall r3 R7).

Everything is checked first, then everything is changed -- or nothing is. Synchronous on the app loop: no await,
no callback and no physical command between the last check and the last change, so no start, terminal or
dispatch of another run can interleave. What it removes is exactly: the run's binding, its processed start
admission, and the two per-printer registrations dispatch made for it (R7a). It marks the run's terminal as
handled so a late one is a duplicate, and advances nothing. Finishing leases, start resolutions, buffered
terminals, live macro tasks, accounting and every durable record are left to their owners.

The caller (``print_state_recovery_store``) proves every other precondition before; this closes the last window.
"""

from __future__ import annotations

from dataclasses import dataclass

from backend.app import main
from backend.app.services.print_run_binding import (
    RunContextExpectation,
    capture_runtime_context,
    release_runtime_context,
    runtime_context_unchanged,
)


@dataclass(frozen=True)
class ReleaseExpectation:
    run: RunContextExpectation
    config: tuple


def capture(manager, printer_id: int) -> ReleaseExpectation | None:
    """What a release would remove, as it is now; ``None`` when the printer holds no run."""
    run = capture_runtime_context(manager, printer_id)
    if run is None:
        return None
    return ReleaseExpectation(run, main.capture_run_config(printer_id))


def release(manager, expected: ReleaseExpectation) -> bool:
    """Remove exactly what ``expected`` names when nothing of it changed; True only when everything went."""
    pid = expected.run.printer_id
    if not runtime_context_unchanged(manager, expected.run) or not main.run_config_unchanged(pid, expected.config):
        return False
    release_runtime_context(manager, expected.run)
    main.release_run_config(pid, expected.config)
    return True
