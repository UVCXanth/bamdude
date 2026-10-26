"""Repeated dispatch deferrals that make no progress, per printer and job (spec printer-runtime-stall r3 R4).

The dispatcher reports each pre-publish refusal of its claim here; nothing reads the localized text. An
episode is one printer, one queue item (and the item's incarnation -- a Retry starts a new one), one reason,
one detail and one blocker. A new dispatch job or execution archive per attempt never splits it: those ids are
not part of the key. It is *stalled* once at least ``MIN_FAILURES`` fresh failures fall inside the rolling
``WINDOW_SECONDS`` and it has lasted ``MIN_SPAN_SECONDS`` since its first failure -- measured from that first
failure, never from the oldest stamp the bounded ring still keeps.

Silence is not progress: an episode with no new failure goes inactive and expires, it is not "resolved".
Only an observed step past the failure point (``observe_progress``) ends it, with one log line.

Bounded and in memory on purpose: at most ``MAX_EPISODES`` episodes of ``MAX_STAMPS`` stamps each, inactive ones
dropped after ``INACTIVE_TTL_SECONDS``. Eviction and a restart shorten what it covers, and :func:`coverage` says
so. Every entry point swallows its own errors: an observer must never change a dispatch's outcome.
"""

from __future__ import annotations

import logging
import time
from collections import deque
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

#: The monotonic clock every interval is measured by (a test moves it).
clock = time.monotonic

WINDOW_SECONDS = 300.0
MIN_SPAN_SECONDS = 60.0
MIN_FAILURES = 3
MAX_EPISODES = 1024
MAX_STAMPS = 32
INACTIVE_TTL_SECONDS = 1800.0

#: The deferrals a runtime context can cause. Routing delays (filament, feed, source) are ordinary waits.
TRACKED_REASONS = frozenset({"dispatch_claim_changed"})


@dataclass
class _Episode:
    printer_id: int
    item_id: int | None
    reason: str
    detail: str | None
    blocker_archive_id: int | None
    first_seen: float
    last_seen: float
    stamps: deque = field(default_factory=lambda: deque(maxlen=MAX_STAMPS))
    count: int = 0
    warned: bool = False


@dataclass(frozen=True)
class EpisodeView:
    printer_id: int
    item_id: int | None
    reason: str
    detail: str | None
    blocker_archive_id: int | None
    count: int
    first_seen: float
    last_seen: float
    span: float
    #: A failure inside the window: the episode is current, not merely remembered.
    active: bool
    #: Over the threshold now (three fresh failures, a minute since the first, no progress).
    stalled: bool
    #: Crossed the threshold at some point -- an episode that went quiet since is inactive, not resolved.
    reached: bool = False
    #: Seconds since its last failure.
    quiet: float = 0.0


_episodes: dict[tuple, _Episode] = {}
_incarnations: dict[int, int] = {}
_evicted = 0
_started = clock()


def reset() -> None:
    """Forget everything -- a fresh process. For tests and a restore."""
    global _evicted, _started
    _episodes.clear()
    _incarnations.clear()
    _evicted = 0
    _started = clock()


def _fresh(episode: _Episode, now: float) -> int:
    return sum(1 for stamp in episode.stamps if now - stamp <= WINDOW_SECONDS)


def _is_stalled(episode: _Episode, now: float) -> bool:
    return _fresh(episode, now) >= MIN_FAILURES and episode.last_seen - episode.first_seen >= MIN_SPAN_SECONDS


def _prune(now: float) -> None:
    for key, episode in list(_episodes.items()):
        if now - episode.last_seen > INACTIVE_TTL_SECONDS:
            del _episodes[key]


def _key(printer_id: int, item_id: int | None, reason: str, detail: str | None, blocker: int | None) -> tuple:
    incarnation = _incarnations.get(item_id, 0) if item_id is not None else 0
    return printer_id, item_id, incarnation, reason, detail, blocker


def observe_deferral(
    printer_id: int, item_id: int | None, reason: str, detail: str | None, blocker_archive_id: int | None
) -> None:
    """One pre-publish refusal of a dispatch claim. Never raises."""
    try:
        _observe(printer_id, item_id, reason, detail, blocker_archive_id)
    except Exception:  # noqa: BLE001 - the dispatch outcome is decided elsewhere
        logger.warning("dispatch stall tracker could not record a deferral", exc_info=True)


