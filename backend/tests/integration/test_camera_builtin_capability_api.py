"""``/camera/snapshot`` and a printer that says it has no built-in camera (PR #95, CAM-04 narrow stage).

The route takes the chamber light itself and builds its fresh request without a printer, so it asks the same
decision as the capture facade — before its own light lease. An explicit ``"0"`` still serves a live buffer or a
recent cached frame, by the bytes chosen before any wait; without one it answers the current 503 with no lease, no
worker and no temp file. An external camera is untouched.
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient

from backend.app.api.routes import camera
from backend.app.services import camera_light, camera_runtime
from backend.app.services.bambu_mqtt import BambuMQTTClient
from backend.app.services.camera_metrics import CameraCaptureResult
from backend.tests.integration.test_camera_api import _clear_snapshot_cache, _inject_camera_stream_token  # noqa: F401

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]


class _Runtime:
    def __init__(self):
        self.requests: list = []

    async def capture(self, request):
        self.requests.append(request)
        return CameraCaptureResult(b"\xff\xd8fresh", "fresh")


@pytest.fixture
def farm(monkeypatch):
    """The live clients, the runtime and every light lease the route takes or lets go."""
    from backend.app.services.printer_manager import printer_manager

    clients: dict[int, BambuMQTTClient] = {}
    runtime = _Runtime()
    events: list = []
    settle_hooks: list = []

    class Lease:
        async def settle(self):
            for hook in settle_hooks:
                hook()

    async def acquire(printer_id, purpose, *, hold=None):
        events.append(("acquire", printer_id, purpose))
        return Lease()

    monkeypatch.setattr(printer_manager, "get_client", lambda printer_id: clients.get(printer_id))
    monkeypatch.setattr(camera_runtime, "get_camera_runtime", lambda: runtime)
    monkeypatch.setattr(camera_light, "acquire", acquire)
    monkeypatch.setattr(camera_light, "release", lambda lease: events.append(("release",)))
    return clients, runtime, events, settle_hooks


def _live(printer, ipcam_dev: bool | None) -> BambuMQTTClient:
    client = BambuMQTTClient(
        ip_address=printer.ip_address, serial_number=printer.serial_number, access_code=printer.access_code
    )
    client.state.connected = True
    client.state.ipcam_dev = ipcam_dev
    return client


@pytest.mark.parametrize("poll", [None, 2000])
async def test_no_builtin_camera_and_nothing_to_reuse_is_503_without_light_or_worker(
    async_client: AsyncClient, printer_factory, farm, poll
):
    clients, runtime, events, _ = farm
    printer = await printer_factory()
    clients[printer.id] = _live(printer, False)
    params = {"poll": poll} if poll else {}
    response = await async_client.get(f"/api/v1/printers/{printer.id}/camera/snapshot", params=params)
    assert response.status_code == 503
    assert "Failed to capture camera frame" in response.json()["detail"]
    assert runtime.requests == [] and events == []  # no lease taken, none touched


@pytest.mark.parametrize("state", [True, None], ids=["one", "unknown"])
async def test_a_camera_or_an_unknown_still_captures(async_client: AsyncClient, printer_factory, farm, state):
    clients, runtime, events, _ = farm
    printer = await printer_factory()
    clients[printer.id] = _live(printer, state)
    response = await async_client.get(f"/api/v1/printers/{printer.id}/camera/snapshot")
    assert response.status_code == 200 and response.content == b"\xff\xd8fresh"
    assert len(runtime.requests) == 1 and events[0] == ("acquire", printer.id, "snapshot")


async def test_an_external_camera_is_untouched(async_client: AsyncClient, printer_factory, farm):
    clients, runtime, _, _ = farm
    printer = await printer_factory(
        external_camera_enabled=True, external_camera_url="http://cam.local/stream", external_camera_type="mjpeg"
    )
    clients[printer.id] = _live(printer, False)
    response = await async_client.get(f"/api/v1/printers/{printer.id}/camera/snapshot")
    assert response.status_code == 200
    assert [r.kind for r in runtime.requests] == ["external"]


async def test_a_live_buffer_is_still_served(async_client: AsyncClient, printer_factory, farm, monkeypatch):
    clients, runtime, events, _ = farm
    printer = await printer_factory()
    clients[printer.id] = _live(printer, False)
    monkeypatch.setattr(camera, "try_get_active_buffered_frame", lambda printer_id: b"\xff\xd8buffered")
    response = await async_client.get(f"/api/v1/printers/{printer.id}/camera/snapshot", params={"poll": 2000})
    assert response.status_code == 200 and response.content == b"\xff\xd8buffered"
    assert runtime.requests == [] and events[0] == ("acquire", printer.id, "snapshot")  # the current light policy


async def test_a_cached_frame_that_expires_during_the_light_wait_is_still_the_answer(
    async_client: AsyncClient, printer_factory, farm
):
    clients, runtime, _, settle_hooks = farm
    printer = await printer_factory()
    clients[printer.id] = _live(printer, False)
    camera._remember_snapshot(printer.id, b"\xff\xd8cached")
    settle_hooks.append(lambda: (camera._snapshot_frames.clear(), camera._snapshot_frame_times.clear()))
    response = await async_client.get(f"/api/v1/printers/{printer.id}/camera/snapshot")
    assert response.status_code == 200 and response.content == b"\xff\xd8cached"
    assert runtime.requests == []  # never the forbidden fresh capture
