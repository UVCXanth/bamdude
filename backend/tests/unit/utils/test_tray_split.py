"""Pure-logic tests for the weight-split math shared by both inventory writers.

The helper lives in ``backend/app/utils/tray_split.py`` and is exercised by both inventory
backends (``usage_tracker`` and ``spoolman_tracking``). These tests pin it so a change in one
caller can't silently break the other — cross-inventory parity is a HARD RULE for this
project. Every expectation below is a constant worked out by hand from the stated layers
(spec partial-print-layer-split r2 §6), never a call of the helper itself.
"""

from __future__ import annotations

import pytest

from backend.app.utils.tray_split import (
    TERMINAL_LAYER_NUM,
    TERMINAL_PROGRESS,
    TERMINAL_TOTAL_LAYERS,
    CompletionSnapshot,
    PrintedBound,
    printed_bound,
    sole_owner,
    split_weight,
    terminal_snapshot_fields,
)
from backend.app.utils.usage_attribution import UNKNOWN_FEED, not_recorded_tray

#: One unit of extrusion per layer for filament 0 over a 200-layer plate: a G-code timeline
#: on which a share of layers is the same share of extrusion, so the oracle stays arithmetic.
LINEAR_TIMELINE = {layer: {0: float(layer)} for layer in range(201)}


def partial(layer: int, total: int | None = 200) -> PrintedBound:
    return PrintedBound(completed=False, layer=layer, source="current", total_layers=total)


def completed(layer: int | None) -> PrintedBound:
    return PrintedBound(completed=True, layer=layer, source="total_layers" if layer else "none", total_layers=layer)


def approx(values: list[float]) -> list:
    return [pytest.approx(v, abs=1e-9) for v in values]


class TestPrintedBound:
    """H is chosen once, from the completion event alone (R2)."""

    def test_a_completed_print_divides_up_to_its_plate(self):
        bound = printed_bound(completed=True, snapshot=CompletionSnapshot(layer_num=200, total_layers=200))
        assert (bound.layer, bound.source) == (200, "total_layers")

    def test_a_lagging_captured_layer_never_shortens_a_known_plate(self):
        """A18: at FINISH without a reset the captured layer is the one before the last."""
        bound = printed_bound(completed=True, snapshot=CompletionSnapshot(total_layers=200, captured_layer=199))
        assert bound.layer == 200

    @pytest.mark.parametrize(
        "snapshot, expected",
        [
            (CompletionSnapshot(layer_num=50, captured_layer=40), (50, "current")),
            (CompletionSnapshot(captured_layer=40), (40, "captured")),
            (CompletionSnapshot(), (None, "none")),
        ],
    )
    def test_a_completed_print_with_its_plate_count_reset(self, snapshot, expected):
        """P1S firmware zeroes the layer count at print end: the terminal, then the captured layer."""
        bound = printed_bound(completed=True, snapshot=snapshot)
        assert (bound.layer, bound.source) == expected

    def test_a_stopped_print_takes_its_terminal_layer_over_the_captured_one(self):
        """A04: the captured hint is the layer BEFORE the last report — it lags a live counter."""
        bound = printed_bound(
            completed=False, snapshot=CompletionSnapshot(layer_num=50, total_layers=200, captured_layer=40)
        )
        assert (bound.layer, bound.source) == (50, "current")

    def test_a_stopped_print_whose_layer_was_reset_takes_the_captured_one(self):
        """A03/A04: firmware zeroed the layer on cancel."""
        bound = printed_bound(completed=False, snapshot=CompletionSnapshot(layer_num=None, captured_layer=40))
        assert (bound.layer, bound.source) == (40, "captured")

    def test_the_plate_count_alone_is_no_boundary_for_a_stopped_print(self):
        """A08: L, a journal boundary or a full G-code timeline say nothing about where it stopped."""
        bound = printed_bound(completed=False, snapshot=CompletionSnapshot(total_layers=200, progress=25.0))
        assert bound.layer is None

    def test_a_layer_past_the_plate_is_no_boundary(self):
        bound = printed_bound(completed=False, snapshot=CompletionSnapshot(layer_num=250, total_layers=200))
        assert bound.layer is None and bound.source == "current_past_total"

    @pytest.mark.parametrize("value", [True, False, -5, 0, "50", 50.5, float("nan"), None, [50]])
    def test_a_coercion_is_not_evidence(self, value):
        """R2.8: a bool, a negative, a string or a fraction is not a layer the printer reported."""
        snapshot = CompletionSnapshot.from_event({TERMINAL_LAYER_NUM: value, "last_layer_num": value})
        assert (snapshot.layer_num, snapshot.captured_layer) == (None, None)

    def test_the_event_carries_its_own_figures(self):
        data = {
            "status": "failed",
            "last_layer_num": 40,
            "last_progress": 24.0,
            **terminal_snapshot_fields(layer_num=50, total_layers=200, progress=25.0),
        }
        assert CompletionSnapshot.from_event(data) == CompletionSnapshot(
            layer_num=50, total_layers=200, progress=25.0, captured_layer=40, captured_progress=24.0
        )

    def test_an_event_without_the_figures_knows_only_its_captured_hints(self):
        """A24: nothing missing is filled in — the printer is not asked again."""
        snapshot = CompletionSnapshot.from_event({"status": "failed", "last_layer_num": 40})
        assert snapshot == CompletionSnapshot(captured_layer=40)
        assert snapshot.progress_percent is None

    def test_the_terminal_keys_are_the_ones_the_event_is_read_by(self):
        assert set(terminal_snapshot_fields(layer_num=1, total_layers=2, progress=3.0)) == {
            TERMINAL_LAYER_NUM,
            TERMINAL_TOTAL_LAYERS,
            TERMINAL_PROGRESS,
        }

    def test_progress_falls_back_to_the_captured_value(self):
        assert CompletionSnapshot(captured_progress=24.0).progress_percent == 24.0
        assert CompletionSnapshot(progress=25.0, captured_progress=24.0).progress_percent == 25.0


