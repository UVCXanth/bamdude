"""The names ``build_filename_candidates`` probes on the printer's storage."""

from backend.app.services.archive_download import build_filename_candidates


def test_a_bare_subtask_gets_both_suffixes():
    assert build_filename_candidates("part", None) == ["part.gcode.3mf", "part.3mf"]


def test_a_subtask_that_is_already_the_card_name_is_tried_as_is_and_never_doubled():
    """#1542: an A1 printing from USB reports the card name, suffix included, as
    the subtask. Appending suffixes to it probed ten paths that cannot exist and
    named the temp file — and so the archive — ``X.gcode.3mf.gcode.3mf``."""
    names = build_filename_candidates("Autel_legs_plate_5.gcode.3mf", "Autel_legs_plate_5.gcode.3mf")
    assert names[0] == "Autel_legs_plate_5.gcode.3mf"
    assert "Autel_legs_plate_5.3mf" in names
    assert not any(name.count(".3mf") > 1 for name in names), names


def test_a_plain_3mf_subtask_is_tried_first_under_its_own_name():
    names = build_filename_candidates("part.3mf", None)
    assert names[0] == "part.3mf"
    assert "part.gcode.3mf" in names
    assert not any(name.count(".3mf") > 1 for name in names), names


def test_space_variants_follow_the_stem():
    names = build_filename_candidates("My Part.gcode.3mf", None)
    assert names[0] == "My Part.gcode.3mf"
    assert "My_Part.gcode.3mf" in names
    assert not any(name.count(".3mf") > 1 for name in names), names
