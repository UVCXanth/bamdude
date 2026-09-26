"""The H2C names a nozzle by rack position, not by extruder index.

Ported from upstream #2800 (`ec26cba9` + `e9d9e51a` + `dfeac792`) and corrected
by upstream `45dc139c`, which an earlier audit here mislabelled and never took.
We have no H2C to test against, so the numbering comes from three sources that
agree — BambuStudio, upstream's measurement on a real machine, and the file the
slicer writes:

- **the rack is extruder 0**, the right carriage (BambuStudio's MAIN: rack
  nozzles sit on the right extruder, rack control checks MAIN's nozzle, the
  nozzle being swapped in maps to MAIN; the H2C preset gives the right extruder
  six nozzles and the left one, and ``physical_extruder_map`` ``[1, 0]`` puts
  the slicer's right extruder on MQTT extruder 0). Upstream measured the same
  on 2026-08-14: ``ams_extruder_map {'0': 1, '1': 0, '2': 0}`` and
  BambuStudio's own dispatch sent extruder 1's filament to nozzle 1 and extruder
  0's to rack positions 16 and 18.
- **the fixed hotend is extruder 1** and answers to physical ID **1** on the
  wire; a rack slot answers to its dock position 16–21, never to its index.
- the #2800 A/B still stands as a WIRE result: ``[1, -1, -1, 17]`` printed
  correctly and ``[17, -1, -1, 1]`` printed in mid-air. The extruder indices
  once inferred from it (rack = 1) came from a 3MF reader that mis-read these
  files, and held here until 2026-09-26: a plate using both carriages was
  levelled with one nozzle and printed with the other.

⚠️ The failure mode is asymmetric, and that shapes every branch here: **omitting
the field costs only the firmware's own nozzle pick, while a wrong physical ID
levels with one hotend and prints with another.** So everything unresolvable
returns None rather than guessing.
"""

from __future__ import annotations

import io
import zipfile

import pytest

from backend.app.services.bambu_mqtt import resolve_rack_nozzle_mapping
from backend.app.utils.printer_models import is_nozzle_rack_model
from backend.app.utils.threemf_tools import (
    extract_nozzle_mapping_from_3mf,
    extract_slot_extruders_from_3mf,
)

RACK_ID = 17
WIRE_SLOTS = 32
RACK = 0  # extruder index of the rack carriage (right, MAIN)
FIXED = 1  # extruder index of the fixed hotend (left, DEPUTY); its wire id is 1 too


def _wire(**slots: int) -> list[int]:
    """The 32-long array with the named 0-based positions filled in."""
    out = [-1] * WIRE_SLOTS
    for index, value in slots.items():
        out[int(index.lstrip("s"))] = value
    return out


class TestTheHardwareVerifiedAnswer:
    def test_a_mixed_plate_dispatches_both_carriages_by_physical_id(self):
        """The #2800 case: slot 1 on the fixed hotend, slot 4 on the rack —
        the wire that printed correctly."""
        assert resolve_rack_nozzle_mapping([FIXED, -1, -1, RACK], RACK_ID) == _wire(s0=1, s3=RACK_ID)

    def test_the_rack_is_extruder_zero(self):
        """The other way round is what printed in mid-air."""
        resolved = resolve_rack_nozzle_mapping([1, 0], RACK_ID)
        assert resolved[0] == 1, "extruder 1 is the FIXED carriage"
        assert resolved[1] == RACK_ID, "extruder 0 is the rack"

    def test_studios_captures_in_either_slot_order(self):
        """BambuStudio's native captures of mixed plates: [1, 17, ...] and
        [17, 1, ...] once the filament slot order is swapped."""
        assert resolve_rack_nozzle_mapping([FIXED, RACK], RACK_ID)[:2] == [1, RACK_ID]
        assert resolve_rack_nozzle_mapping([RACK, FIXED], RACK_ID)[:2] == [RACK_ID, 1]

    @pytest.mark.parametrize("rack_id", [16, 17, 18, 19, 20, 21])
    def test_every_rack_position_the_firmware_reports_is_accepted(self, rack_id):
        assert resolve_rack_nozzle_mapping([RACK], rack_id) == _wire(s0=rack_id)


