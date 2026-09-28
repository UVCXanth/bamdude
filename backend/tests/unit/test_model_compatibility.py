"""The target's Bambu Studio list decides whether a sliced file can run."""

from __future__ import annotations

import pytest

from backend.app.utils import model_compatibility as compatibility


@pytest.mark.parametrize(
    ("file_model", "printer_model", "verdict"),
    [
        ("C11", "P1S", "compatible"),
        ("Bambu Lab X1 Carbon", "P1S", "compatible"),
        ("O1D", "H2D Pro", "compatible"),
        ("H2D Pro", "H2D", "compatible"),
        ("O1C2", "H2C", "exact"),
        ("A1", "P1S", "incompatible"),
        ("N8", "N8", "exact"),
        ("N8", "P1S", "incompatible"),
        ("Unknown model", "unknown MODEL", "exact"),
        ("Unknown model", "Other model", "incompatible"),
        (None, "P1S", "unknown"),
        ("P1S", None, "unknown"),
    ],
)
def test_mirrored_model_verdict(file_model, printer_model, verdict):
    assert compatibility.model_compatibility(file_model, printer_model) == verdict


def test_upgrade_kit_changes_effective_model_only_when_active():
    assert compatibility.model_compatibility("P1S", "P1P") == "compatible"
    assert compatibility.model_compatibility("P1S", "P1P", upgrade_kit=True) == "exact"
    assert compatibility.model_compatibility("P1P", "P1P", upgrade_kit=True) == "compatible"


def test_relationship_is_directed_and_not_transitive(monkeypatch):
    accepted = {"A": frozenset(), "B": frozenset({"A"}), "C": frozenset({"B"})}
    monkeypatch.setattr(compatibility, "compatible_models", lambda target: accepted[target])
    assert compatibility.model_compatibility("A", "B") == "compatible"
    assert compatibility.model_compatibility("B", "A") == "incompatible"
    assert compatibility.model_compatibility("A", "C") == "incompatible"


def test_matrix_uses_mirrored_models_and_excludes_self_aliases():
    matrix = compatibility.compatibility_matrix()
    assert "P1P" in matrix["P1S"]
    assert "H2D" in matrix["H2D Pro"]
    assert matrix["H2C"] == []
    assert matrix["N8"] == []
