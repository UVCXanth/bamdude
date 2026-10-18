"""Starting a preview runtime in a test that needs it working.

``PreviewRuntime.start()`` answers once its FIRST attempt has ended (first-start recovery): on a loaded runner that
attempt can run past a phase's budget — the broker's store took longer than its timeout on a GitHub Windows runner —
and the next attempt follows in the background. A fixture that reads ``runtime.service`` right after ``start()``
then reads ``None``. ``started`` waits for the runtime's own "ready", and answers at once when every attempt has
ended without it."""

from __future__ import annotations

import asyncio
import time

from backend.app.services import preview_runtime as r
from backend.app.services.preview_artifacts import owned


def _budget() -> float:
    # Every attempt's ready wait and the pauses between them, with room for a slow broker on a loaded runner.
    return r.STARTUP_ATTEMPTS * (r.READY_SECONDS + 10.0) + sum(r.STARTUP_PAUSES)


async def started(runtime):
    """``runtime.start()``, then wait until it is ready; an AssertionError naming its state otherwise.

    The runtime is this helper's until it answers ready: a caller awaits it before its own try/finally. Any other end
    — the AssertionError, the wait's cancellation — stops the runtime first, through ``owned`` so a second
    cancellation cannot cut the stop short, or a background starter would launch a service after the test gave up
    (Codex B-A-R1)."""
    try:
        await runtime.start()
        deadline = time.monotonic() + _budget()
        while runtime.health().state != "ready":
            starter = runtime.starter
            if (starter is not None and starter.done()) or time.monotonic() > deadline:
                raise AssertionError(f"the preview runtime did not start: {runtime.health()}")
            await asyncio.sleep(0.05)
    except BaseException:
        await owned(runtime.stop())
        raise
    return runtime