class TestWhenItRefusesToGuess:
    def test_no_live_rack_position_means_no_mapping(self):
        """Mid-swap or a stale connection. The firmware picks instead."""
        assert resolve_rack_nozzle_mapping([FIXED, RACK], None) is None

    def test_a_position_outside_the_rack_range_is_refused(self):
        assert resolve_rack_nozzle_mapping([FIXED, RACK], 5) is None

    def test_a_plate_that_never_touches_the_rack_sends_nothing(self):
        """BambuStudio omits nozzle_mapping entirely for a fixed-only plate, so
        this matches it rather than naming a nozzle it need not name."""
        assert resolve_rack_nozzle_mapping([FIXED, FIXED, -1], RACK_ID) is None

    def test_a_third_carriage_is_refused_rather_than_forwarded(self):
        """An H2C has two. A third index means the file was mapped for another
        machine, and forwarding it raw would name a nozzle that does not exist."""
        assert resolve_rack_nozzle_mapping([RACK, 2], RACK_ID) is None

    def test_more_slots_than_the_wire_carries(self):
        assert resolve_rack_nozzle_mapping([RACK] * (WIRE_SLOTS + 1), RACK_ID) is None

    @pytest.mark.parametrize("bad", [None, "x", [], [0, "2"], [0, None, 1]])
    def test_junk_never_raises(self, bad):
        """The only caller publishes an MQTT command with no handler above it,
        and the queue item is already committed as printing."""
        result = resolve_rack_nozzle_mapping(bad, RACK_ID)
        assert result is None or isinstance(result, list)

    def test_a_bool_is_not_an_extruder_index(self):
        """bool subclasses int and would serialise as JSON `true` on the wire."""
        assert resolve_rack_nozzle_mapping([True, RACK], RACK_ID) is None
        assert resolve_rack_nozzle_mapping([RACK], True) is None

    def test_none_inside_the_list_means_slot_not_printed(self):
        assert resolve_rack_nozzle_mapping([None, RACK], RACK_ID) == _wire(s1=RACK_ID)


class TestTheModelGate:
    @pytest.mark.parametrize("model", ["H2C", "O1C", "O1C2", "h2c", " H2C "])
    def test_the_rack_models(self, model):
        assert is_nozzle_rack_model(model) is True

    @pytest.mark.parametrize("model", ["H2D", "H2DPRO", "X2D", "P1S", None, ""])
    def test_everything_else_is_untouched(self, model):
        """⚠️ Load-bearing: on every other dual-nozzle printer the mapping values
        ARE the wire values, and translating them would break H2D."""
        assert is_nozzle_rack_model(model) is False


def _threemf(project: str, slice_info: str) -> zipfile.ZipFile:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("Metadata/project_settings.config", project)
        zf.writestr("Metadata/slice_info.config", slice_info)
    return zipfile.ZipFile(buf)


# As BambuStudio ships every H2 machine, the H2C included (fdm_bbl_3dp_002_common):
# the slicer's left extruder is MQTT extruder 1, its right one MQTT extruder 0.
PROJECT_H2 = '{"physical_extruder_map": ["1", "0"]}'


