import asyncio
from unittest.mock import Mock

import pytest

from backend.app.services.camera_worker_live import (
    LIVE_STREAM_ENDED,
    MAX_LIVE_FRAME_BYTES,
    LiveExternalSubscription,
    LiveProducerRegistry,
)


@pytest.mark.asyncio
@pytest.mark.parametrize("reason", ["raw", "probe", "subscriber_limit", "producer_limit"])
async def test_live_admission_refuses_without_changing_existing_owners(monkeypatch, reason):
    import backend.app.services.camera_worker_live as module

    monkeypatch.setattr(module, "MAX_LIVE_SUBSCRIBERS", 1)
    registry = LiveProducerRegistry()
    leases = []
    raw = None

    async def producer():
        await asyncio.Event().wait()

    factory = Mock(side_effect=producer)
    identity = "rejected"
    try:
        if reason == "raw":
            raw = await registry.acquire_raw(identity)
        elif reason == "probe":
            assert await registry.acquire_probe(identity)
        else:
            owner = identity if reason == "subscriber_limit" else "other"
            lease, _queue = await registry.subscribe(owner, factory)
            leases.append(lease)
            await asyncio.sleep(0)
        before = (
            dict(registry._producers),
            {key: dict(value) for key, value in registry._subscribers.items()},
            dict(registry._raw_leases),
            set(registry._probe_leases),
        )
        factory.reset_mock()
        with pytest.raises(RuntimeError) as caught:
            await registry.subscribe(identity, factory)
        assert type(caught.value).__name__ == "LiveAdmissionRejected"
        assert caught.value.reason == ("busy" if reason in {"raw", "probe"} else reason)
        factory.assert_not_called()
        assert before == (
            registry._producers,
            registry._subscribers,
            registry._raw_leases,
            registry._probe_leases,
        )

        if raw:
            await registry.release_raw(raw)
        await registry.release_probe(identity)
        for lease in leases:
            await registry.unsubscribe(lease)
        leases.clear()
        lease, _queue = await registry.subscribe(identity, factory)
        leases.append(lease)
        factory.assert_called_once()
    finally:
        if raw:
            await registry.release_raw(raw)
        await registry.release_probe(identity)
        for lease in leases:
            await registry.unsubscribe(lease)


@pytest.mark.asyncio
async def test_live_registry_starts_one_producer_and_drops_stale_subscriber_frame():
    registry = LiveProducerRegistry()
    starts = 0
    stopped = asyncio.Event()

    async def producer():
        nonlocal starts
        starts += 1
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()

    first, first_queue = await registry.subscribe("rtsp://camera", producer)
    second, second_queue = await registry.subscribe("rtsp://camera", producer)
    await asyncio.sleep(0)
    assert starts == 1
    registry.publish("rtsp://camera", b"old")
    registry.publish("rtsp://camera", b"new")
    assert await first_queue.get() == b"new"
    assert await second_queue.get() == b"new"
    await registry.unsubscribe(first)
    assert not stopped.is_set()
    await registry.unsubscribe(second)
    await asyncio.wait_for(stopped.wait(), timeout=1)


def test_live_subscription_rejects_invalid_or_credential_leaking_input():
    subscription = LiveExternalSubscription(
        identity="00000000-0000-4000-8000-000000000001",
        media_session_id="00000000-0000-4000-8000-000000000002",
        url="rtsp://operator:secret@camera.example/live",
        camera_type="rtsp",
        fps=5,
    )
    assert "operator:secret" not in repr(subscription)


@pytest.mark.asyncio
async def test_raw_lease_and_live_producer_are_mutually_exclusive():
    registry = LiveProducerRegistry()
    raw = await registry.acquire_raw("camera-a")
    with pytest.raises(RuntimeError, match="raw lease"):
        await registry.subscribe("camera-a", lambda: asyncio.sleep(0))
    await registry.release_raw(raw)
    live, _queue = await registry.subscribe("camera-a", lambda: asyncio.sleep(0.1))
    with pytest.raises(RuntimeError, match="busy"):
        await registry.acquire_raw("camera-a")
    await registry.unsubscribe(live)


@pytest.mark.asyncio
async def test_tcp_probe_reserves_the_identity_without_displacing_a_viewer():
    registry = LiveProducerRegistry()
    assert await registry.acquire_probe("camera-a")
    assert await registry.is_busy("camera-a")
    assert not await registry.acquire_probe("camera-a")
    with pytest.raises(RuntimeError, match="raw lease"):
        await registry.subscribe("camera-a", lambda: asyncio.sleep(0))
    with pytest.raises(RuntimeError, match="busy"):
        await registry.acquire_raw("camera-a")
    await registry.release_probe("camera-a")
    live, _queue = await registry.subscribe("camera-a", lambda: asyncio.sleep(0.1))
    assert not await registry.acquire_probe("camera-a")
    await registry.unsubscribe(live)


@pytest.mark.asyncio
async def test_live_registry_waits_for_last_producer_cleanup_and_notifies_subscribers():
    registry = LiveProducerRegistry()
    cleanup_complete = asyncio.Event()

    async def producer():
        try:
            await asyncio.Event().wait()
        finally:
            await asyncio.sleep(0)
            cleanup_complete.set()

    lease, _queue = await registry.subscribe("camera-a", producer)
    await asyncio.sleep(0)
    await registry.unsubscribe(lease)
    assert cleanup_complete.is_set()

    # A producer that ends independently wakes its worker forwarder instead of
    # leaving it blocked forever on an empty per-subscriber queue.
    release = asyncio.Event()

    async def ending_producer():
        await release.wait()

    _lease, ended_queue = await registry.subscribe("camera-b", ending_producer)
    release.set()
    assert await asyncio.wait_for(ended_queue.get(), timeout=1) == LIVE_STREAM_ENDED


@pytest.mark.asyncio
async def test_independent_producer_releases_can_join_in_parallel():
    registry = LiveProducerRegistry()
    both_cleaning = asyncio.Event()
    release_cleanup = asyncio.Event()
    started = set()

    async def producer(identity):
        try:
            await asyncio.Event().wait()
        finally:
            started.add(identity)
            if len(started) == 2:
                both_cleaning.set()
            await release_cleanup.wait()

    first, _ = await registry.subscribe("camera-a", lambda: producer("a"))
    second, _ = await registry.subscribe("camera-b", lambda: producer("b"))
    shared, _ = await registry.subscribe("camera-a", lambda: producer("should-not-start"))
    await asyncio.sleep(0)
    await registry.unsubscribe(first)
    assert not started
    tasks = [asyncio.create_task(registry.unsubscribe(lease)) for lease in (shared, second)]
    await asyncio.wait_for(both_cleaning.wait(), 1)
    assert started == {"a", "b"}
    release_cleanup.set()
    await asyncio.gather(*tasks)


@pytest.mark.asyncio
async def test_live_registry_drops_a_frame_over_the_process_memory_budget():
    registry = LiveProducerRegistry()
    stopped = asyncio.Event()

    async def producer():
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()

    lease, queue = await registry.subscribe("camera-a", producer)
    registry.publish("camera-a", b"x" * (MAX_LIVE_FRAME_BYTES + 1))
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(queue.get(), timeout=0.05)
    await registry.unsubscribe(lease)
    await asyncio.wait_for(stopped.wait(), timeout=1)
