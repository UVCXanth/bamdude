"""A printer that says it has no built-in camera is not asked for a one-shot frame (PR #95, CAM-04 narrow stage).

The printer's own ``print.ipcam.ipcam_dev`` is a tri-state fact on the live client: the string ``"1"`` is a camera,
``"0"`` none, anything else unknown; a delta without the field keeps the last word, and every new connection starts
from unknown. Only an explicit ``"0"`` of the connected client that serves this very printer configuration skips a
NEW built-in one-shot capture — before the worker, the dial and the chamber light. An external camera, a diagnosis
the operator asked for and anything unknown keep their current path. Bambu Studio reads the field the same way
(``DeviceManager.cpp``: ``has_ipcam`` only when present, true by default) and refuses live view on it.
"""

from __future__ import annotations

import logging
from unittest.mock import MagicMock

import pytest

from backend.app.services import camera_capability, camera_light, camera_runtime
from backend.app.services.bambu_mqtt import BambuMQTTClient
from backend.app.services.camera_metrics import CameraCaptureResult

IP, CODE = "192.0.2.10", "12345678"


def _client(ipcam_dev: bool | None = None, *, connected: bool = True) -> BambuMQTTClient:
    client = BambuMQTTClient(ip_address=IP, serial_number="TEST123", access_code=CODE)
    client.state.connected = connected
    client.state.ipcam_dev = ipcam_dev
    return client


def _status(ipcam: dict) -> dict:
    return {"command": "push_status", "ipcam": ipcam}


# --- the fact, from the printer's own status ----------------------------------------------------------------------


@pytest.mark.parametrize("value,expected", [("1", True), ("0", False)])
def test_the_printer_names_its_camera_with_the_strings_one_and_zero(value, expected):
    client = _client()
    client._update_state(_status({"ipcam_dev": value, "ipcam_record": "enable"}))
    assert client.state.ipcam_dev is expected


@pytest.mark.parametrize("value", [0, 1, True, False, None, "", "2", "enable", [], {}], ids=repr)
def test_any_other_value_is_unknown_never_truthiness(value):
    client = _client(False)
    client._update_state(_status({"ipcam_dev": value}))
    assert client.state.ipcam_dev is None


def test_a_delta_without_the_field_keeps_the_last_word():
    client = _client(False)
    client._update_state(_status({"ipcam_record": "disable", "timelapse": "disable"}))
    assert client.state.ipcam_dev is False


def test_a_command_echo_is_no_status():
    client = _client()
    client._update_state({"command": "ipcam_record_set", "ipcam": {"ipcam_dev": "0"}})
    assert client.state.ipcam_dev is None


def test_a_new_connection_starts_from_unknown():
    client = _client(False)
    client._client = MagicMock()
    client._client.subscribe.return_value = (0, 1)
    client._on_connect(client._client, None, None, 0)
    assert client.state.ipcam_dev is None


# --- the one decision, over the live client of this very configuration --------------------------------------------


@pytest.fixture
def live(monkeypatch):
    """``printer_manager.get_client`` answers the client the test puts here."""
    from backend.app.services.printer_manager import printer_manager

    clients: dict[int, BambuMQTTClient] = {}
    monkeypatch.setattr(printer_manager, "get_client", lambda printer_id: clients.get(printer_id))
    return clients


@pytest.mark.parametrize(
    "client,ip,code,skips",
    [
        (lambda: _client(False), IP, CODE, True),
        (lambda: _client(True), IP, CODE, False),
        (lambda: _client(None), IP, CODE, False),
        (lambda: _client(False, connected=False), IP, CODE, False),  # a stale "0" of a lost link
        (lambda: _client(False), "192.0.2.99", CODE, False),  # the printer moved: the fact is the old device's
        (lambda: _client(False), IP, "87654321", False),  # another access code: another configuration
        (lambda: None, IP, CODE, False),  # no client
    ],
    ids=["zero", "one", "unknown", "disconnected", "other-host", "other-code", "no-client"],
)
def test_only_an_explicit_zero_of_the_matching_connected_client_skips(live, client, ip, code, skips):
    made = client()
    if made is not None:
        live[7] = made
    assert camera_capability.skip_builtin_capture(7, ip, code) is skips