class TestTheGroupTable:
    def test_one_group_per_carriage_resolves_through_the_files_own_table(self):
        """⚠️ On a rack machine the slicer writes a group per NOZZLE and states
        which extruder each group is on (``extruder_id`` is 1-based and the
        slicer's own numbering — 2 is the right, rack carriage)."""
        slice_info = """<config><plate>
          <metadata key="index" value="1"/>
          <nozzle id="0" extruder_id="1"/>
          <nozzle id="1" extruder_id="2"/>
          <filament id="1" group_id="0"/>
          <filament id="2" group_id="1"/>
        </plate></config>"""

        assert extract_nozzle_mapping_from_3mf(_threemf(PROJECT_H2, slice_info)) == {1: FIXED, 2: RACK}

    def test_a_plate_wanting_two_rack_nozzles_is_left_to_the_firmware(self, tmp_path):
        """Two groups on one extruder is the rack: the plate wants a different
        hotend from it per group, and which dock each takes is the slicer's
        choice against the live rack, stated nowhere in the file (upstream's
        three-filament plate carried identical diameters on both rack groups
        and BambuStudio still sent them to 16 and 18). Answering anyway is what
        printed in mid-air, so the WIRE mapping is withheld.

        ⚠️ Only the wire. Which carriage each slot prints from is known — both
        rack slots are extruder 0 — and routing, the archive and the library
        read exactly that; withholding it there would refuse the plate outright
        (upstream placed the refusal in the shared reader, which has no routing
        to break)."""
        slice_info = """<config><plate>
          <metadata key="index" value="1"/>
          <nozzle id="0" extruder_id="1"/>
          <nozzle id="1" extruder_id="2"/>
          <nozzle id="2" extruder_id="2"/>
          <filament id="1" group_id="2"/>
          <filament id="2" group_id="0"/>
          <filament id="3" group_id="1"/>
        </plate></config>"""
        path = tmp_path / "two-rack.gcode.3mf"
        with zipfile.ZipFile(path, "w") as zf:
            zf.writestr("Metadata/project_settings.config", PROJECT_H2)
            zf.writestr("Metadata/slice_info.config", slice_info)

        assert extract_nozzle_mapping_from_3mf(_threemf(PROJECT_H2, slice_info)) == {1: RACK, 2: FIXED, 3: RACK}
        assert extract_slot_extruders_from_3mf(path) is None

    def test_without_a_table_the_group_is_the_extruder_index(self):
        """Every H2D slice — the guard above cannot fire without a table."""
        slice_info = """<config><plate>
          <metadata key="index" value="1"/>
          <filament id="1" group_id="0"/>
          <filament id="2" group_id="1"/>
        </plate></config>"""

        assert extract_nozzle_mapping_from_3mf(_threemf(PROJECT_H2, slice_info)) == {1: 1, 2: 0}

    def test_an_unplaceable_group_drops_the_WHOLE_mapping(self):
        """Half an answer reaches the wire as -1 for the missing slot, and
        against an ams_mapping that DOES name a tray the firmware refuses the
        job outright with HMS 0500-4047."""
        slice_info = """<config><plate>
          <metadata key="index" value="1"/>
          <filament id="1" group_id="0"/>
          <filament id="2" group_id="7"/>
        </plate></config>"""

        assert extract_nozzle_mapping_from_3mf(_threemf(PROJECT_H2, slice_info)) is None

    def test_grouping_some_filaments_and_not_others_is_unplaceable(self):
        slice_info = """<config><plate>
          <metadata key="index" value="1"/>
          <filament id="1" group_id="0"/>
          <filament id="2"/>
        </plate></config>"""

        assert extract_nozzle_mapping_from_3mf(_threemf(PROJECT_H2, slice_info)) is None

    def test_plates_disagreeing_about_a_group_fall_back_to_the_index(self):
        slice_info = """<config>
          <plate><metadata key="index" value="1"/><nozzle id="0" extruder_id="1"/>
            <filament id="1" group_id="0"/></plate>
          <plate><metadata key="index" value="2"/><nozzle id="0" extruder_id="2"/>
            <filament id="1" group_id="0"/></plate>
        </config>"""

        assert extract_nozzle_mapping_from_3mf(_threemf(PROJECT_H2, slice_info)) == {1: 1}


class TestThePlateIsScoped:
    def test_the_named_plate_decides(self):
        """⚠️ A multi-plate file carries one filament list per plate and they
        need not agree — without scoping, a slot takes its extruder from
        whichever plate came last."""
        slice_info = """<config>
          <plate><metadata key="index" value="1"/><filament id="1" group_id="0"/></plate>
          <plate><metadata key="index" value="2"/><filament id="1" group_id="1"/></plate>
        </config>"""

        zf = _threemf(PROJECT_H2, slice_info)
        assert extract_nozzle_mapping_from_3mf(zf, plate_id=1) == {1: 1}
        assert extract_nozzle_mapping_from_3mf(zf, plate_id=2) == {1: 0}


