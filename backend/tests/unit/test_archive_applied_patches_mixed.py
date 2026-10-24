"""The archive response accepts the mixed patch list the dispatch writes.

``applied_patches`` is a JSON array that can hold plain identifiers and the
gcode-injection descriptor objects (``{"name": "gcode_injection", ...}``).
The response model typed it as ``list[str]``, so such an archive 500'd the
whole list endpoint (#97).
"""

from __future__ import annotations

from backend.app.schemas.archive import ArchiveResponse


def test_archive_response_accepts_mixed_applied_patches():
    resp = ArchiveResponse(
        id=1,
        printer_id=None,
        filename="x.3mf",
        file_path="archives/x.3mf",
        file_size=0,
        content_hash=None,
        thumbnail_path=None,
        timelapse_path=None,
        print_name=None,
        print_time_seconds=None,
        filament_used_grams=None,
        filament_type=None,
        filament_color=None,
        layer_height=None,
        nozzle_diameter=None,
        bed_temperature=None,
        nozzle_temperature=None,
        status="completed",
        started_at=None,
        completed_at=None,
        extra_data=None,
        makerworld_url=None,
        designer=None,
        is_favorite=False,
        tags=None,
        notes=None,
        cost=None,
        photos=None,
        failure_reason=None,
        created_at=None,
        swap_compatibility_known=False,
        source_swap_compatibility_known=False,
        applied_patches=[
            "mesh_mode_fast_check_off",
            {"name": "gcode_injection", "plate_id": 2},
        ],
    )
    assert resp.applied_patches == [
        "mesh_mode_fast_check_off",
        {"name": "gcode_injection", "plate_id": 2},
    ]
