"""Which library file types get which preview path — by ``LibraryFile.file_type``, never by a display name.

STL/OBJ render synchronously through the legacy batch route; STEP/STP only through the background thumbnail jobs
(spec §3, §5). Nothing here imports OCP or the renderer.
"""

from __future__ import annotations

LEGACY_TYPES = ("stl", "obj")
CAD_TYPES = ("step", "stp")


def is_legacy(file_type: str | None) -> bool:
    return (file_type or "").lower() in LEGACY_TYPES


def is_cad(file_type: str | None) -> bool:
    return (file_type or "").lower() in CAD_TYPES
