"""Plain routing observations. Display text never identifies an incident."""

from dataclasses import dataclass, field
from datetime import datetime, timezone

from backend.app.services.filament_routing import effective_slots, normalized_color
from backend.app.utils.filament_types import canonical_filament_type
from backend.app.utils.printer_models import normalize_model_name

ROUTINE_REASONS = frozenset(
    {
        "printer_busy",
        "placement_conflict",
        "swap_request_refused",
        "source_check_busy",
        "source_copy_busy",
        "farm_recovery_hold",
    }
)
TERMINAL_REASONS = frozenset({"source_unreadable", "source_timeout"})
ACTIONABLE_REASONS = frozenset(
    {
        "no_eligible_printer",
        "mapping_review_required",
        "printer_offline",
        "printer_off_missing_filament",
        "model_unavailable",
        "model_mismatch",
        "nozzle_state_unavailable",
        "nozzle_mapping_unavailable",
        "nozzle_mismatch",
        "color_unavailable",
        "color_mismatch",
        "material_mismatch",
        "variant_mismatch",
        "feed_topology_mismatch",
        "fts_external_unsupported",
        "fts_state_unavailable",
        "tpu_left_firmware_unavailable",
        "tpu_left_firmware_unsupported",
        "distinct_sources_required",
        "override_slot_not_used",
        "previous_print_failed",
        "feed_state_unavailable",
        "pinned_source_empty",
        "source_changed",
        "invalid_plate_id",
        "invalid_plate_metadata",
        "ambiguous_plate_gcode",
        "plate_selection_required",
        "plate_gcode_missing",
        "plate_not_found",
        "filament_usage_unavailable",
        "filament_type_unavailable",
        "slice_info_missing",
        "invalid_project_settings",
        "invalid_printer_model",
        "routing_unclassified",
    }
)
KNOWN_REASONS = ROUTINE_REASONS | TERMINAL_REASONS | ACTIONABLE_REASONS


def freeze(value):
    """Canonical sets/maps of machine facts, never ORM instances or telemetry."""
    if isinstance(value, dict):
        return tuple(sorted((str(key), freeze(item)) for key, item in value.items()))
    if isinstance(value, (tuple, list, set, frozenset)):
        return tuple(sorted({freeze(item) for item in value}, key=repr))
    if isinstance(value, datetime):
        return (value.astimezone(timezone.utc).replace(tzinfo=None) if value.tzinfo else value).isoformat()
    return value


@dataclass(frozen=True)
class WaitingFact:
    code: str
    printer_id: int | None = None
    params: tuple = ()
    message: str = field(default="", compare=False)

    @property
    def actionable(self):
        return self.code not in ROUTINE_REASONS | TERMINAL_REASONS

    def key(self, model, location):
        model = normalize_model_name(model) or model or "any"
        return model.casefold(), location, self.code, self.printer_id, self.params


def fact(code, printer_id=None, *, params=None, message=""):
    if code not in KNOWN_REASONS:
        # A future reason gets one diagnostic event; never expose a raw error.
        params = {
            "unclassified_code": code
            if isinstance(code, str) and len(code) <= 80 and code.isidentifier()
            else "unknown"
        }
        code = "routing_unclassified"
    return WaitingFact(code, printer_id, freeze(params or {}), message)


def routing_params(code, requirements, policy, snapshot, slots=()):
    """Facts used by the existing refusal, without a second solver pass.

    In particular, source names/revisions, remain, temperatures, and translated
    wanted/loaded strings never become notification identity.
    """
    if code in {"printer_offline", "feed_state_unavailable", "model_unavailable"}:
        return {}
    used = effective_slots(requirements, policy) or []
    if slots:
        used = [slot for slot in used if slot["slot_id"] in slots]
    wanted = [{"slot": slot["slot_id"], "material": canonical_filament_type(slot["type"])} for slot in used]
    params = {"wanted": wanted, "feed_policy": policy.feed_policy}
    if code in {"color_mismatch", "color_unavailable", "printer_off_missing_filament"}:
        for item, slot in zip(wanted, used, strict=True):
            if slot.get("strict"):
                item["color"] = normalized_color(slot.get("color"))
    if code == "variant_mismatch":
        for item, slot in zip(wanted, used, strict=True):
            item["variant"] = slot.get("tray_info_idx")
    if code in {"mapping_review_required", "pinned_source_empty"}:
        params["pins"] = policy.physical_pins
    if code in {"material_mismatch", "variant_mismatch", "color_mismatch", "color_unavailable"}:
        loaded = []
        for source in snapshot.sources:
            item = {"material": canonical_filament_type(source.material)}
            if code == "variant_mismatch":
                item["variant"] = source.rule_variant
            if code.startswith("color_"):
                item["color"] = normalized_color(source.rule_color)
            loaded.append(item)
        params["loaded"] = loaded
    if code in {"nozzle_mismatch", "nozzle_state_unavailable", "feed_topology_mismatch", "distinct_sources_required"}:
        params["required_nozzles"] = requirements.nozzle_constraints
        params["installed_nozzles"] = snapshot.nozzle_diameters
        params["feeds"] = [(source.id, source.kind, source.nozzles) for source in snapshot.sources]
    return params


def offline_params(requirements, policy, snapshot, missing, feed):
    params = routing_params(
        "printer_off_missing_filament", requirements, policy, snapshot, tuple(item["slot"] for item in missing)
    )
    strict = any("color" in item for item in params["wanted"])
    params["offline_loaded"] = [
        (
            canonical_filament_type(source.material),
            normalized_color(source.declared_color or source.color) if strict else None,
        )
        for source in feed.sources
    ]
    return params


@dataclass(frozen=True)
class WaitingNotice:
    job_name: str
    target_model: str
    waiting_reason: str
