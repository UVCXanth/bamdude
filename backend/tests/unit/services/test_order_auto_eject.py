"""Synthetic orders and camera faults; no printer connection or physical G-code."""

import asyncio
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from backend.app.models.project import Project
from backend.app.services.filament_routing import RoutingDeferred
from backend.app.services.order_auto_eject import archive_mode, automatic_predecessor, dispatch_check, snapshot
from backend.app.services.plate_detection import PlateDetectionResult
from backend.app.services.printer_manager import printer_manager


@pytest.mark.asyncio
async def test_order_changes_only_new_jobs_and_copies_keep_their_mode(db_session):
    a, b = Project(name="Product A order", auto_eject_enabled=True), Project(name="Product B order")
    db_session.add_all([a, b])
    await db_session.commit()
    queued = await snapshot(db_session, project_id=a.id)
    assert queued is True
    assert await snapshot(db_session, project_id=b.id) is False
    a.auto_eject_enabled = False
    await db_session.commit()
    assert await snapshot(db_session, project_id=a.id) is False
    assert await snapshot(db_session, project_id=a.id, preserve=True, inherited=queued) is True
    assert await snapshot(db_session, project_id=None) is False


@pytest.fixture
async def held(db_session, printer_factory, archive_factory, monkeypatch):
    p = await printer_factory(model="A1M", require_plate_clear=True)
    archive = await archive_factory(p.id, extra_data={"dispatch_intent": {"submission_id": "42", "auto_eject": True}})
    p.awaiting_plate_clear = True
    p.awaiting_plate_clear_archive_id = archive.id
    p.awaiting_plate_clear_token = "synthetic-token"
    await db_session.commit()
    state = SimpleNamespace(connected=True, state="FINISH", subtask_id="42", connection_generation=1)
    monkeypatch.setattr(printer_manager, "peek_status", lambda _pid: (state, time.monotonic(), False))
    return p, archive, state


@pytest.mark.asyncio
@pytest.mark.parametrize("previous_mode,status", [(False, "completed"), (True, "failed"), (True, "cancelled")])
async def test_new_auto_flag_never_answers_normal_or_failed_predecessor(
    db_session, held, monkeypatch, previous_mode, status
):
    p, archive, _ = held
    archive.status = status
    archive.extra_data = {"dispatch_intent": {"auto_eject": previous_mode, "submission_id": "42"}}
    await db_session.commit()
    camera = AsyncMock()
    monkeypatch.setattr("backend.app.services.plate_detection.check_plate_empty", camera)
    publish = Mock()
    with pytest.raises(RoutingDeferred, match="plate_manual_inspection"):
        await dispatch_check(
            db_session, SimpleNamespace(options={"auto_eject": True}), p, AsyncMock(), lambda _job: None
        )
        publish()
    camera.assert_not_awaited()
    publish.assert_not_called()
    assert p.awaiting_plate_clear is True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "kind,calibration,reason",
    [
        ("occupied", False, "plate_objects_detected"),
        ("unavailable", False, "plate_check_unavailable"),
        ("unavailable", True, "plate_calibration_required"),
    ],
)
async def test_failed_photo_keeps_gate_and_never_publishes(db_session, held, monkeypatch, kind, calibration, reason):
    p, _, _ = held
    camera = AsyncMock(
        return_value=PlateDetectionResult(False, 0, 0, "Synthetic", status=kind, needs_calibration=calibration)
    )
    monkeypatch.setattr("backend.app.services.plate_detection.check_plate_empty", camera)
    answer = AsyncMock()
    monkeypatch.setattr("backend.app.services.plate_answers.answer_plate_run", answer)
    publish = Mock()
    with pytest.raises(RoutingDeferred, match=reason):
        await dispatch_check(
            db_session, SimpleNamespace(options={"auto_eject": False}), p, AsyncMock(), lambda _job: None
        )
        publish()
    assert camera.await_args.kwargs["fresh"] is True
    answer.assert_not_awaited()
    publish.assert_not_called()
    assert p.awaiting_plate_clear is True


@pytest.mark.asyncio
async def test_successful_auto_predecessor_is_photographed_before_ordinary_next_job(db_session, held, monkeypatch):
    p, archive, _ = held
    events = []

    async def camera(**kwargs):
        events.append("photo")
        return PlateDetectionResult(True, 0, 0, "Synthetic clear")

    async def answer(*args, **kwargs):
        assert kwargs["expected_archive_id"] == archive.id
        assert kwargs["expected_gate_token"] == "synthetic-token"
        events.append("answer-exact-run")

    monkeypatch.setattr("backend.app.services.plate_detection.check_plate_empty", camera)
    monkeypatch.setattr("backend.app.services.plate_answers.answer_plate_run", answer)
    await dispatch_check(db_session, SimpleNamespace(options={"auto_eject": False}), p, AsyncMock(), lambda _job: None)
    events.append("publish-once")
    assert events == ["photo", "answer-exact-run", "publish-once"]


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["connection", "disconnect", "external-start", "gate-token", "cancel"])
async def test_context_change_during_photo_invalidates_permission(db_session, held, monkeypatch, change):
    p, _, state = held
    started, finish = asyncio.Event(), asyncio.Event()

    async def camera(**kwargs):
        started.set()
        await finish.wait()
        return PlateDetectionResult(True, 0, 0, "Clear")

    monkeypatch.setattr("backend.app.services.plate_detection.check_plate_empty", camera)
    answer = AsyncMock()
    monkeypatch.setattr("backend.app.services.plate_answers.answer_plate_run", answer)
    cancelled = False

    def check_cancel(_job):
        if cancelled:
            raise RoutingDeferred("dispatch_claim_changed")

    task = asyncio.create_task(
        dispatch_check(db_session, SimpleNamespace(options={"auto_eject": True}), p, AsyncMock(), check_cancel)
    )
    await started.wait()
    if change == "connection":
        state.connection_generation += 1
    elif change == "disconnect":
        state.connected = False
    elif change == "external-start":
        state.state, state.subtask_id = "RUNNING", "another-run"
    elif change == "gate-token":
        p.awaiting_plate_clear_token = "newer-token"
        await db_session.commit()
    else:
        cancelled = True
    finish.set()
    with pytest.raises(RoutingDeferred):
        await task
    answer.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "live_state,submission,stale",
    [("IDLE", "42", False), ("FAILED", "42", False), ("FINISH", "other", False), ("FINISH", "42", True)],
)
async def test_recovered_gate_requires_matching_fresh_success(
    db_session, held, monkeypatch, live_state, submission, stale
):
    p, archive, state = held
    assert archive_mode(archive)
    state.state, state.subtask_id = live_state, submission
    monkeypatch.setattr(printer_manager, "peek_status", lambda _pid: (state, time.monotonic(), stale))
    assert await automatic_predecessor(db_session, p) is None


