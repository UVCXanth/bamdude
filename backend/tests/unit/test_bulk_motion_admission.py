"""Batch UI still goes through the canonical per-printer motion guards."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["home-axes?axes=all", "calibration?bed_leveling=true"])
@pytest.mark.parametrize(
    "connected,stale,state,received",
    [
        (False, False, "IDLE", 1),
        (True, True, "IDLE", 1),
        (True, False, "unknown", 1),
        (True, False, "PREPARE", 1),
        (True, False, "IDLE", None),
    ],
)
async def test_no_motion_without_current_local_idle_state(
    async_client, printer_factory, operation, connected, stale, state, received
):
    printer = await printer_factory(name="Synthetic Product A printer", model="P1S")
    client = MagicMock()
    client.state.connected = connected
    client.state.state = state
    client.is_stale.return_value = stale
    client.status_received_at = received
    with patch("backend.app.api.routes.printers.printer_manager") as manager:
        manager.get_client.return_value = client
        manager.ensure_fresh_connection_for_printer = AsyncMock(return_value=True)
        response = await async_client.post(f"/api/v1/printers/{printer.id}/{operation}")
    assert response.status_code in (400, 409)
    client.send_gcode.assert_not_called()
    client.start_calibration.assert_not_called()


@pytest.mark.asyncio
async def test_unsupported_calibration_cannot_be_forced_by_client(async_client, printer_factory):
    printer = await printer_factory(name="Synthetic Product B printer", model="A1M")
    client = MagicMock()
    client.state.connected = True
    client.state.state = "IDLE"
    client.state.device_cali_support = {}
    client.state.firmware_version = None
    client.is_stale.return_value = False
    with patch("backend.app.api.routes.printers.printer_manager") as manager:
        manager.get_client.return_value = client
        manager.ensure_fresh_connection_for_printer = AsyncMock(return_value=True)
        response = await async_client.post(f"/api/v1/printers/{printer.id}/calibration?nozzle_offset=true")
    assert response.status_code == 409
    client.start_calibration.assert_not_called()


@pytest.mark.asyncio
async def test_supported_calibration_publish_refusal_is_not_success(async_client, printer_factory):
    printer = await printer_factory(name="Synthetic Product A printer", model="P1S")
    client = MagicMock()
    client.state.connected = True
    client.state.state = "IDLE"
    client.state.device_cali_support = {}
    client.state.firmware_version = None
    client.is_stale.return_value = False
    client.start_calibration.return_value = False
    with patch("backend.app.api.routes.printers.printer_manager") as manager:
        manager.get_client.return_value = client
        manager.ensure_fresh_connection_for_printer = AsyncMock(return_value=True)
        response = await async_client.post(f"/api/v1/printers/{printer.id}/calibration?bed_leveling=true")
    assert response.status_code == 500
    client.start_calibration.assert_called_once()


@pytest.mark.asyncio
async def test_entering_maintenance_mode_cannot_disconnect_running_print(async_client, printer_factory):
    printer = await printer_factory(name="Synthetic Product A printer", model="P1S")
    with (
        patch("backend.app.api.routes.printers.is_printer_busy", return_value=True),
        patch("backend.app.api.routes.printers.printer_manager") as manager,
    ):
        response = await async_client.patch(f"/api/v1/printers/{printer.id}", json={"is_active": False})
    assert response.status_code == 409
    manager.disconnect_printer.assert_not_called()
