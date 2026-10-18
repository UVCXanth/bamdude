"""A test that needs a working preview runtime starts it through ``preview_support.started``: ``start()`` answers
after its FIRST attempt by design (first-start recovery), and on a loaded runner that attempt can time out creating
the broker's store — the retry then runs in the background while a fixture already reads ``runtime.service``
(STEP Preview Smoke win-x64-cp312, CI 39126040756)."""

from __future__ import annotations

import pytest

from backend.app.services import preview_runtime as r
from backend.tests.preview_support import started


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
