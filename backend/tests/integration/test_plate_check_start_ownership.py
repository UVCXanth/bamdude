"""Combining polygon checks with print lifecycle must retain start ownership."""

from unittest.mock import AsyncMock, Mock

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker

from backend.app.services.plate_detection import PlateDetectionResult


@pytest.mark.parametrize("outcome", ["occupied", "unavailable", "exception"])
async def test_late_camera_result_cannot_pause_or_notify_a_successor(
    db_session, test_engine, printer_factory, monkeypatch, outcome
):
    from backend.app import main

    printer = await printer_factory(auto_archive=False, plate_detection_enabled=True)
    printer.plate_detection_polygon = [{"x": 0, "y": 0}, {"x": 1, "y": 0}, {"x": 1, "y": 1}]
    await db_session.commit()
    monkeypatch.setattr(main, "async_session", async_sessionmaker(test_engine, expire_on_commit=False))
    current = True
    monkeypatch.setattr("backend.app.services.print_run_binding.print_effect_is_current", lambda *_: current)

    async def camera(**_):
        nonlocal current
        current = False  # Another run became current while the camera was awaited.
        if outcome == "exception":
            raise RuntimeError("synthetic capture failure")
        return PlateDetectionResult(False, 0, 0, "synthetic", status=outcome)

    capture = AsyncMock(side_effect=camera)
    monkeypatch.setattr("backend.app.services.plate_detection.check_plate_empty", capture)
    manager = Mock()
    manager.is_awaiting_plate_clear.return_value = False
    manager.get_printer.return_value = None
    monkeypatch.setattr(main, "printer_manager", manager)
    hint = Mock()
    monkeypatch.setattr(main, "set_expected_pause_reason", hint)
    ws = Mock(send_print_start=AsyncMock(), broadcast=AsyncMock())
    monkeypatch.setattr(main, "ws_manager", ws)
    notice = AsyncMock()
    monkeypatch.setattr(main.notification_service, "on_plate_not_empty", notice)
    for path in (
        "backend.app.main._send_print_start_notification",
        "backend.app.main.notify_missing_spool_assignments_on_print_start",
        "backend.app.services.macro_trigger.fire_event_macros",
        "backend.app.services.usage_tracker.on_print_start",
        "backend.app.main.smart_plug_manager.on_print_start",
    ):
        monkeypatch.setattr(path, AsyncMock())
    await main._on_print_start_impl(
        printer.id, {"filename": "part.gcode", "subtask_name": "part", "_bamdude_start_generation": 7}
    )
    capture.assert_awaited_once()
    manager.get_client.return_value.pause_print.assert_not_called()
    hint.assert_not_called()
    ws.broadcast.assert_not_awaited()
    notice.assert_not_awaited()
