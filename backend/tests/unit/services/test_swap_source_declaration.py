"""The source's declaration for future use, beside the executed run's fact (T9 spec r3 §2, §3, §8; plan T9.1).

An archive keeps two facts: the run it executed (``extra_data["swap_source"]``, read by the completion -- never
rewritten by T9) and a declaration of its source for future use (``swap_source_declaration``, read by reprint,
capture and save-to-library). A library row's source reader is the §8 table: a valid hash-bound carrier, or --
with none -- a strict legacy True, an external legacy False classified by the name its file has on the share
(``file_path``, never the display name), a managed legacy bool. The execution reader of a library-sourced legacy
snapshot gets neither the classification nor a carrier: no historical evidence, unknown.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from backend.app.services import swap_compatibility as sc

SHA = "ab" * 32
OTHER = "cd" * 32


def operator(value, *, sha=SHA, **changes) -> dict:
    record = {
        "version": 1,
        "value": value,
        "sha256": sha,
        "origin": "operator",
        "declaration_id": "1b4e28ba-2fa1-41d2-883f-0016d3cca427",
        "declared_at": "2026-10-14T10:00:00+00:00",
        "actor_id": 3,
        "actor_label": "admin",
        "actor_kind": "user",
    }
    record.update(changes)
    return record


def carrier(value, *, origin="classifier", sha=SHA, **changes) -> dict:
    record = {"version": 1, "value": value, "sha256": sha, "origin": origin}
    record.update(changes)
    return record


def an_archive(*, record="none", column=False, declaration=None) -> SimpleNamespace:
    archive = SimpleNamespace(
        extra_data={}, swap_compatible=column, source_content_hash=SHA, content_hash=SHA, swap_source_declaration=None
    )
    if record != "none":
        sc.write_archive_fact(archive, record)
        archive.swap_compatible = column if record is None else archive.swap_compatible
    archive.swap_source_declaration = declaration
    return archive


def a_library_row(
    *, bool_value=False, external=True, path="/mnt/share/plate.gcode.3mf", filename=None, file_hash=SHA, record=None
) -> SimpleNamespace:
    return SimpleNamespace(
        swap_compatible=bool_value,
        is_external=external,
        file_path=path,
        filename=filename or "plate.gcode.3mf",
        file_hash=file_hash,
        swap_source_declaration=record,
    )


# --- archive: the run's fact and the source's declaration are two facts -------------------------------------------


@pytest.mark.parametrize("value", [True, False])
def test_a_declaration_answers_the_source_and_leaves_the_runs_fact_unknown(value):
    archive = an_archive(declaration=operator(value, sha=OTHER))

    assert sc.archive_fact(archive).value is None
    fact, expected = sc.archive_source(archive)
    assert (fact.value, expected) == (value, OTHER)  # the declaration's own hash is what a capture must match


@pytest.mark.parametrize(("run", "declared"), [(True, False), (False, True)])
def test_the_runs_recorded_fact_never_moves_with_a_declaration(run, declared):
    archive = an_archive(record=run, declaration=operator(declared))

    assert sc.archive_fact(archive).value is run
    assert sc.archive_source(archive)[0].value is declared


@pytest.mark.parametrize(
    "broken",
    [
        operator(True, version=2),
        operator(True, version=True),
        operator("true"),
        operator(1),
        operator(True, sha="AB" * 32),
        operator(True, sha="ab" * 31),
        operator(True, origin="classifier"),
        operator(True, declaration_id="not-a-uuid"),
        operator(True, declared_at=None),
        operator(True, actor_kind="robot"),
        operator(True, actor_id="3"),
        operator(True, extra="authority"),
        {"version": 1, "invalid": True},
        "True",
        [],
    ],
)
def test_a_broken_declaration_is_unknown_with_no_fallback_to_a_legacy_true(broken):
    archive = an_archive(column=True, declaration=broken)  # a strict legacy True column, no record

    assert sc.archive_fact(archive).value is True  # the run's fact (D1) is untouched
    fact, _expected = sc.archive_source(archive)
    assert fact.value is None and fact.reason == sc.REASON_RECORD_INVALID


def test_without_a_declaration_the_archive_source_is_what_it_was():
    archive = an_archive(record=False)

    fact, expected = sc.archive_source(archive)
    assert (fact.value, expected) == (False, SHA)


# --- library: the §8 table ------------------------------------------------------------------------------------------


@pytest.mark.parametrize("origin", ["classifier", "generated", "transferred"])
@pytest.mark.parametrize("value", [True, False])
def test_a_valid_hash_bound_carrier_answers(origin, value):
    row = a_library_row(bool_value=value, record=carrier(value, origin=origin))

    assert sc.library_fact(row) is value


def test_an_operator_carrier_answers_over_the_name():
    row = a_library_row(bool_value=False, path="/mnt/share/plate.swaps.gcode.3mf", record=operator(False))

    assert sc.library_fact(row) is False


@pytest.mark.parametrize(
    "row",
    [
        a_library_row(bool_value=True, record=carrier(True, sha=OTHER)),  # another content's carrier
        a_library_row(bool_value=False, record=carrier(True)),  # the projection disagrees
        a_library_row(bool_value=True, path="/mnt/share/x.swaps.3mf", record=carrier("yes")),  # broken: no C either
        a_library_row(bool_value=False, path="/mnt/share/x.swaps.3mf", record={"version": 1, "invalid": True}),
    ],
    ids=["other-hash", "projection-mismatch", "malformed-no-C", "tombstone-no-C"],
)
def test_a_carrier_that_does_not_hold_is_unknown_without_any_fallback(row):
    assert sc.library_fact(row) is None


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("/mnt/share/Tray.swaps.gcode.3mf", True),
        ("/mnt/share/Tray.swap.3mf", True),
        ("C:\\share\\Tray.swaps.gcode.3mf", True),
        ("\\\\nas\\share\\x.swap.3mf", True),
        ("/mnt/share/plate.gcode.3mf", False),
        ("/mnt/share/x.swaps.dir/plate.gcode.3mf", False),  # a marker in a directory is not the file's name
        ("C:\\share\\x.swaps\\plate.3mf", False),
    ],
)
def test_a_legacy_external_false_is_classified_by_its_name_on_the_share(path, expected):
    row = a_library_row(bool_value=False, path=path)

    assert sc.library_fact(row) is expected


@pytest.mark.parametrize("display", ["plate.swaps.gcode.3mf", "plate.gcode.3mf"])
def test_the_display_name_never_classifies(display):
    plain = a_library_row(bool_value=False, path="/mnt/share/plate.gcode.3mf", filename=display)
    marked = a_library_row(bool_value=False, path="/mnt/share/plate.swaps.gcode.3mf", filename=display)

    assert (sc.library_fact(plain), sc.library_fact(marked)) == (False, True)


@pytest.mark.parametrize(
    "row",
    [
        a_library_row(bool_value=False, file_hash=None),
        a_library_row(bool_value=False, file_hash="deadbeef"),
        a_library_row(bool_value=False, path=""),
        a_library_row(bool_value=False, path=None),
        a_library_row(bool_value=False, external=None),
        a_library_row(bool_value=None),
        a_library_row(bool_value=0),
    ],
    ids=["no-hash", "bad-hash", "empty-path", "no-path", "external-unknown", "bool-none", "bool-int"],
)
def test_without_a_carrier_what_cannot_be_read_is_unknown(row):
    assert sc.library_fact(row) is None


def test_a_strict_legacy_true_stays_true():
    assert sc.library_fact(a_library_row(bool_value=True, path="/mnt/share/plate.gcode.3mf")) is True


@pytest.mark.parametrize("value", [True, False])
def test_a_managed_legacy_bool_stays_as_it_was(value):
    row = a_library_row(bool_value=value, external=False, path="library/files/x.swaps.3mf")

    assert sc.library_fact(row) is value


# --- the execution reader: no classification, no carrier -----------------------------------------------------------


@pytest.mark.parametrize(
    ("row", "expected"),
    [
        (a_library_row(bool_value=False, path="/mnt/share/plate.swaps.gcode.3mf"), None),  # C is no history
        (a_library_row(bool_value=False, path="/mnt/share/plate.gcode.3mf"), None),  # nor a default False
        (a_library_row(bool_value=True, record=carrier(True)), None),  # a carrier may postdate the capture
        (a_library_row(bool_value=False, external=False, record=operator(False)), None),
        (a_library_row(bool_value=True, path="/mnt/share/plate.gcode.3mf"), True),
        (a_library_row(bool_value=False, external=False), False),
        (a_library_row(bool_value=True, external=False, file_hash=None), None),
    ],
    ids=["C", "default-false", "carrier", "operator", "legacy-true", "managed-false", "no-hash"],
)
def test_the_execution_reader_gets_only_historical_evidence(row, expected):
    assert sc.library_execution_fact(row) is expected


def test_legacy_resolution_names_its_context():
    archive = an_archive(record=False, declaration=operator(True))
    with pytest.raises(TypeError):
        sc.resolve_legacy(provenance_kind="archive", archive=archive, library_file=None, sha256=SHA)
    with pytest.raises(ValueError):
        sc.resolve_legacy(context="later", provenance_kind="archive", archive=archive, library_file=None, sha256=SHA)


def test_legacy_resolution_of_an_archive_by_context():
    archive = an_archive(record=False, declaration=operator(True))

    source = sc.resolve_legacy(
        context="source", provenance_kind="archive", archive=archive, library_file=None, sha256=SHA
    )
    execution = sc.resolve_legacy(
        context="execution", provenance_kind="archive", archive=archive, library_file=None, sha256=SHA
    )
    assert (source.value, execution.value) == (True, False)


def test_legacy_resolution_of_a_library_row_by_context():
    row = a_library_row(bool_value=False, path="/mnt/share/plate.swaps.gcode.3mf")

    source = sc.resolve_legacy(
        context="source", provenance_kind="library_file", archive=None, library_file=row, sha256=SHA
    )
    execution = sc.resolve_legacy(
        context="execution", provenance_kind="library_file", archive=None, library_file=row, sha256=SHA
    )
    assert (source.value, execution.value) == (True, None)


# --- the one writer -------------------------------------------------------------------------------------------------


def test_the_writer_puts_a_library_carrier_and_its_projection_together():
    row = a_library_row(bool_value=False, path="/mnt/share/plate.gcode.3mf")

    sc.write_source_declaration(row, value=True, sha256=SHA, origin="classifier")

    assert row.swap_compatible is True
    assert row.swap_source_declaration == carrier(True)
    assert sc.library_fact(row) is True


def test_the_writer_refuses_what_the_reader_would_not_read():
    row = a_library_row()
    archive = an_archive()
    with pytest.raises(ValueError):
        sc.write_source_declaration(row, value="yes", sha256=SHA, origin="classifier")
    with pytest.raises(ValueError):
        sc.write_source_declaration(row, value=True, sha256="deadbeef", origin="classifier")
    with pytest.raises(ValueError):
        sc.write_source_declaration(archive, value=True, sha256=SHA, origin="classifier")  # an archive: operator only
    with pytest.raises(ValueError):
        sc.write_source_declaration(row, value=True, sha256=SHA, origin="operator")  # an operator needs its record


def test_the_writer_records_an_operator_declaration_on_an_archive_without_touching_the_run():
    archive = an_archive(record=False)
    before = dict(archive.extra_data)

    sc.write_source_declaration(
        archive,
        value=True,
        sha256=OTHER,
        origin="operator",
        operator={
            "declaration_id": "1b4e28ba-2fa1-41d2-883f-0016d3cca427",
            "declared_at": "2026-10-14T10:00:00+00:00",
            "actor_id": None,
            "actor_label": "auth disabled",
            "actor_kind": "auth_disabled",
        },
    )

    assert archive.extra_data == before and archive.swap_compatible is False
    assert sc.archive_source(archive)[0].value is True
    assert sc.archive_fact(archive).value is False
