"""The swap-profile catalog names models the rest of the app can match.

A profile's ``models`` are compared EXACTLY with a printer's stored model by the
printer form (it shows the swap toggle only for a model some profile lists), and
the macro editor can target only models ``/macros/meta`` offers. A profile that
spells its model any other way, or names one the editor cannot offer, is a mod
nobody can switch on or write a macro for.
"""

import pytest

from backend.app.core.swap_profiles import SWAP_PROFILES
from backend.app.utils.printer_model_names import PRINTER_MODEL_DISPLAY_NAMES
from backend.app.utils.printer_models import normalize_model_name

_PROFILE_MODELS = sorted({(pid, model) for pid, p in SWAP_PROFILES.items() for model in p["models"]})


@pytest.mark.parametrize(("profile_id", "model"), _PROFILE_MODELS)
def test_a_profile_names_its_model_by_the_short_name(profile_id, model):
    assert normalize_model_name(model) == model, f"{profile_id}: {model!r} is not the stored spelling"


@pytest.mark.parametrize(("profile_id", "model"), _PROFILE_MODELS)
def test_the_macro_editor_offers_every_profile_model(profile_id, model):
    assert model in PRINTER_MODEL_DISPLAY_NAMES, f"{profile_id}: the macro editor cannot target {model!r}"


def test_profile_ids_fit_the_column():
    # printers.swap_profile / macros.swap_profile are VARCHAR(50)
    assert all(len(pid) <= 50 for pid in SWAP_PROFILES)
