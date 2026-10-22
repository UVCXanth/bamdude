"""Feed intervals: which physical tray fed a one-slot print, and which spool sat in it.

Spec vault 60-specs/usage-segment-attribution-spec. The tray chronology
(``state.tray_change_log``) and the usage journal are two sources of
boundaries; the attribution is their projection, read-only over both.
"""

from types import SimpleNamespace

import pytest

from backend.app.models.print_usage_event import (
    EVENT_RUNOUT,
    EVENT_SPOOL_LOADED,
    EVENT_START,
    EVENT_TRAY_CHANGE,
    KIND_AUTOSWITCH,
    KIND_MANUAL,
    KIND_PAUSE,
)
from backend.app.utils.usage_attribution import (
    FeedInterval,
    add_autoswitch_purge,
    feed_intervals,
    normalize_tray_changes,
    sole_feeding_tray,
)


def _events(rows):
    """rows: (event, kind, tray, layer, spool_id[, spoolman_id])"""
    out = []
    for idx, row in enumerate(rows, start=1):
        event, kind, tray, layer, spool_id, *rest = row
        out.append(
            SimpleNamespace(
                id=idx,
                event=event,
                kind=kind,
                global_tray_id=tray,
                layer_num=layer,
                spool_id=spool_id,
                spoolman_spool_id=rest[0] if rest else None,
                slot_occupied=None,
                archive_id=1,
                printer_id=1,
            )
        )
    return out


# Archive 4015 (BMCU on a P1S): the loader reports tray_now=254 for a moment on
# every (re)load, three times at layer 0 and once at the layer-9 refill.
BMCU_4015 = [(1, 0), (254, 0), (1, 0), (254, 0), (1, 0), (254, 0), (1, 0), (254, 9), (1, 9)]


class TestNormalizeTrayChanges:
    def test_bmcu_blips_collapse_to_the_one_tray_that_fed(self):
        assert normalize_tray_changes(BMCU_4015) == [(1, 0)]

    def test_a_blip_at_layer_zero_without_a_denominator_takes_no_grams(self):
        # Codex r1 probe: the equal-split fallback gave 33/33/33 to this input.
        assert normalize_tray_changes([(1, 0), (254, 0), (1, 0)]) == [(1, 0)]

    def test_a_real_switch_is_kept(self):
        assert normalize_tray_changes([(0, 0), (1, 37)]) == [(0, 0), (1, 37)]

    def test_a_real_return_after_printing_elsewhere_is_kept(self):
        assert normalize_tray_changes([(0, 0), (254, 5), (0, 9)]) == [(0, 0), (254, 5), (0, 9)]

    def test_the_open_last_interval_survives_a_layer_zero_start(self):
        assert normalize_tray_changes([(1, 0), (254, 0)]) == [(254, 0)]

    def test_the_raw_log_is_not_mutated(self):
        raw = list(BMCU_4015)
        normalize_tray_changes(raw)
        assert raw == BMCU_4015

    def test_empty_stays_empty(self):
        assert normalize_tray_changes([]) == []