class TestTheDenseForm:
    def test_a_gap_becomes_minus_one(self, tmp_path):
        slice_info = """<config><plate>
          <metadata key="index" value="1"/>
          <filament id="1" group_id="0"/>
          <filament id="3" group_id="1"/>
        </plate></config>"""
        path = tmp_path / "job.gcode.3mf"
        with zipfile.ZipFile(path, "w") as zf:
            zf.writestr("Metadata/project_settings.config", PROJECT_H2)
            zf.writestr("Metadata/slice_info.config", slice_info)

        assert extract_slot_extruders_from_3mf(path) == [1, -1, 0]

    def test_an_unreadable_file_costs_nothing(self, tmp_path):
        """A broken file on the dispatch path must not take the print down."""
        path = tmp_path / "not-a-zip.3mf"
        path.write_bytes(b"nope")

        assert extract_slot_extruders_from_3mf(path) is None

    def test_an_absurd_slot_id_is_refused_before_the_list_is_built(self, tmp_path):
        """A file declaring filament id="50000000" would otherwise allocate a
        fifty-million-entry list, on the dispatch path."""
        slice_info = """<config><plate>
          <metadata key="index" value="1"/>
          <filament id="50000000" group_id="0"/>
        </plate></config>"""
        path = tmp_path / "hostile.gcode.3mf"
        with zipfile.ZipFile(path, "w") as zf:
            zf.writestr("Metadata/project_settings.config", PROJECT_H2)
            zf.writestr("Metadata/slice_info.config", slice_info)

        assert extract_slot_extruders_from_3mf(path) is None


class TestFromTheFileToTheWire:
    """The whole chain on a file shaped as BambuStudio writes an H2C slice —
    the pairing the old rack = 1 inference was never tested against."""

    def _file(self, tmp_path, groups: dict[int, int], table: dict[int, int]):
        nozzles = "".join(f'<nozzle id="{g}" extruder_id="{e}"/>' for g, e in table.items())
        filaments = "".join(f'<filament id="{slot}" group_id="{g}"/>' for slot, g in groups.items())
        path = tmp_path / "h2c.gcode.3mf"
        with zipfile.ZipFile(path, "w") as zf:
            zf.writestr("Metadata/project_settings.config", PROJECT_H2)
            zf.writestr(
                "Metadata/slice_info.config",
                f'<config><plate><metadata key="index" value="1"/>{nozzles}{filaments}</plate></config>',
            )
        return path

    def test_a_slot_on_the_right_extruder_prints_from_the_rack(self, tmp_path):
        """The slicer's right extruder (2) is the rack: the file's slot must
        reach the wire as the live dock position."""
        path = self._file(tmp_path, {1: 0, 3: 0}, {0: 2})
        assert resolve_rack_nozzle_mapping(extract_slot_extruders_from_3mf(path), RACK_ID)[:3] == [RACK_ID, -1, RACK_ID]

    def test_a_mixed_plate_levels_and_prints_on_the_right_nozzles(self, tmp_path):
        """Left slot → the fixed hotend (1), right slot → the dock — never the
        other way round, which is the print that ran in mid-air."""
        path = self._file(tmp_path, {1: 0, 2: 1}, {0: 1, 1: 2})
        assert resolve_rack_nozzle_mapping(extract_slot_extruders_from_3mf(path), RACK_ID)[:2] == [1, RACK_ID]

    def test_a_fixed_only_plate_names_no_nozzle(self, tmp_path):
        """With rack = 1 this plate went out naming a dock for the fixed side."""
        path = self._file(tmp_path, {1: 0, 2: 0}, {0: 1})
        assert resolve_rack_nozzle_mapping(extract_slot_extruders_from_3mf(path), RACK_ID) is None
