"""The archived 3MF backfill must not expand XML entities."""

import zipfile

from backend.app.migrations.m057_archive_bed_type import _extract_bed_type


def test_bed_type_backfill_ignores_xml_entities(tmp_path):
    path = tmp_path / "entity.3mf"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(
            "Metadata/slice_info.config",
            '<!DOCTYPE config [<!ENTITY x "Textured PEI Plate">]>'
            '<config><plate><metadata key="curr_bed_type" value="&x;"/></plate></config>',
        )
    assert _extract_bed_type(path) is None
