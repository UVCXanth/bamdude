"""A runout-tail episode in the shared usage projection (post-rebuild F-R4 / F-R5).

Both inventory writers and the live projection read ``journal_boundaries_for_tray`` (one
tray) and ``feed_intervals`` (a moved chronology), so a tail episode is attributed the same
way everywhere: the origin's old reel up to the layer the feed came back, the reel bound at
that moment from then on. An assignment during the tail is an identity note, never a
boundary; a return first seen after an observation gap leaves the unobserved stretch
unrecorded. Spec: vault ``60-specs/ams-tail-refill-attribution-spec.md``, rows F01, F02, F04,
F06, F07, F08.
"""

from itertools import count
from types import SimpleNamespace

from backend.app.models.print_usage_event import (
    EVENT_FEED_RETURN,
    EVENT_RUNOUT,
    EVENT_SPOOL_LOADED,
    EVENT_START,
    EVENT_TAIL_START,
    EVENT_TRAY_CHANGE,
    KIND_GAP,
    KIND_PAUSE,
)
from backend.app.services.usage_tracker import journal_boundaries_for_tray
from backend.app.utils.tray_split import compute_layer_segment_grams
from backend.app.utils.usage_attribution import FeedInterval, feed_intervals

OLD, NEW, NEXT = 309, 313, 314
T0 = 0


class Journal:
    def __init__(self):
        self.ids = count(1)
        self.events = []

    def add(self, event, layer, tray=T0, spool=None, kind=None):
        self.events.append(
            SimpleNamespace(
                id=next(self.ids),
                printer_id=10,
                archive_id=1006,
                event=event,
                kind=kind,
                global_tray_id=tray,
                layer_num=layer,
                spool_id=spool,
                spoolman_spool_id=spool + 1000 if spool else None,
                slot_occupied=True,
            )
        )
        return self


def boundaries(journal, tray=T0):
    return [(layer, spool) for layer, spool, _ in journal_boundaries_for_tray(journal.events, tray)]


def incident():
    """X2D, archive 1006: tail at layer 40, new reel put in and assigned, the pause-runout of
    the OLD reel's tube at 42, the feed back on tray 0 at 42."""
    return (
        Journal()
        .add(EVENT_START, 0, spool=OLD)
        .add(EVENT_TAIL_START, 40, spool=OLD)
        .add(EVENT_SPOOL_LOADED, 41, spool=NEW)
        .add(EVENT_RUNOUT, 42, spool=OLD, kind=KIND_PAUSE)
        .add(EVENT_FEED_RETURN, 42, spool=NEW)
    )


def test_the_incident_charges_the_old_reel_to_the_return_and_the_new_reel_after_it():
    """F01."""
    assert boundaries(incident()) == [(0, OLD), (42, NEW)]


def test_both_backends_read_the_same_frozen_ids():
    """F08: the Spoolman ids ride the same boundaries."""
    segs = journal_boundaries_for_tray(incident().events, T0)
    assert [s[2] for s in segs] == [OLD + 1000, NEW + 1000]


def test_a_tail_without_a_pause_splits_at_the_return_not_at_the_assignment():
    """F02: the assignment at 41 is identity only; the reel fed from the return at 45."""
    j = (
        Journal()
        .add(EVENT_START, 0, spool=OLD)
        .add(EVENT_TAIL_START, 40, spool=OLD)
        .add(EVENT_SPOOL_LOADED, 41, spool=NEW)
        .add(EVENT_FEED_RETURN, 45, spool=NEW)
    )
    assert boundaries(j) == [(0, OLD), (45, NEW)]


def test_a_return_first_seen_after_a_gap_leaves_the_gap_unrecorded():
    """F04: last proven tail layer 42 (the runout) → first fresh origin layer 50 is unknown."""
    j = (
        Journal()
        .add(EVENT_START, 0, spool=OLD)
        .add(EVENT_TAIL_START, 40, spool=OLD)
        .add(EVENT_RUNOUT, 42, spool=OLD, kind=KIND_PAUSE)
        .add(EVENT_FEED_RETURN, 50, spool=NEW, kind=KIND_GAP)
    )
    assert boundaries(j) == [(0, OLD), (42, None), (50, NEW)]


def test_a_gap_return_without_a_runout_starts_the_unknown_at_the_tail_start():
    j = (
        Journal()
        .add(EVENT_START, 0, spool=OLD)
        .add(EVENT_TAIL_START, 40, spool=OLD)
        .add(EVENT_FEED_RETURN, 50, spool=NEW, kind=KIND_GAP)
    )
    assert boundaries(j) == [(0, OLD), (40, None), (50, NEW)]


def test_an_episode_left_open_after_its_runout_names_nobody_after_it():
    """F-R4: without a feed_return no boundary is invented, and the old reel is not handed the
    rest either — the stretch after the tail ran out is not recorded."""
    j = (
        Journal()
        .add(EVENT_START, 0, spool=OLD)
        .add(EVENT_TAIL_START, 40, spool=OLD)
        .add(EVENT_SPOOL_LOADED, 41, spool=NEW)
        .add(EVENT_RUNOUT, 42, spool=OLD, kind=KIND_PAUSE)
    )
    assert boundaries(j) == [(0, OLD), (42, None)]


def test_a_tail_that_fed_to_the_end_is_no_split():
    """The tube fed the rest of the print: the old reel's, as it always was."""
    j = Journal().add(EVENT_START, 0, spool=OLD).add(EVENT_TAIL_START, 40, spool=OLD)
    assert boundaries(j) == []


