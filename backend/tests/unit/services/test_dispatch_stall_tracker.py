"""Repeated dispatch deferrals without progress, per printer and job (spec r3 R4)."""

import logging

import pytest

from backend.app.services import dispatch_stall_tracker as tracker

CLAIM = "dispatch_claim_changed"


class Clock:
    def __init__(self):
        self.now = 5000.0

    def __call__(self):
        return self.now

    def tick(self, seconds):
        self.now += seconds


@pytest.fixture
def clock(monkeypatch):
    fake = Clock()
    monkeypatch.setattr(tracker, "clock", fake)
    tracker.reset()
    yield fake
    tracker.reset()


def stalled(printer_id=7):
    return [e for e in tracker.snapshot(printer_id) if e.stalled]


def defer(clock, *, printer=7, item=11, detail="current_run_conflict", blocker=19, every=0.0, times=1):
    for _ in range(times):
        tracker.observe_deferral(printer, item, CLAIM, detail, blocker)
        clock.tick(every)


def test_three_failures_over_a_minute_are_a_stalled_episode(clock):
    defer(clock, every=30, times=3)
    (episode,) = stalled()
    assert (episode.printer_id, episode.item_id, episode.detail, episode.blocker_archive_id) == (
        7,
        11,
        "current_run_conflict",
        19,
    )
    assert episode.count == 3 and episode.span == 60


def test_three_failures_inside_a_minute_are_not_yet_a_stall(clock):
    defer(clock, every=10, times=3)
    assert not stalled()
    assert len(tracker.snapshot(7)) == 1


def test_two_failures_over_minutes_are_not_a_stall(clock):
    defer(clock, every=100, times=2)
    assert not stalled()


def test_the_span_starts_at_the_first_failure_not_at_the_oldest_kept_stamp(clock):
    """100 failures one second apart: the ring keeps 32, the episode still began 99 s ago."""
    defer(clock, every=1, times=100)
    clock.tick(-1)
    (episode,) = stalled()
    assert episode.count == 100 and episode.span == 99


def test_a_pause_longer_than_the_window_starts_a_new_episode(clock):
    defer(clock, every=30, times=3)
    clock.tick(301)
    defer(clock)
    episodes = tracker.snapshot(7)
    live = [e for e in episodes if e.active]
    assert len(live) == 1 and live[0].count == 1 and not live[0].stalled


def test_without_new_failures_an_episode_goes_inactive_not_resolved(clock):
    defer(clock, every=30, times=3)
    clock.tick(301)
    # Still there: silence is not progress, it only stops being current.
    (episode,) = tracker.snapshot(7)
    assert not episode.active and not episode.stalled


@pytest.mark.parametrize("change", ["blocker", "detail", "item"])
def test_a_different_blocker_detail_or_job_is_a_different_episode(clock, change):
    defer(clock, every=30, times=2)
    other = {"blocker": {"blocker": 20}, "detail": {"detail": "claim_restarted"}, "item": {"item": 12}}[change]
    defer(clock, **other)
    assert len(tracker.snapshot(7)) == 2
    assert not stalled()


def test_new_job_or_archive_ids_of_each_attempt_do_not_split_the_episode(clock):
    """The key holds no job or attempt archive: three attempts of one item behind one blocker are one episode."""
    for _ in range(3):
        tracker.observe_deferral(7, 11, CLAIM, "current_run_conflict", 19)
        clock.tick(30)
    assert len(tracker.snapshot(7)) == 1


def test_a_retry_is_a_new_incarnation(clock):
    defer(clock, every=30, times=2)
    tracker.new_incarnation(11)
    defer(clock, every=30, times=1)
    assert len(tracker.snapshot(7)) == 2
    assert not stalled()


def test_progress_resolves_the_episode_once(clock, caplog):
    defer(clock, every=30, times=3)
    with caplog.at_level(logging.INFO, logger=tracker.__name__):
        tracker.observe_progress(7, 11)
        tracker.observe_progress(7, 11)
    assert tracker.snapshot(7) == ()
    ended = [r for r in caplog.records if "stall ended" in r.getMessage()]
    assert len(ended) == 1 and "printer=7" in ended[0].getMessage() and "item=11" in ended[0].getMessage()


def test_progress_of_another_job_or_printer_resolves_nothing(clock):
    defer(clock, every=30, times=3)
    tracker.observe_progress(7, 12)
    tracker.observe_progress(8, 11)
    assert len(stalled()) == 1


def test_printers_are_never_summed(clock):
    for _ in range(3):
        tracker.observe_deferral(7, 11, CLAIM, "current_run_conflict", 19)
        tracker.observe_deferral(8, 11, CLAIM, "current_run_conflict", 19)
        clock.tick(30)
    assert len(stalled(7)) == 1 and len(stalled(8)) == 1


def test_one_warning_when_the_episode_crosses_the_threshold(clock, caplog):
    with caplog.at_level(logging.WARNING, logger=tracker.__name__):
        defer(clock, every=30, times=10)
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    message = warnings[0].getMessage()
    assert "printer=7" in message and "item=11" in message and "detail=current_run_conflict" in message
    assert "blocker_archive=19" in message


def test_a_single_race_is_an_ordinary_event(clock, caplog):
    with caplog.at_level(logging.WARNING, logger=tracker.__name__):
        defer(clock)
    assert not caplog.records and not stalled()


def test_routing_delays_are_not_runtime_stalls(clock):
    for _ in range(5):
        tracker.observe_deferral(7, 11, "feed_state_unavailable", None, None)
        clock.tick(30)
    assert tracker.snapshot(7) == ()


def test_the_tracker_is_bounded_and_says_so(clock, monkeypatch):
    monkeypatch.setattr(tracker, "MAX_EPISODES", 4)
    for item in range(6):
        tracker.observe_deferral(7, item, CLAIM, "current_run_conflict", 19)
        clock.tick(1)
    assert len(tracker.snapshot()) == 4
    assert tracker.coverage()["evicted"] == 2
    # the oldest went first
    assert {e.item_id for e in tracker.snapshot()} == {2, 3, 4, 5}


def test_inactive_episodes_expire(clock):
    defer(clock)
    clock.tick(1801)
    tracker.observe_deferral(8, 1, CLAIM, "claim_released", None)
    assert tracker.snapshot(7) == ()


def test_the_clock_is_monotonic_whatever_the_wall_clock_does(clock, monkeypatch):
    """A wall-clock jump (DST, NTP) cannot shorten or stretch an episode: only ``clock`` is read."""
    import time

    monkeypatch.setattr(time, "time", lambda: 0.0)
    defer(clock, every=30, times=3)
    assert len(stalled()) == 1


@pytest.mark.parametrize("args", [(None, 11), ("7", 11), (7, "x")])
def test_observing_never_raises_into_dispatch(clock, args):
    tracker.observe_deferral(*args, CLAIM, "current_run_conflict", 19)
    tracker.observe_progress(*args)
    tracker.new_incarnation(args[1])


def test_snapshot_is_immutable(clock):
    defer(clock, every=30, times=3)
    (episode,) = tracker.snapshot(7)
    with pytest.raises(AttributeError):
        episode.count = 0