@pytest.mark.asyncio
async def test_camera_exception_defers_instead_of_failing_or_publishing(db_session, held, monkeypatch):
    p, _, _ = held
    monkeypatch.setattr(
        "backend.app.services.plate_detection.check_plate_empty", AsyncMock(side_effect=RuntimeError("broken camera"))
    )
    with pytest.raises(RoutingDeferred, match="plate_check_unavailable"):
        await dispatch_check(
            db_session, SimpleNamespace(options={"auto_eject": True}), p, AsyncMock(), lambda _job: None
        )


@pytest.mark.asyncio
async def test_missing_cv2_and_missing_frame_are_explicitly_unavailable(monkeypatch):
    from backend.app.services import plate_detection as pd

    monkeypatch.setattr(pd, "OPENCV_AVAILABLE", False)
    result = await pd.check_plate_empty(1, "synthetic", "synthetic", "A1M", fresh=True)
    assert result.status == "unavailable" and result.is_empty is False
    monkeypatch.setattr(pd, "OPENCV_AVAILABLE", True)
    monkeypatch.setattr(pd, "capture_camera_image", AsyncMock(return_value=(None, "Synthetic camera fault")))
    result = await pd.check_plate_empty(1, "synthetic", "synthetic", "P1S", fresh=True)
    assert result.status == "unavailable" and result.is_empty is False


def test_unavailable_cannot_be_serialised_as_empty():
    result = PlateDetectionResult(True, 1, 0, "Unknown", status="unavailable")
    assert result.to_dict()["status"] == "unavailable"
    assert result.to_dict()["is_empty"] is False


def test_calibration_required_overrides_a_contradictory_clear_status():
    result = PlateDetectionResult(True, 1, 0, "Unknown", status="clear", needs_calibration=True)
    assert result.status == "unavailable" and result.is_empty is False


@pytest.mark.asyncio
@pytest.mark.parametrize("source", ["coalesced", "fresh"])
async def test_fresh_check_rejects_older_capture_and_never_falls_back_to_other_camera(monkeypatch, source):
    from backend.app.services import plate_detection as pd

    monkeypatch.setattr("backend.app.api.routes.camera.live_frame_for_capture", lambda *args, **kwargs: (False, None))
    capture = AsyncMock(return_value=SimpleNamespace(frame=b"synthetic-jpeg", source=source))
    monkeypatch.setattr("backend.app.services.camera_runtime.capture", capture)
    frame, _ = await pd.capture_camera_image(
        1,
        "synthetic",
        "synthetic",
        "P1S",
        external_camera_url="http://synthetic.invalid",
        external_camera_type="mjpeg",
        use_external=True,
        fresh=True,
    )
    assert frame == (b"synthetic-jpeg" if source == "fresh" else None)
    assert capture.await_count == 1


@pytest.mark.asyncio
async def test_fresh_capture_waits_for_viewers_next_frame_without_second_reader(monkeypatch):
    from backend.app.api.routes import camera
    from backend.app.services import plate_detection as pd

    live = Mock(side_effect=[(True, None), (True, b"new-synthetic-frame")])
    monkeypatch.setattr(camera, "live_frame_for_capture", live)
    capture = AsyncMock()
    monkeypatch.setattr("backend.app.services.camera_runtime.capture", capture)
    frame, _ = await pd.capture_camera_image(1, "synthetic", "synthetic", "A1M", fresh=True)
    assert frame == b"new-synthetic-frame"
    assert live.call_count == 2
    assert live.call_args_list[0].kwargs["not_before"] == live.call_args_list[1].kwargs["not_before"]
    capture.assert_not_awaited()


@pytest.mark.asyncio
async def test_incomplete_configured_external_camera_does_not_use_builtin(monkeypatch):
    from backend.app.services import plate_detection as pd

    capture = AsyncMock()
    monkeypatch.setattr("backend.app.services.camera_runtime.capture", capture)
    frame, _ = await pd.capture_camera_image(1, "synthetic", "synthetic", "P1S", use_external=True, fresh=True)
    assert frame is None
    capture.assert_not_awaited()
