"""What the dispatcher does with a rack-position pick (upstream #1784, 3954d3a7).

The resolution itself is covered in ``test_nozzle_rack_positions.py``. This
covers the glue ``background_dispatch`` puts around it, where the two failure
modes deliberately differ:

- an **explicit** pick that no longer fits the rack is a refusal, because the
  operator named a hotend and printing from a different one is how a plate gets
  levelled on one nozzle and drawn with another, millimetres above the bed;
- an **assignment** that cannot be made falls through to the #2800 path (the
  live dock, or no ``nozzle_mapping`` at all), which is strictly not worse than
  the behaviour before any of this.

Upstream resolves this in its scheduler; here the one dispatch layer is
``background_dispatch``, which every print passes through — a queue item, a
direct print and a reprint alike — so the pick arrives as a job option: the
queue column's JSON text (string keys) or a direct request's parsed dict.
"""

import json
import zipfile
from types import SimpleNamespace

import pytest

from backend.app.services.background_dispatch import RackDispatch, _rack_dispatch

# Three filaments in groups 2/0/1, groups 1 and 2 both on the rack carriage —
# upstream's own plate, the one that printed in mid-air.
_BENCHY = (
    '<filament id="1" group_id="2" color="#DE4343" nozzle_diameter="0.40" volume_type="High Flow"/>'
    '<filament id="2" group_id="0" color="#F4EE2A" nozzle_diameter="0.40" volume_type="High Flow"/>'
    '<filament id="3" group_id="1" color="#0078BF" nozzle_diameter="0.40" volume_type="High Flow"/>'
    '<nozzle id="0" extruder_id="1"/><nozzle id="1" extruder_id="2"/><nozzle id="2" extruder_id="2"/>'
)
# One rack group and one fixed: the plate the #2800 fallback can still express.
_ONE_RACK_GROUP = (
    '<filament id="1" group_id="0" color="#FFFFFF" nozzle_diameter="0.40" volume_type="High Flow"/>'
    '<filament id="2" group_id="1" color="#000000" nozzle_diameter="0.40" volume_type="High Flow"/>'
    '<nozzle id="0" extruder_id="1"/><nozzle id="1" extruder_id="2"/>'
)

H2C = SimpleNamespace(model="H2C")
X1C = SimpleNamespace(model="X1C")


def _write(path, body):
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr(
            "Metadata/project_settings.config",
            json.dumps(
                {
                    "physical_extruder_map": ["1", "0"],
                    "extruder_max_nozzle_count": ["1", "6"],
                    "extruder_nozzle_stats": ["High Flow#1", "High Flow#6"],
                }
            ),
        )
        zf.writestr(
            "Metadata/slice_info.config",
            f'<config><plate><metadata key="index" value="1"/>{body}</plate></config>',
        )
    return path


def _rack(present=(1, 2, 3, 4, 5, 6)):
    """Live rack telemetry, plus the always-reported fixed carriage."""
    return [{"id": 15 + p, "diameter": "0.4", "type": "HH01", "filament_color": ""} for p in present] + [
        {"id": 1, "diameter": "0.4", "type": "HH01", "filament_color": ""}
    ]


@pytest.fixture
def benchy(tmp_path):
    return _write(tmp_path / "benchy.gcode.3mf", _BENCHY)


@pytest.fixture
def one_rack_group(tmp_path):
    return _write(tmp_path / "one.gcode.3mf", _ONE_RACK_GROUP)