class TestLinearSplit:
    """No G-code for the slot: the layer ratio within the printed stretch [0, H] (R4)."""

    def test_a_stopped_print_divides_what_it_printed(self):
        """A01: 10 g printed up to layer 50 of 200, reel B from 40 → A 40/50, B 10/50."""
        assert split_weight([0, 40], 10.0, 1, None, partial(50)).grams == approx([8.0, 2.0])

    def test_a_completed_print_divides_its_whole_plate(self):
        """A02: the same boundaries, printed to the end."""
        assert split_weight([0, 40], 10.0, 1, None, completed(200)).grams == approx([2.0, 8.0])

    def test_a_reset_plate_count_with_a_captured_layer(self):
        """A03: L=0 after the firmware's reset, captured layer 50."""
        bound = printed_bound(completed=False, snapshot=CompletionSnapshot(captured_layer=50))
        assert split_weight([0, 40], 10.0, 1, None, bound).grams == approx([8.0, 2.0])

    @pytest.mark.parametrize(
        "boundaries, expected",
        [
            ([0, 50], [10.0, 0.0]),  # the reel arrived on the last printed layer
            ([0, 40, 60], [8.0, 2.0, 0.0]),  # a boundary past the stop prints nothing
            ([0, 40, 50], [8.0, 2.0, 0.0]),
            ([0, 0, 40], [0.0, 8.0, 2.0]),  # A12: a duplicate at layer 0 fed nothing
        ],
    )
    def test_stretches_are_clipped_to_the_printed_boundary(self, boundaries, expected):
        """A05/A12: nothing at or past H gets a gram — nor the rounding remainder."""
        assert split_weight(boundaries, 10.0, 1, None, partial(50)).grams == approx(expected)

    @pytest.mark.parametrize(
        "weight, boundaries, horizon",
        [
            (10.0, [0, 17, 33, 60], 50),
            # Weights and layers whose float shares do not add up exactly: the drift exists.
            (0.1, [0, 29, 31, 60], 41),
            (0.3, [0, 7, 19, 60], 47),
            (7.3, [0, 7, 31, 60], 41),
        ],
    )
    def test_the_rounding_remainder_never_reaches_a_stretch_that_printed_nothing(self, weight, boundaries, horizon):
        """R7: a stretch past the stop gets exactly 0 — even a 1e-17 g would be a charge row for a
        reel that never fed this print."""
        grams = split_weight(boundaries, weight, 1, None, partial(horizon)).grams
        assert grams[3] == 0.0
        assert sum(grams) == pytest.approx(weight, abs=1e-12)

    @pytest.mark.parametrize("weight", [7.3, 0.1, 123.456])
    def test_fractional_weights_add_up(self, weight):
        """A13."""
        grams = split_weight([0, 13, 29], weight, 1, None, partial(41)).grams
        assert sum(grams) == pytest.approx(weight, abs=1e-12) and all(g >= 0 for g in grams)

    def test_a_zero_weight_divides_into_zeros(self):
        assert split_weight([0, 40], 0.0, 1, None, partial(50)).grams == [0.0, 0.0]

    def test_a_stretch_before_the_first_boundary_is_nobodys(self):
        """A13: coverage starting at 10 leaves layers 0–10 to no reel, not to the first or last."""
        split = split_weight([10, 40], 10.0, 1, None, partial(50))
        assert split.grams == approx([6.0, 2.0])
        assert split.unknown_start == pytest.approx(2.0)

    @pytest.mark.parametrize("boundaries", [[0, 40, 30], [-1, 40], [0, True], [0, 40.0], [0, "40"]])
    def test_a_geometry_no_projection_made_usable_divides_nothing(self, boundaries):
        """A13: never sorted or coerced into a split."""
        assert split_weight(boundaries, 10.0, 1, None, partial(50)) is None

    def test_one_stretch_from_the_start_is_the_whole_weight_without_any_boundary(self):
        assert split_weight([0], 10.0, 1, None, PrintedBound(False, None, "none")).grams == [10.0]

    def test_no_printed_boundary_divides_nothing(self):
        """A08: never an equal share, never the remainder to the last reel."""
        assert split_weight([0, 40], 10.0, 1, None, PrintedBound(False, None, "none", 200)) is None
        assert split_weight([0, 40], 10.0, 1, None, PrintedBound(True, None, "none")) is None


