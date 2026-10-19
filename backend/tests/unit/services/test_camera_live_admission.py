"""Expected admission failures are isolated; unexpected worker errors still escape."""

import asyncio
import logging
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from backend.app import camera_worker
from backend.app.services import camera_worker_live
from backend.app.services.camera_worker_live import LiveAdmissionRejected, LiveProducerRegistry
from backend.app.services.camera_worker_protocol import make_reply, make_request
from backend.app.services.camera_worker_supervisor import CameraWorkerSupervisor, CameraWorkerUnavailable


def _control_harness(monkeypatch, operation, error=None, *, malformed=False):
    bootstrap = SimpleNamespace(control_port=1, generation=str(uuid.uuid4()), secret=b"test-secret")
    sent = []
    writer = SimpleNamespace(close=Mock(), wait_closed=AsyncMock())
    registry = LiveProducerRegistry()
    registry.subscribe = AsyncMock(side_effect=error)
    monkeypatch.setattr(camera_worker_live, "LiveProducerRegistry", lambda: registry)
    monkeypatch.setattr(camera_worker.asyncio, "open_connection", AsyncMock(return_value=(object(), writer)))
    payload = {"identity": str(uuid.uuid4()), "media_session_id": str(uuid.uuid4()), "fps": 5}
    if operation == "subscribe_builtin":
        payload.update(ip_address="127.0.0.1", access_code="private-code", model="P1S")
    else:
        payload.update(url="http://127.0.0.1/frame", camera_type="snapshot")
    if malformed:
        payload.pop("fps")
    request = make_request(
        generation=bootstrap.generation, request_id=str(uuid.uuid4()), operation=operation, payload=payload
    )
    requests = [
        request,
        make_request(generation=bootstrap.generation, request_id=str(uuid.uuid4()), operation="shutdown", payload={}),
    ]

    hello_pending = True

    async def read(_reader):
        nonlocal hello_pending
        if hello_pending:
            hello_pending = False
            return make_reply(generation=bootstrap.generation, request_id=sent[0]["request_id"], ok=True)
        return requests.pop(0)

    async def write(_writer, message):
        sent.append(message)

    monkeypatch.setattr(camera_worker, "read_control", read)
    monkeypatch.setattr(camera_worker, "write_control", write)
    return bootstrap, sent, request, registry, writer


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["subscribe_builtin", "subscribe"])
@pytest.mark.parametrize("reason", ["busy", "subscriber_limit", "producer_limit"])
async def test_worker_replies_once_for_each_expected_live_refusal(monkeypatch, operation, reason):
    bootstrap, sent, request, registry, writer = _control_harness(monkeypatch, operation, LiveAdmissionRejected(reason))
    assert await camera_worker.run(bootstrap) == 0
    assert len(sent) == 3  # hello, refusal, shutdown acknowledgment
    refusal = sent[1]
    assert refusal["request_id"] == request["request_id"]
    assert refusal["generation"] == bootstrap.generation
    assert refusal["payload"] == {"ok": False, "result": {"reason": reason}, "error": "protocol_error"}
    registry.subscribe.assert_awaited_once()
    writer.close.assert_called_once()
    writer.wait_closed.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["subscribe_builtin", "subscribe"])
@pytest.mark.parametrize("error", [RuntimeError("unexpected registry failure"), asyncio.CancelledError()])
async def test_unexpected_admission_errors_are_not_converted_to_busy(monkeypatch, operation, error):
    bootstrap, sent, _request, _registry, writer = _control_harness(monkeypatch, operation, error)
    with pytest.raises(type(error)) as caught:
        await camera_worker.run(bootstrap)
    assert caught.value is error
    assert len(sent) == 1  # no negative reply disguises a bug or cancellation
    writer.close.assert_called_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["subscribe_builtin", "subscribe"])
async def test_invalid_live_payload_retains_protocol_error_without_admission_reason(monkeypatch, operation):
    bootstrap, sent, _request, registry, _writer = _control_harness(monkeypatch, operation, malformed=True)
    assert await camera_worker.run(bootstrap) == 0
    assert sent[1]["payload"] == {"ok": False, "result": {}, "error": "protocol_error"}
    registry.subscribe.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["builtin", "external"])
@pytest.mark.parametrize("reason", ["busy", "subscriber_limit", "producer_limit", None, "private-code\nunsafe", {}])
async def test_parent_cleans_rejected_live_queue_and_logs_only_allowed_reason(monkeypatch, caplog, kind, reason):
    caplog.set_level(logging.WARNING, logger="backend.app.services.camera_worker_supervisor")
    supervisor = CameraWorkerSupervisor(process=SimpleNamespace(returncode=None))
    retained = asyncio.Queue()
    supervisor._live_media_queues["existing-session"] = retained
    request = AsyncMock(return_value={"ok": False, "result": {"reason": reason}, "error": "protocol_error"})
    monkeypatch.setattr(supervisor, "request", request)
    with pytest.raises(CameraWorkerUnavailable, match="rejected.*subscription"):
        if kind == "builtin":
            await supervisor.subscribe_builtin(
                identity=str(uuid.uuid4()), ip_address="127.0.0.1", access_code="private-code", model="P1S", fps=5
            )
        else:
            await supervisor.subscribe_external(
                identity=str(uuid.uuid4()), url="http://127.0.0.1/private-source", camera_type="snapshot", fps=5
            )
    assert supervisor._live_media_queues == {"existing-session": retained}
    logs = [r.getMessage() for r in caplog.records if "live subscription rejected:" in r.getMessage()]
    assert len(logs) == 1
    safe = (
        reason if isinstance(reason, str) and reason in {"busy", "subscriber_limit", "producer_limit"} else "rejected"
    )
    session = request.call_args.args[1]["media_session_id"]
    assert f"kind={kind} session={session} reason={safe} elapsed_ms=" in logs[0]
    assert "private-code" not in logs[0] and "private-source" not in logs[0] and "127.0.0.1" not in logs[0]
