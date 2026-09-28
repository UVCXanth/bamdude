"""Mixed-source primary selection must use the source and binding together."""

from backend.app.services.storage_condition_sort import select_condition_value


def test_overlapping_binding_ids_require_explicit_source():
    choices = [("ha", 7, 48.0), ("zigbee", 7, 49.0)]
    assert select_condition_value(choices, None) is None
    assert select_condition_value(choices, ("ha", 7)) == 48.0
    assert select_condition_value(choices, ("zigbee", 7)) == 49.0
    assert select_condition_value(choices, ("zigbee", 8)) is None


def test_missing_and_nonfinite_values_do_not_sort_as_measurements():
    assert select_condition_value([("ha", 1, None)], None) is None
    assert select_condition_value([("ha", 1, float("nan"))], None) is None