class TestGcodeSplit:
    """The slot's own G-code timeline measures each stretch (R5)."""

    def test_a_stopped_print_divides_its_own_timeline_up_to_the_boundary(self):
        """A06: one unit a layer — the same 8/2 as the layer ratio."""
        assert split_weight([0, 40], 10.0, 1, LINEAR_TIMELINE, partial(50)).grams == approx([8.0, 2.0])

    def test_boundaries_past_the_stop_print_nothing_and_never_go_negative(self):
        """A06: the old helper left the last stretch −6 g here."""
        grams = split_weight([0, 40, 60, 80], 10.0, 1, LINEAR_TIMELINE, partial(50)).grams
        assert grams == approx([8.0, 2.0, 0.0, 0.0])

    def test_another_slots_timeline_is_no_scale_for_this_one(self):
        """A07: G-code for slot 2 only — slot 1 takes the layer ratio."""
        other_slot = {0: {1: 0.0}, 200: {1: 200.0}}
        assert split_weight([0, 40], 10.0, 1, other_slot, partial(50)).grams == approx([8.0, 2.0])

    def test_a_timeline_that_printed_nothing_by_the_stop_falls_to_the_layer_ratio(self):
        starts_late = {0: {0: 0.0}, 60: {0: 0.0}, 200: {0: 140.0}}
        assert split_weight([0, 40], 10.0, 1, starts_late, partial(50)).grams == approx([8.0, 2.0])

    def test_a_timeline_that_runs_backwards_measures_nothing(self):
        broken = {0: {0: 0.0}, 40: {0: 100.0}, 45: {0: 60.0}, 50: {0: 80.0}, 200: {0: 300.0}}
        assert split_weight([0, 40, 45], 10.0, 1, broken, partial(50)).grams == approx([8.0, 1.0, 1.0])

    def test_a_stopped_print_with_gcode_but_no_boundary_divides_nothing(self):
        """A08: the full timeline does not say where a stopped print stopped."""
        assert split_weight([0, 40], 10.0, 1, LINEAR_TIMELINE, PrintedBound(False, None, "none", 200)) is None

    def test_a_completed_print_needs_no_boundary_with_its_slots_timeline(self):
        """A17: L, the terminal and the captured layer all unknown — the timeline to its end."""
        bound = printed_bound(completed=True, snapshot=CompletionSnapshot())
        assert split_weight([0, 40], 10.0, 1, LINEAR_TIMELINE, bound).grams == approx([2.0, 8.0])

    def test_a_completed_print_is_measured_on_the_whole_timeline_not_a_lagging_layer(self):
        """A18: the old helper normalised at the captured layer 199 and gave 2.01/7.99."""
        bound = PrintedBound(completed=True, layer=199, source="captured")
        assert split_weight([0, 40], 10.0, 1, LINEAR_TIMELINE, bound).grams == approx([2.0, 8.0])

    def test_a_completed_print_past_its_slots_last_extrusion_gives_the_rest_nothing(self):
        ends_at_100 = {layer: {0: float(min(layer, 100))} for layer in range(201)}
        grams = split_weight([0, 40, 150], 10.0, 1, ends_at_100, completed(None)).grams
        assert grams == approx([4.0, 6.0, 0.0])

    def test_slot_id_maps_to_the_zero_based_filament_id(self):
        layer_usage = {0: {0: 0.0, 1: 0.0}, 10: {0: 0.0, 1: 50.0}, 20: {0: 0.0, 1: 100.0}}
        assert split_weight([0, 10], 1.0, 2, layer_usage, completed(20)).grams == approx([0.5, 0.5])

    class TestCancelledPrintFromTheFarm:
        """Printer 5, archive 822 (2026-08-31): reel swapped at layer 227, jam at 405, cancelled;
        259.3 g of a 364.95 g plate. The G-code timeline says 169 / 90."""

        LAYER_USAGE = {0: {0: 0.0}, 227: {0: 462.8}, 405: {0: 709.2}, 570: {0: 1000.0}}

        def test_the_printed_portion_is_divided(self):
            first, second = split_weight([0, 227], 259.3, 1, self.LAYER_USAGE, partial(405, 570)).grams
            assert (round(first, 1), round(second, 1)) == (169.2, 90.1)

        def test_the_completed_plate_is_divided_whole(self):
            first, second = split_weight([0, 227], 364.95, 1, self.LAYER_USAGE, completed(570)).grams
            assert round(first, 1) == round(364.95 * 0.4628, 1)
            assert round(first + second, 2) == 364.95


class TestSoleOwnerAndLabel:
    def test_the_same_reel_in_every_stretch_is_one_owner(self):
        assert sole_owner([(0, 7), (40, 7), (60, 7)]) == 7

    @pytest.mark.parametrize(
        "stretches",
        [
            [(0, 7), (40, 8)],
            [(0, 7), (40, None)],
            [(0, None)],
            [],
            # R6: proven only from layer 10 — what fed layers 0–10 is nobody's to give it.
            [(10, 7), (40, 7)],
        ],
    )
    def test_anything_else_is_no_owner(self, stretches):
        assert sole_owner(stretches) is None

    def test_reels_of_one_tray_are_reported_under_that_tray(self):
        assert not_recorded_tray([3, 3]) == 3

    @pytest.mark.parametrize("trays", [[3, 4], [3, UNKNOWN_FEED], [UNKNOWN_FEED]])
    def test_several_trays_or_an_unseen_feed_are_reported_as_unknown(self, trays):
        assert not_recorded_tray(trays) == UNKNOWN_FEED
