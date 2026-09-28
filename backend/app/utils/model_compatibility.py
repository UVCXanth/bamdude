"""Directed G-code model compatibility from mirrored Bambu Studio configs.

The target printer's ``compatible_machine`` lists *file* models it accepts.
It is not a symmetric family or a transitive relation.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from backend.app.utils.printer_configs import load_printer_config, printer_config_codes
from backend.app.utils.printer_models import normalize_model_name

ModelVerdict = Literal["exact", "compatible", "incompatible", "unknown"]


def _canonical(model: str | None) -> str:
    return (normalize_model_name(model) or "").upper().replace(" ", "").replace("-", "")


@lru_cache(maxsize=128)
def compatible_models(model: str | None) -> frozenset[str]:
    """Short names of file models explicitly accepted by this target model."""
    config = load_printer_config(model)
    if not config:
        return frozenset()
    accepted = config.get("compatible_machine")
    if not isinstance(accepted, list):
        return frozenset()
    own = _canonical(model)
    return frozenset(
        name
        for code in accepted
        if isinstance(code, str)
        if (name := normalize_model_name(code)) and _canonical(name) != own
    )


def effective_model(model: str | None, *, upgrade_kit: bool = False) -> str | None:
    """Model used for compatibility, leaving the physical model unchanged."""
    normalized = normalize_model_name(model)
    if not normalized:
        return None
    # Bambu Studio's get_show_printer_type() hardcodes C12 for an active kit.
    return "P1S" if upgrade_kit and normalized == "P1P" else normalized


def effective_model_for_state(model: str | None, state: object | None) -> str | None:
    """Apply a kit only after both independent flags were reported true."""
    active = bool(
        state is not None
        and getattr(state, "upgrade_kit_supported", None) is True
        and getattr(state, "upgrade_kit_installed", None) is True
    )
    return effective_model(model, upgrade_kit=active)


def model_compatibility(
    file_model: str | None,
    printer_model: str | None,
    *,
    upgrade_kit: bool = False,
) -> ModelVerdict:
    """Compare the file with the target printer; unknown is caller policy."""
    file_key = _canonical(file_model)
    target = effective_model(printer_model, upgrade_kit=upgrade_kit)
    target_key = _canonical(target)
    if not file_key or not target_key:
        return "unknown"
    if file_key == target_key:
        return "exact"
    if any(file_key == _canonical(name) for name in compatible_models(target)):
        return "compatible"
    return "incompatible"


@lru_cache(maxsize=1)
def compatibility_matrix() -> dict[str, list[str]]:
    """API matrix, with one row per canonical mirrored printer model."""
    matrix: dict[str, list[str]] = {}
    for code in sorted(printer_config_codes()):
        config = load_printer_config(code)
        if not config:
            continue
        name = normalize_model_name(config.get("display_name"))
        if not name:
            continue
        matrix[name] = sorted(set(matrix.get(name, [])) | compatible_models(code))
    return matrix
