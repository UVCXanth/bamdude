"""Order overrides reuse the print dialog's toggles and BambuStudio's catalog.

The catalog describes model capabilities, not live printer readiness. Dispatch
still checks the actual machine. Missing fields/configs never grant a capability.
"""

from pydantic import BaseModel, Field, model_validator

from backend.app.schemas.print_options_preference import PrintOptionsToggles
from backend.app.utils.printer_configs import load_printer_config
from backend.app.utils.printer_models import normalize_model_name


def capabilities(model: str) -> dict:
    config = load_printer_config(model)
    flags = (config or {}).get("print", {})
    return {
        "known": config is not None,
        "supported": {
            "bed_levelling": bool(flags.get("support_bed_leveling")),
            "flow_cali": bool(flags.get("support_flow_calibration")),
            "nozzle_offset_cali": bool(flags.get("support_nozzle_offset_calibration")),
            "layer_inspect": bool(flags.get("support_first_layer_inspect")),
            "timelapse": bool(flags.get("support_timelapse")),
            "preheat_chamber_target_override": bool(
                flags.get("support_chamber_temp_display") or flags.get("support_chamber_temp_edit")
            ),
        },
        "auto": {
            "bed_levelling": flags.get("support_bed_leveling") == 2,
            "flow_cali": bool(flags.get("support_auto_flow_calibration")),
            "nozzle_offset_cali": bool(flags.get("support_nozzle_offset_calibration")),
        },
    }


class OrderPrintToggles(PrintOptionsToggles):
    model_config = {"extra": "forbid"}


class OrderPrintOptions(BaseModel):
    overrides: dict[str, OrderPrintToggles] = Field(default_factory=dict, max_length=32)
    model_config = {"extra": "forbid"}

    @model_validator(mode="after")
    def _model_capabilities(self):
        normalized = {}
        for raw, options in self.overrides.items():
            model = normalize_model_name(raw)
            caps = capabilities(model or "")
            if not model or not caps["known"]:
                raise ValueError("Unknown printer model for order print options")
            if model in normalized:
                raise ValueError("Duplicate printer model for order print options")
            for key, supported in caps["supported"].items():
                value = getattr(options, key)
                if not supported and value not in (False, "off", None):
                    raise ValueError(f"{model}: {key} is not supported")
            for key, supported in caps["auto"].items():
                if getattr(options, key) == "auto" and not supported:
                    raise ValueError(f"{model}: {key} automatic mode is not supported")
            normalized[model] = options
        self.overrides = normalized
        return self


class OrderPrintModel(BaseModel):
    model: str
    capabilities: dict
    inherited: PrintOptionsToggles
    options: PrintOptionsToggles
    custom: bool


class OrderPrintOptionsResponse(OrderPrintOptions):
    models: list[OrderPrintModel]
