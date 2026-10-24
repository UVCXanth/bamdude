"""Whether a printer's built-in camera may be asked for a one-shot frame (PR #95, the narrow stage of CAM-04).

The live MQTT client keeps the printer's own ``print.ipcam.ipcam_dev`` as ``PrinterState.ipcam_dev``: True, False
or None (unknown). Only an explicit False of the connected client that serves this very configuration — its host
and access code — skips a NEW built-in one-shot capture. The capture facade and ``/camera/snapshot`` ask this one
function before any worker, dial or light. Unknown, a lost link and another address keep the current path. An
external camera, a live stream and the transport resolver are not decided here.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def skip_builtin_capture(printer_id: int, ip_address: str | None, access_code: str | None) -> bool:
    """True when the printer's live client has said, for this configuration, that it has no built-in camera."""
    from backend.app.services.printer_manager import printer_manager

    client = printer_manager.get_client(printer_id)
    if client is None or not client.state.connected or client.state.ipcam_dev is not False:
        return False
    if client.ip_address != ip_address or client.access_code != access_code:
        return False  # the fact belongs to another configuration of the printer
    if not client.builtin_camera_skip_logged:
        client.builtin_camera_skip_logged = True
        logger.info("Printer %s: built-in camera capture skipped (builtin_camera_unavailable)", printer_id)
    return True