def test_the_skip_is_logged_once_per_state_and_again_after_the_camera_came_back(live, caplog):
    caplog.set_level(logging.INFO, logger=camera_capability.logger.name)
    live[7] = client = _client()
    client._update_state(_status({"ipcam_dev": "0"}))
    for _ in range(3):
        assert camera_capability.skip_builtin_capture(7, IP, CODE)
    client._update_state(_status({"ipcam_dev": "1"}))
    assert not camera_capability.skip_builtin_capture(7, IP, CODE)
    client._update_state(_status({"ipcam_dev": "0"}))
    assert camera_capability.skip_builtin_capture(7, IP, CODE)
    messages = [r.getMessage() for r in caplog.records if r.name == camera_capability.logger.name]
    assert len(messages) == 2 and all("builtin_camera_unavailable" in m for m in messages)
    assert all(IP not in m and CODE not in m for m in messages)


# --- the facade: no worker, no dial, no light for an explicit "0" -------------------------------------------------


class _Runtime:
    def __init__(self, frame: bytes | None = b"frame"):
        self.requests: list = []
        self.frame = frame

    async def capture(self, request):
        self.requests.append(request)
        return CameraCaptureResult(self.frame, "fresh" if self.frame else None)


@pytest.fixture
def leases(monkeypatch):
    taken: list = []

    class Lease:
        async def settle(self):
            pass

    async def acquire(printer_id, purpose, *, hold=None):
        taken.append((printer_id, purpose))
        return Lease()

    monkeypatch.setattr(camera_light, "acquire", acquire)
    monkeypatch.setattr(camera_light, "release", lambda lease: None)
    return taken


def _builtin(purpose="snapshot", printer_id=7):
    return camera_runtime.CameraCaptureRequest.builtin(
        ip_address=IP, access_code=CODE, model="A2L", purpose=purpose, printer_id=printer_id
    )


async def test_an_explicit_zero_skips_the_worker_and_the_light(live, leases):
    live[7] = _client(False)
    runtime = _Runtime()
    with camera_runtime.override_camera_runtime(runtime):
        result = await camera_runtime.capture(_builtin("finish_photo"))
    assert (result.frame, result.source) == (None, None)
    assert runtime.requests == [] and leases == []


@pytest.mark.parametrize("state", [True, None], ids=["one", "unknown"])
async def test_a_camera_or_an_unknown_keeps_the_current_capture(live, leases, state):
    live[7] = _client(state)
    runtime = _Runtime()
    with camera_runtime.override_camera_runtime(runtime):
        assert (await camera_runtime.capture(_builtin("plate_check"))).frame == b"frame"
    assert len(runtime.requests) == 1 and leases == [(7, "plate_check")]


async def test_a_diagnosis_the_operator_asked_for_still_tries(live, leases):
    live[7] = _client(False)
    runtime = _Runtime(frame=None)
    with camera_runtime.override_camera_runtime(runtime):
        await camera_runtime.capture(_builtin("diagnose"))
    assert len(runtime.requests) == 1  # one real attempt, its own result


async def test_a_request_that_names_no_printer_is_never_guessed_by_address(live, leases):
    live[7] = _client(False)
    runtime = _Runtime()
    with camera_runtime.override_camera_runtime(runtime):
        assert (await camera_runtime.capture(_builtin(printer_id=None))).frame == b"frame"
    assert len(runtime.requests) == 1


@pytest.mark.parametrize("printer_id", [7, None])
async def test_an_external_camera_does_not_follow_the_builtin_fact(live, leases, printer_id):
    live[7] = _client(False)
    runtime = _Runtime()
    request = camera_runtime.CameraCaptureRequest.external(
        url="http://cam.local/stream", camera_type="mjpeg", purpose="obico", printer_id=printer_id
    )
    with camera_runtime.override_camera_runtime(runtime):
        assert (await camera_runtime.capture(request)).frame == b"frame"
    assert len(runtime.requests) == 1


async def test_the_camera_coming_back_restores_the_capture(live, leases):
    live[7] = client = _client(False)
    runtime = _Runtime()
    with camera_runtime.override_camera_runtime(runtime):
        assert (await camera_runtime.capture(_builtin())).frame is None
        client._update_state(_status({"ipcam_dev": "1"}))
        assert (await camera_runtime.capture(_builtin())).frame == b"frame"
    assert len(runtime.requests) == 1