class TestFeedIntervals:
    def test_a_return_to_a_refilled_inactive_tray_names_the_new_reel(self):
        """A runs out → backup B → A refilled while B feeds → printer returns to A."""
        events = _events(
            [
                (EVENT_START, None, 0, 0, 10, 110),
                (EVENT_RUNOUT, KIND_AUTOSWITCH, 0, 6, 10, 110),
                (EVENT_TRAY_CHANGE, None, 1, 6, 20, 120),
                (EVENT_SPOOL_LOADED, None, 0, 12, 30, 130),
                (EVENT_TRAY_CHANGE, None, 0, 20, 30, 130),
            ]
        )
        assert feed_intervals([(0, 0), (1, 6), (0, 20)], events) == [
            FeedInterval(0, 0, 10, 110, True),
            # The backup holds no spool boundary of its own: resolved as before.
            FeedInterval(6, 1, None, None, False),
            FeedInterval(20, 0, 30, 130, True),
        ]

    def test_a_return_with_no_spool_boundary_resolves_each_interval_as_before(self):
        """No runout/spool_loaded on a tray: its identity is not the journal's to name."""
        assert feed_intervals([(0, 0), (1, 37), (0, 60)], []) == [
            FeedInterval(0, 0, None, None, False),
            FeedInterval(37, 1, None, None, False),
            FeedInterval(60, 0, None, None, False),
        ]

    def test_a_same_tray_refill_inside_a_fed_interval_splits_at_the_load(self):
        events = _events(
            [
                (EVENT_TRAY_CHANGE, None, 0, 0, 10),
                (EVENT_RUNOUT, KIND_PAUSE, 0, 40, 10),
                (EVENT_SPOOL_LOADED, None, 0, 40, 11),
                (EVENT_TRAY_CHANGE, None, 1, 70, 20),
            ]
        )
        intervals = feed_intervals([(0, 0), (1, 70)], events)
        assert [(iv.start_layer, iv.tray, iv.spool_id) for iv in intervals] == [(0, 0, 10), (40, 0, 11), (70, 1, None)]
        assert intervals[-1].frozen is False

    def test_a_refill_assigned_after_resume_feeds_from_the_runout_layer(self):
        """The print stood at the runout layer until the new reel was in; the
        operator named it five layers later. The single-tray journal path
        splits at the runout — so must the intervals, or one tray move
        elsewhere in the print changes who printed layers 40-45."""
        events = _events(
            [
                (EVENT_TRAY_CHANGE, None, 0, 0, 10),
                (EVENT_RUNOUT, KIND_MANUAL, 0, 40, 10),
                (EVENT_SPOOL_LOADED, None, 0, 45, 11),
                (EVENT_TRAY_CHANGE, None, 1, 70, 20),
            ]
        )
        intervals = feed_intervals([(0, 0), (1, 70)], events)
        assert [(iv.start_layer, iv.tray, iv.spool_id) for iv in intervals] == [(0, 0, 10), (40, 0, 11), (70, 1, None)]

    def test_an_unknown_occupant_is_explicitly_unattributed(self):
        """A refill the journal could not name stays unattributed — never filled from the live slot."""
        events = _events(
            [
                (EVENT_TRAY_CHANGE, None, 0, 0, 10),
                (EVENT_RUNOUT, KIND_AUTOSWITCH, 0, 6, 10),
                (EVENT_TRAY_CHANGE, None, 1, 6, 20),
                (EVENT_SPOOL_LOADED, None, 0, 12, None),
                (EVENT_TRAY_CHANGE, None, 0, 20, None),
            ]
        )
        assert feed_intervals([(0, 0), (1, 6), (0, 20)], events)[-1] == FeedInterval(20, 0, None, None, True)

    def test_the_same_reel_returning_is_one_attribution_per_interval(self):
        """The same spool legitimately feeds two intervals — no dedupe by spool."""
        events = _events(
            [
                (EVENT_TRAY_CHANGE, None, 0, 0, 10),
                (EVENT_RUNOUT, KIND_MANUAL, 0, 5, 10),
                (EVENT_TRAY_CHANGE, None, 1, 5, 20),
                (EVENT_TRAY_CHANGE, None, 0, 30, 10),
            ]
        )
        intervals = feed_intervals([(0, 0), (1, 5), (0, 30)], events)
        assert [(iv.tray, iv.spool_id) for iv in intervals] == [(0, 10), (1, None), (0, 10)]

    @pytest.mark.parametrize("tray_changes", [[], [(1, 0)]])
    def test_a_single_tray_is_not_this_builders_question(self, tray_changes):
        assert feed_intervals(tray_changes, []) == []


@pytest.mark.parametrize(
    "log, expected",
    [
        # The tray left loaded at start, then the real feeder on layer 0.
        ([(0, 0), (1, 0)], 1),
        # Blips that all return to the same tray.
        ([(1, 0), (254, 0), (1, 0), (254, 0), (1, 0)], 1),
        # A real change: the split's question, not one tray.
        ([(0, 0), (1, 5)], None),
        # A log that never moved proves nothing new.
        ([(3, 0)], None),
        ([], None),
        (None, None),
    ],
)
def test_a_moved_log_that_collapses_names_the_tray_that_fed(log, expected):
    assert sole_feeding_tray(log) == expected


class TestAutoswitchPurge:
    """Spec: the purge of a real autoswitch is its own charge — it neither
    vanishes with a zero-length interval nor lands twice."""

    def test_it_lands_on_the_backup_interval_once(self):
        events = _events(
            [
                (EVENT_START, None, 0, 0, 10),
                (EVENT_RUNOUT, KIND_AUTOSWITCH, 0, 50, 10),
                (EVENT_TRAY_CHANGE, None, 1, 50, 20),
            ]
        )
        intervals = feed_intervals([(0, 0), (1, 50)], events)
        charged, grams = add_autoswitch_purge(intervals, [40.0, 60.0], events, 5.0)
        assert charged == intervals
        assert grams == [40.0, 65.0]

    def test_a_backup_that_normalized_away_still_takes_its_purge(self):
        """The backup fed the purge on the runout layer and nothing the layer
        number sees: its interval is gone, the purge goes to the reel the
        journal froze for it."""
        events = _events(
            [
                (EVENT_START, None, 0, 0, 10),
                (EVENT_RUNOUT, KIND_AUTOSWITCH, 0, 9, 10),
                (EVENT_TRAY_CHANGE, None, 1, 9, 20),
                (EVENT_TRAY_CHANGE, None, 0, 9, 11),
                (EVENT_TRAY_CHANGE, None, 2, 50, 30),
            ]
        )
        intervals = feed_intervals([(0, 0), (1, 9), (0, 9), (2, 50)], events)
        assert all(iv.tray != 1 for iv in intervals)
        charged, grams = add_autoswitch_purge(intervals, [10.0] * len(intervals), events, 5.0)
        assert charged[: len(intervals)] == intervals
        assert charged[len(intervals) :] == [FeedInterval(9, 1, 20, None, True)]
        assert grams == [10.0] * len(intervals) + [5.0]

    def test_no_purge_setting_adds_nothing(self):
        events = _events([(EVENT_RUNOUT, KIND_AUTOSWITCH, 0, 9, 10), (EVENT_TRAY_CHANGE, None, 1, 9, 20)])
        intervals = feed_intervals([(0, 0), (2, 50)], events)
        assert add_autoswitch_purge(intervals, [1.0, 2.0], events, 0.0) == (intervals, [1.0, 2.0])
