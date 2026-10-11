"""Resolve an order's explicit toggles without changing operator defaults/macros."""

from backend.app.schemas.order_print_options import OrderPrintOptions, capabilities
from backend.app.schemas.print_options_preference import PrintOptionsToggles
from backend.app.services.print_option_defaults import _saved_preference
from backend.app.utils.printer_models import normalize_model_name


def override_options(snapshot: dict | None, model: str | None, target_model: str | None = None) -> dict:
    """A job carries the order's model map at creation, never a live order lookup.

    The model belongs to the sliced job. Compatible placement must not silently
    replace its explicit choices with another model's profile. Rebalance really
    changes the source file/target_model, and selects that model's snapshot entry.
    No entry means the existing operator-profile path.
    Revalidation also refuses a corrupt persisted snapshot before assignment.
    """
    if not snapshot:
        return {}
    validated = OrderPrintOptions(overrides=snapshot)
    entry = validated.overrides.get(normalize_model_name(model))
    if entry and target_model:
        OrderPrintOptions(overrides={target_model: entry})
    return entry.model_dump() if entry else {}


async def inherited_options(db, user, model: str) -> PrintOptionsToggles:
    pref = await _saved_preference(db, user, model)
    values = {
        "bed_levelling": "on",
        "flow_cali": "on",
        "layer_inspect": False,
        "timelapse": False,
        "timelapse_storage": None,
        "mesh_mode_fast_check": True,
        "gcode_injection": False,
        "nozzle_offset_cali": "on",
        "preheat_override": "inherit",
        "preheat_chamber_target_override": None,
    }
    if pref:
        from pydantic import ValidationError

        try:
            values = PrintOptionsToggles.model_validate(pref.options["print_options"]).model_dump()
        except (KeyError, TypeError, ValidationError):
            pass  # Same unreadable-profile fallback as preference_options.
    # The current plan-profile writer inherits global preheat settings, unlike
    # the print dialog. An explicit order choice below can override them.
    values["preheat_override"] = "inherit"
    values["preheat_chamber_target_override"] = None
    # The editor must not offer a machine-inapplicable saved/default toggle.
    # This only seeds explicit editing; the legacy inheritance path is untouched.
    caps = capabilities(model)
    for key, supported in caps["supported"].items():
        if not supported:
            if key == "preheat_chamber_target_override":
                values[key] = None
            else:
                values[key] = "off" if key.endswith("cali") or key == "bed_levelling" else False
    for key, supported in caps["auto"].items():
        if values[key] == "auto" and not supported:
            values[key] = "on" if caps["supported"][key] else "off"
    return PrintOptionsToggles.model_validate(values)