def test_the_new_reels_real_runout_after_the_return_counts():
    """F06: after feed_return a runout belongs to the new feed and splits normally."""
    j = incident().add(EVENT_RUNOUT, 80, spool=NEW, kind=KIND_PAUSE).add(EVENT_SPOOL_LOADED, 81, spool=NEXT)
    assert boundaries(j) == [(0, OLD), (42, NEW), (80, NEXT)]


def test_a_raw_sentinel_change_inside_the_episode_is_noise():
    """F07: a legacy tray_change on 254 inside the episode neither closes it nor feeds."""
    j = (
        Journal()
        .add(EVENT_START, 0, spool=OLD)
        .add(EVENT_TAIL_START, 40, spool=OLD)
        .add(EVENT_TRAY_CHANGE, 41, tray=254)
        .add(EVENT_FEED_RETURN, 42, spool=NEW)
    )
    assert boundaries(j) == [(0, OLD), (42, NEW)]


def test_two_episodes_of_one_print():
    """F07."""
    j = (
        incident()
        .add(EVENT_TAIL_START, 90, spool=NEW)
        .add(EVENT_SPOOL_LOADED, 91, spool=NEXT)
        .add(EVENT_FEED_RETURN, 93, spool=NEXT)
    )
    assert boundaries(j) == [(0, OLD), (42, NEW), (93, NEXT)]


def test_known_and_unrecorded_weight_add_up():
    """F08: the gap's share is reported, not lost — every gram is known or unrecorded."""
    j = (
        Journal()
        .add(EVENT_START, 0, spool=OLD)
        .add(EVENT_TAIL_START, 40, spool=OLD)
        .add(EVENT_FEED_RETURN, 50, spool=NEW, kind=KIND_GAP)
    )
    segs = journal_boundaries_for_tray(j.events, T0)
    grams = compute_layer_segment_grams(
        boundary_layers=[s[0] for s in segs],
        total_weight=100.0,
        slot_id=1,
        layer_usage=None,
        density=1.24,
        diameter=1.75,
        total_layers=100,
        last_layer_num=100,
    )
    assert round(sum(grams), 6) == 100.0
    assert [s[1] for s in segs] == [OLD, None, NEW] and all(g > 0 for g in grams)


def test_a_moved_chronology_reads_the_episode_on_the_origins_interval():
    """F05/F08: the print later moved to tray 3 — the origin's interval splits at the return.
    Tray 3 has no spool boundary of its own, so its writer resolves it as before."""
    j = incident().add(EVENT_TRAY_CHANGE, 60, tray=3, spool=NEXT)
    intervals = feed_intervals([(T0, 0), (3, 60)], j.events)
    assert intervals == [
        FeedInterval(0, T0, OLD, OLD + 1000, True),
        FeedInterval(42, T0, NEW, NEW + 1000, True),
        FeedInterval(60, 3, None, None, False),
    ]


def test_a_journal_without_tail_events_reads_as_before():
    """F08 legacy: no new events — the existing per-runout rules, untouched."""
    j = (
        Journal()
        .add(EVENT_START, 0, spool=OLD)
        .add(EVENT_RUNOUT, 42, spool=OLD, kind=KIND_PAUSE)
        .add(EVENT_SPOOL_LOADED, 45, spool=NEW)
    )
    assert boundaries(j) == [(0, OLD), (42, NEW)]


# ── F-R4 / M2 · a stretch nobody observed is unrecorded, never the old chronology's ──


def test_an_unknown_feed_is_an_unrecorded_interval_between_known_ones():
    """M2: the chronology says the feed is unknown from layer 40 (lost observations); the
    tray observed again at 60 is charged from there, the stretch between goes unrecorded —
    not to the tray the old chronology ended on."""
    from backend.app.utils.usage_attribution import UNKNOWN_FEED

    j = Journal().add(EVENT_START, 0, spool=OLD).add(EVENT_TRAY_CHANGE, 60, tray=3, spool=NEXT)
    intervals = feed_intervals([(T0, 0), (UNKNOWN_FEED, 40), (3, 60)], j.events)
    assert intervals == [
        FeedInterval(0, T0, None, None, False),  # no boundary of its own: the writer resolves it
        FeedInterval(40, UNKNOWN_FEED, None, None, True),  # explicitly nobody's
        FeedInterval(60, 3, None, None, False),
    ]
    grams = compute_layer_segment_grams(
        boundary_layers=[iv.start_layer for iv in intervals],
        total_weight=100.0,
        slot_id=1,
        layer_usage=None,
        density=1.24,
        diameter=1.75,
        total_layers=100,
        last_layer_num=100,
    )
    assert round(sum(grams), 6) == 100.0 and all(g > 0 for g in grams)


def test_an_unknown_feed_is_never_the_tray_that_fed_the_whole_print():
    from backend.app.utils.usage_attribution import UNKNOWN_FEED, sole_feeding_tray

    assert sole_feeding_tray([(T0, 40), (UNKNOWN_FEED, 40)]) is None


def test_an_unknown_feed_closes_a_tail_nobody_saw_end():
    """Review r1 #2: the latch was dropped for lost reports — the journal's open episode closes
    at the unknown feed, so a later tail of the tray opens its own and a later runout is not
    handed the stale reel."""
    from backend.app.services.print_usage_journal import open_tail_episode, tail_episodes
    from backend.app.utils.usage_attribution import UNKNOWN_FEED

    j = (
        Journal()
        .add(EVENT_START, 0, spool=OLD)
        .add(EVENT_TAIL_START, 40, spool=OLD)
        .add(EVENT_TRAY_CHANGE, 45, tray=UNKNOWN_FEED)
    )
    episodes = tail_episodes(j.events)
    assert len(episodes) == 1 and episodes[0].close is not None
    assert open_tail_episode(j.events) is None