def _observe(printer_id, item_id, reason, detail, blocker_archive_id) -> None:
    global _evicted
    if reason not in TRACKED_REASONS or type(printer_id) is not int:
        return
    if item_id is not None and type(item_id) is not int:
        return
    now = clock()
    _prune(now)
    key = _key(printer_id, item_id, reason, detail, blocker_archive_id)
    episode = _episodes.get(key)
    if episode is not None and now - episode.last_seen > WINDOW_SECONDS:
        del _episodes[key]  # a pause longer than the window: what follows is a new episode
        episode = None
    if episode is None:
        while len(_episodes) >= MAX_EPISODES:
            oldest = min(_episodes, key=lambda k: _episodes[k].last_seen)
            del _episodes[oldest]
            _evicted += 1
        episode = _Episode(printer_id, item_id, reason, detail, blocker_archive_id, first_seen=now, last_seen=now)
        _episodes[key] = episode
    episode.stamps.append(now)
    episode.count += 1
    episode.last_seen = now
    if not episode.warned and _is_stalled(episode, now):
        episode.warned = True
        logger.warning(
            "Dispatch stalled without progress: printer=%s item=%s reason=%s detail=%s blocker_archive=%s "
            "attempts=%d span=%ds",
            printer_id,
            item_id,
            reason,
            detail,
            blocker_archive_id,
            episode.count,
            int(episode.last_seen - episode.first_seen),
        )


def observe_progress(printer_id: int, item_id: int | None) -> None:
    """The dispatch of this job got past the point its episodes failed at: they end. Never raises."""
    try:
        for key, episode in list(_episodes.items()):
            if episode.printer_id == printer_id and episode.item_id == item_id:
                del _episodes[key]
                if episode.warned:
                    logger.info(
                        "Dispatch stall ended: printer=%s item=%s detail=%s after %d attempts",
                        printer_id,
                        item_id,
                        episode.detail,
                        episode.count,
                    )
    except Exception:  # noqa: BLE001
        logger.warning("dispatch stall tracker could not record progress", exc_info=True)


def new_incarnation(item_id: int | None) -> None:
    """The operator's Retry: what this item fails at from now on is a new episode. Never raises."""
    try:
        if type(item_id) is not int:
            return
        _incarnations[item_id] = _incarnations.pop(item_id, 0) + 1
        while len(_incarnations) > MAX_EPISODES:
            _incarnations.pop(next(iter(_incarnations)))
    except Exception:  # noqa: BLE001
        logger.warning("dispatch stall tracker could not record a retry", exc_info=True)


def snapshot(printer_id: int | None = None) -> tuple[EpisodeView, ...]:
    """Immutable views of the episodes, of one printer or of all, oldest first."""
    now = clock()
    try:
        _prune(now)  # the retention bound holds on a farm that stopped failing, not only on the next failure
    except Exception:  # noqa: BLE001 - reading must never fail on its housekeeping
        logger.warning("dispatch stall tracker could not drop expired episodes", exc_info=True)
    views = [
        EpisodeView(
            e.printer_id,
            e.item_id,
            e.reason,
            e.detail,
            e.blocker_archive_id,
            e.count,
            e.first_seen,
            e.last_seen,
            e.last_seen - e.first_seen,
            active=now - e.last_seen <= WINDOW_SECONDS,
            stalled=now - e.last_seen <= WINDOW_SECONDS and _is_stalled(e, now),
            reached=e.warned,
            quiet=now - e.last_seen,
        )
        for e in list(_episodes.values())
        if printer_id is None or e.printer_id == printer_id
    ]
    return tuple(sorted(views, key=lambda v: v.first_seen))


def coverage() -> dict:
    """What the tracker can vouch for: since when, how many episodes, how many it had to drop."""
    _prune(clock())
    return {"since": _started, "episodes": len(_episodes), "evicted": _evicted, "max_episodes": MAX_EPISODES}


def coverage_view() -> dict:
    """The part of :func:`coverage` an operator reads: how long it has been tracking, and what it dropped."""
    return {"since_seconds": int(clock() - _started), "evicted": _evicted}
