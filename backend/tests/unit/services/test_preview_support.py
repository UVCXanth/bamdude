"""A test that needs a working preview runtime starts it through ``preview_support.started``: ``start()`` answers
after its FIRST attempt by design (first-start recovery), and on a loaded runner that attempt can time out creating
the broker's store — the retry then runs in the background while a fixture already reads ``runtime.service``
(STEP Preview Smoke win-x64-cp312, CI 39126040756)."""

from __future__ import annotations

import asyncio

import pytest

from backend.app.services import preview_runtime as r
from backend.tests import preview_support
from backend.tests.preview_support import started


def _first_store_fails(monkeypatch) -> asyncio.Event:
    """The first attempt's store_create times out (its cleanup proven), the retry waits a pause long enough to end
    the helper's wait before it: the background starter is still pending when the helper gives up."""
    from nats.js.client import JetStreamContext

    real = JetStreamContext.create_object_store
    failed = asyncio.Event()

    async def once(self, *args, **kwargs):
        if not failed.is_set():
            failed.set()
            raise TimeoutError
        return await real(self, *args, **kwargs)

    monkeypatch.setattr(JetStreamContext, "create_object_store", once)
    monkeypatch.setattr(r, "STARTUP_PAUSES", (0.4, 0.4))
    return failed


async def _first_answer(rt) -> None:
    """start() has answered: its first attempt is over and its cleanup done, the retry not yet begun."""
    async with asyncio.timeout(15):
        while rt.phase != "cleanup" or rt.nc is not None:
            await asyncio.sleep(0.001)
    await asyncio.sleep(0.06)


@pytest.mark.asyncio
@pytest.mark.parametrize("end", ["timeout", "cancel", "cancel_twice"])
async def test_a_wait_that_ends_without_ready_stops_its_runtime(tmp_path, monkeypatch, end):
    """Codex B-A-R1: a fixture awaits started() before its own try/finally, so the helper owns the runtime until it
    answers ready. A wait that times out or is cancelled — twice, the second time during the stop — stops it: no
    background starter is left to launch a service after the test gave up."""
    failed = _first_store_fails(monkeypatch)
    if end == "timeout":
        monkeypatch.setattr(preview_support, "_budget", lambda: 0.02)
    rt = r.PreviewRuntime(tmp_path / "preview")
    waiter = asyncio.create_task(started(rt))
    try:
        if end != "timeout":
            await asyncio.wait_for(failed.wait(), 15)
            await _first_answer(rt)
            waiter.cancel()
            if end == "cancel_twice":
                await asyncio.sleep(0)
                waiter.cancel()
        with pytest.raises(AssertionError if end == "timeout" else asyncio.CancelledError):
            await waiter
        assert rt.closed and (rt.starter is None or rt.starter.done()) and rt.service is None
    finally:
        if not waiter.done():
            waiter.cancel()
        await asyncio.gather(waiter, return_exceptions=True)
        await rt.stop()


@pytest.mark.asyncio
async def test_a_runtime_whose_first_attempt_timed_out_is_waited_for(tmp_path, monkeypatch):
    from nats.js.client import JetStreamContext

    monkeypatch.setattr(r, "STARTUP_PAUSES", (0.05, 0.05))
    real = JetStreamContext.create_object_store
    calls = []

    async def slow_once(self, *args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            raise TimeoutError  # the runner's store_create past its budget
        return await real(self, *args, **kwargs)

    monkeypatch.setattr(JetStreamContext, "create_object_store", slow_once)
    bare = r.PreviewRuntime(tmp_path / "bare")
    try:
        await bare.start()
        assert bare.health().state != "ready"  # what the fixtures used to read right here
    finally:
        await bare.stop()
    calls.clear()
    rt = r.PreviewRuntime(tmp_path / "waited")
    try:
        assert await started(rt) is rt
        assert rt.health().state == "ready" and rt.service is not None and len(calls) >= 2
    finally:
        await rt.stop()


@pytest.mark.asyncio
async def test_a_runtime_that_never_starts_fails_with_its_state(tmp_path, monkeypatch):
    from nats.js.client import JetStreamContext

    monkeypatch.setattr(r, "STARTUP_PAUSES", (0.05, 0.05))

    async def never(self, *args, **kwargs):
        raise TimeoutError

    monkeypatch.setattr(JetStreamContext, "create_object_store", never)
    rt = r.PreviewRuntime(tmp_path / "never")
    try:
        with pytest.raises(AssertionError, match="startup_failed"):
            await started(rt)  # every attempt ended: an answer at once, not the whole wait
    finally:
        await rt.stop()