class TestAPickThatStillFits:
    def test_the_chosen_positions_reach_the_wire(self, benchy):
        """R1 for group 2, R2 for group 1 is BambuStudio's own dispatch of this
        plate on 2026-08-14: nozzle_mapping [16, 1, 17]."""
        result = _rack_dispatch(H2C, benchy, 1, None, {2: 1, 1: 2}, _rack())

        assert result.refusal is None
        assert result.nozzle_mapping[:3] == [16, 1, 17]
        assert result.slot_extruders is None

    def test_a_different_pick_of_the_same_plate_sends_a_different_mapping(self, benchy):
        """The 2026-08-13 dispatch of the identical file: [16, 1, 18]."""
        result = _rack_dispatch(H2C, benchy, 1, None, {2: 1, 1: 3}, _rack())

        assert result.nozzle_mapping[:3] == [16, 1, 18]

    def test_the_queue_columns_json_form_reads_the_same(self, benchy):
        """A queue item stores the pick as JSON text, whose keys are strings."""
        result = _rack_dispatch(H2C, benchy, 1, None, json.dumps({"2": 1, "1": 3}), _rack())

        assert result.nozzle_mapping[:3] == [16, 1, 18]


class TestNoPickAtAll:
    def test_positions_are_assigned_rather_than_left_to_the_firmware(self, benchy):
        """The plate that used to dispatch with no mapping now gets one."""
        result = _rack_dispatch(H2C, benchy, 1, None, None, _rack())

        assert result == RackDispatch(nozzle_mapping=result.nozzle_mapping)
        assert result.nozzle_mapping[:3] == [17, 1, 16]

    def test_an_unassignable_multi_rack_plate_goes_out_without_a_mapping(self, benchy):
        """Nothing was promised, so letting the firmware pick breaks nothing —
        the #2800 path cannot express two rack hotends and names none."""
        result = _rack_dispatch(H2C, benchy, 1, None, None, _rack(present=()))

        assert result == RackDispatch()

    def test_an_unassignable_single_rack_plate_falls_back_to_the_live_dock(self, one_rack_group):
        """The #2800 path is kept: the MQTT layer sends the live dock."""
        result = _rack_dispatch(H2C, one_rack_group, 1, None, None, _rack(present=()))

        assert result.nozzle_mapping is None
        assert result.refusal is None
        assert json.loads(result.slot_extruders) == [1, 0]

    def test_an_unreadable_pick_is_treated_as_no_pick(self, benchy):
        result = _rack_dispatch(H2C, benchy, 1, None, "{not json", _rack())

        assert result.refusal is None
        assert result.nozzle_mapping[:3] == [17, 1, 16]


class TestAPickThatNoLongerFits:
    """Someone re-loaded the rack between choosing and dispatch."""

    def test_the_print_is_refused_rather_than_sent_to_another_hotend(self, benchy):
        result = _rack_dispatch(H2C, benchy, 1, None, {2: 1, 1: 3}, _rack(present=(1, 2)))

        assert result.nozzle_mapping is None
        assert result.slot_extruders is None
        assert result.refusal == "the printer reports nothing at rack position 3"

    def test_an_explicit_pick_on_a_plate_without_a_plan_is_not_refused(self, tmp_path):
        """No plan, nothing to check the pick against: the #2800 path decides."""
        path = tmp_path / "planless.gcode.3mf"
        with zipfile.ZipFile(path, "w") as zf:
            zf.writestr("Metadata/slice_info.config", "<config/>")
        result = _rack_dispatch(H2C, path, 1, None, {1: 3}, _rack())

        assert result == RackDispatch()


class TestLeftAlone:
    def test_a_non_rack_printer_is_untouched_even_with_a_pick(self, benchy):
        """The column can survive a move to another model; it must not then
        block a printer the pick never applied to."""
        assert _rack_dispatch(X1C, benchy, 1, None, {2: 1, 1: 3}, []) == RackDispatch()

    def test_a_bambustudio_capture_outranks_everything(self, benchy):
        """A Virtual Printer capture already carries the slicer's own pick."""
        captured = json.dumps([16, 1, 18] + [-1] * 29)
        assert _rack_dispatch(H2C, benchy, 1, captured, {2: 1, 1: 2}, _rack()) == RackDispatch()

    def test_no_file_means_nothing_to_resolve(self):
        assert _rack_dispatch(H2C, None, 1, None, {2: 1}, _rack()) == RackDispatch()
