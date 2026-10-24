"""Which physical tray fed a one-slot print, and which spool sat in it.

A projection over two sources of boundaries, read-only over both:

* the tray chronology — ``state.tray_change_log``, written by ``bambu_mqtt``
  every time ``tray_now`` moves during a print;
* the usage journal (``print_usage_events``) — spool identities frozen at the
  moment they changed: the print start, a tray change, a reel loaded into a
  slot, a runout.

Both inventory writers (``usage_tracker`` and ``spoolman_tracking``) read the
same intervals, so they cannot attribute a print differently.

⚠️ Each interval is charged exactly once, and the same spool may legitimately
feed several of them (a print that leaves a tray and comes back to it). The
writers once skipped a tray they had already charged, which silently dropped
every later stretch of it — a P1S with a BMCU reports ``tray_now=254`` for a
moment on every load, so a refill mid-print came back to the same tray and the
new reel's whole share was lost (vault ``bmcu-same-tray-segment-loss``).

The single-tray case (a normalized chronology of at most one entry) is not
this module's question: the journal's own per-tray boundaries
(``usage_tracker.journal_boundaries_for_tray``) answer it, as before.
"""

from __future__ import annotations

from dataclasses import dataclass

#: A tray chronology entry for a stretch nobody observed (post-rebuild F-R4): tray reports
#: lost while a joined print's journal waited for its seed, or a seed that never came. From
#: its layer to the next entry the feed is unknown — an explicitly unattributed interval,
#: never the tray the chronology named before it.
UNKNOWN_FEED = -1


@dataclass(frozen=True)
class FeedInterval:
    """One stretch of the print fed from one tray by one spool.

    ``frozen`` says who names the spool. True: the journal named it, and a
    ``None`` id is explicitly unattributed — the live slot assignment must not
    fill the gap against a journal boundary. False: the journal holds no spool
    boundary for this tray, so the writer resolves it as it always has (start
    snapshot, live assignment, Spoolman tag).
    """

    start_layer: int
    tray: int
    spool_id: int | None
    spoolman_spool_id: int | None
    frozen: bool


def chronology_splits(tray_changes: list[tuple[int, int]] | None) -> bool:
    """Does a NORMALIZED chronology decide the print's attribution interval by interval?

    When it moved between trays — and when it names a feed nobody observed, even as its only
    entry: an explicit unknown is evidence, and must reach the same not-recorded attribution
    as an unknown among several, never the single-tray ladder that would charge a reel. An
    empty chronology is no evidence at all and keeps the ladder.
    """
    entries = list(tray_changes or [])
    return len(entries) > 1 or any(tray == UNKNOWN_FEED for tray, _layer in entries)


def chronology_with_journal(
    tray_changes: list[tuple[int, int]] | None, journal_events: list | None
) -> list[tuple[int, int]]:
    """The raw chronology a writer reads, reconciled with the unknown feeds the journal holds
    (post-rebuild F5).

    The chronology lives in the MQTT client's memory; an unknown feed the journal stated while no
    client could take it (a restart replay that could not be written) is in the journal only. A
    persisted ``UNKNOWN_FEED`` row the memory does not hold makes the memory stale from its
    layer: what came before stays, the unknown feed follows, and after it only what the journal
    recorded after the marker — the next real feed closes the stretch; what the stale memory says
    about it is not believed. When the memory holds the marker, the tray changes after it are the
    memory's and the journal's together: a later feed the journal recorded is never hidden.

    ``tray_changes`` None: there is no memory at all (no printer state, post-rebuild F6) — the
    journal is the chronology, its start and its tray changes in journal order.
    """
    from backend.app.models.print_usage_event import EVENT_START, EVENT_TRAY_CHANGE

    if tray_changes is None:
        tray_changes = [
            (e.global_tray_id, e.layer_num)
            for e in sorted(journal_events or [], key=lambda e: e.id)
            if e.event in (EVENT_START, EVENT_TRAY_CHANGE) and e.global_tray_id is not None
        ]
    chronology = [tuple(entry) for entry in (tray_changes or [])]
    memory = set(chronology)  # what the client's memory itself holds, before any reconciling
    events = sorted(
        (e for e in (journal_events or []) if e.event == EVENT_TRAY_CHANGE and e.global_tray_id is not None),
        key=lambda e: e.id,
    )
    for marker in events:
        if marker.global_tray_id != UNKNOWN_FEED:
            continue
        unknown = (UNKNOWN_FEED, marker.layer_num)
        if unknown in memory:
            at = len(chronology) - 1 - chronology[::-1].index(unknown)
            before, remembered = chronology[:at], chronology[at + 1 :]
        else:  # the memory is stale from the marker's layer
            before, remembered = [entry for entry in chronology if entry[1] < marker.layer_num], []
        recorded = [(e.global_tray_id, e.layer_num) for e in events if e.id > marker.id]
        after = list(remembered)
        for entry in recorded:
            if entry not in after:
                after.append(entry)
        after.sort(key=lambda entry: entry[1])  # stable: within a layer, the memory's order first
        chronology = [*before, unknown, *after]
    return chronology


def split_is_measured(
    intervals: list[FeedInterval], slot_id: int, layer_usage, total_layers: int, last_layer_num: int
) -> bool:
    """Can a slot's grams be divided between ``intervals`` from facts (post-rebuild F6)?

    The slot's own G-code progress, or a layer count to take a share of, measures each interval;
    without either, ``tray_split.compute_layer_segment_grams`` falls back to equal shares — a
    guess. A guess is never made for a chronology that states part of the feed unknown: the
    caller reports the slot not recorded instead.
    """
    from backend.app.utils.threemf_tools import slot_progress_fraction

    if not any(iv.tray == UNKNOWN_FEED for iv in intervals) or len(intervals) < 2:
        return True
    if layer_usage and slot_progress_fraction(layer_usage, slot_id - 1, 0) is not None:
        return True
    return int(total_layers or 0) > 0 or int(last_layer_num or 0) > 0


def normalize_tray_changes(tray_changes: list[tuple[int, int]] | None) -> list[tuple[int, int]]:
    """The tray chronology at the resolution the layer number gives.

    An entry followed by another on the SAME layer fed nothing that layer
    granularity can see, and is dropped; neighbouring entries of the same tray
    then merge. This is a projection rule, not proof that nothing was extruded
    — a layer is a coarse unit — and it must run before any fallback weight
    split: the equal-split fallback gives every entry a share, zero-length ones
    included. The open last entry is never zero-length, whatever layer it
    started on. The raw log is not modified.
    """
    entries = list(tray_changes or [])
    kept = [entry for idx, entry in enumerate(entries) if idx + 1 >= len(entries) or entries[idx + 1][1] > entry[1]]
    merged: list[tuple[int, int]] = []
    for tray, layer in kept:
        if merged and merged[-1][0] == tray:
            continue
        merged.append((tray, layer))
    return merged


def sole_feeding_tray(tray_changes: list[tuple[int, int]] | None) -> int | None:
    """The tray a chronology that MOVED proves fed the whole print, or None.

    ``[(A, 0), (B, 0)]`` — the tray left loaded at print start, then the real
    feeder on layer 0 — normalizes to B alone. The raw log was the tray split's
    evidence, and that evidence outranks the dispatched mapping and the start
    tray (#957); losing it to the single-tray ladder charged the whole print to
    a reel that fed nothing. A log of one entry never moved and proves nothing
    new, so it stays with the ladder.
    """
    entries = list(tray_changes or [])
    if len(entries) < 2:
        return None
    normalized = normalize_tray_changes(entries)
    return normalized[0][0] if len(normalized) == 1 and normalized[0][0] != UNKNOWN_FEED else None


def _identity_events(events: list, tray: int) -> list:
    """Events that say which spool sat in ``tray`` from their layer on, in journal order."""
    from backend.app.models.print_usage_event import EVENT_SPOOL_LOADED, EVENT_START, EVENT_TRAY_CHANGE

    return [
        e
        for e in events
        if e.global_tray_id == tray and e.event in (EVENT_START, EVENT_TRAY_CHANGE, EVENT_SPOOL_LOADED)
    ]


def _refill_layers(events: list, tray: int) -> dict[int, int]:
    """The layer each refill of ``tray`` feeds from, by event id.

    The first reel loaded into a tray after it ran out (and before its next
    runout) fed from the RUNOUT's layer: the print stood there until the new
    reel was in, however much later the operator named it. That is the rule
    ``usage_tracker.journal_boundaries_for_tray`` splits a single tray by, so
    the two paths agree on the same refill.
    """
    from backend.app.models.print_usage_event import EVENT_RUNOUT, EVENT_SPOOL_LOADED

    runouts = [e for e in events if e.event == EVENT_RUNOUT and e.global_tray_id == tray]
    loads = [e for e in events if e.event == EVENT_SPOOL_LOADED and e.global_tray_id == tray]
    layers: dict[int, int] = {}
    for idx, runout in enumerate(runouts):
        next_id = runouts[idx + 1].id if idx + 1 < len(runouts) else None
        load = next((e for e in loads if e.id > runout.id and (next_id is None or e.id < next_id)), None)
        if load is not None:
            layers[load.id] = runout.layer_num
    return layers


def tail_adopted_load(episode, events: list):
    """The reel the feed came back with, when BamDude named it only after the return.

    A ``feed_return`` freezes the binding at that moment. When it still names the reel the
    tail started with, nothing in BamDude knew the new reel yet — the operator swapped it at
    the printer and assigned it later. Then the first reel loaded into the origin after the
    return, before the origin's next runout or tail and before the feed moves to another
    tray, is the one that has been feeding since the return (post-rebuild review).
    """
    from backend.app.models.print_usage_event import (
        EVENT_FEED_RETURN,
        EVENT_RUNOUT,
        EVENT_SPOOL_LOADED,
        EVENT_TAIL_START,
        EVENT_TRAY_CHANGE,
    )

    close = episode.close
    if close is None or close.event != EVENT_FEED_RETURN:
        return None
    if (close.spool_id, close.spoolman_spool_id) != (episode.start.spool_id, episode.start.spoolman_spool_id):
        return None
    for e in sorted(events, key=lambda e: e.id):
        if e.id <= close.id:
            continue
        if e.event == EVENT_TRAY_CHANGE:
            return None
        if e.global_tray_id != episode.origin:
            continue
        if e.event in (EVENT_RUNOUT, EVENT_TAIL_START):
            return None
        if e.event == EVENT_SPOOL_LOADED:
            return e
    return None


def tail_owned_ids(events: list, episodes: list) -> set[int]:
    """Origin rows a tail episode owns: assignments during the tail and the tail's own runout.

    An assignment while the tube still feeds the old reel names the reel now in the slot —
    identity, not a feed boundary; a runout inside the episode is the tail running dry, not
    a new reel's. Neither may act as a boundary of its own: the episode supplies the
    boundary from its ``feed_return`` (post-rebuild F-R3/F-R4).
    """
    from backend.app.models.print_usage_event import EVENT_RUNOUT, EVENT_SPOOL_LOADED

    owned = {
        e.id
        for ep in episodes
        for e in events
        if e.global_tray_id == ep.origin and e.event in (EVENT_RUNOUT, EVENT_SPOOL_LOADED) and ep.contains(e)
    }
    # A reel the return fed but BamDude named later is the episode's own identity too.
    owned.update(adopted.id for ep in episodes if (adopted := tail_adopted_load(ep, events)) is not None)
    return owned


def tail_identity_changes(episode, events: list) -> list[tuple[int, int | None, int | None, tuple[int, int]]]:
    """Who fed a tail episode's origin from where: ``(layer, spool_id, spoolman_id, order)``.

    * closed by a ``feed_return`` observed live: the reel bound then, from its layer — or,
      when the return still named the outgoing reel, the reel assigned after it
      (``tail_adopted_load``);
    * a ``feed_return`` first seen after an observation gap: from the tail's last proven
      layer (its start, or its own runout) to the return nobody is named — the return's
      layer is the observed one, not the historical one;
    * still open after the tail ran dry (its runout): nobody from that runout — no boundary
      is invented and the old reel is not handed the rest;
    * still open, or closed by another AMS tray: nothing — the old reel kept feeding, and a
      backup is the chronology's to say.

    ``order`` sorts the changes into journal order.
    """
    from backend.app.models.print_usage_event import EVENT_FEED_RETURN, EVENT_RUNOUT, KIND_GAP

    runouts = [
        e for e in events if e.event == EVENT_RUNOUT and e.global_tray_id == episode.origin and episode.contains(e)
    ]
    close = episode.close
    if close is not None and close.event == EVENT_FEED_RETURN:
        changes = []
        if close.kind == KIND_GAP:
            last_tail = max([episode.start.layer_num] + [r.layer_num for r in runouts])
            if last_tail < close.layer_num:
                changes.append((last_tail, None, None, (close.id, 0)))
        named = tail_adopted_load(episode, events) or close
        changes.append((close.layer_num, named.spool_id, named.spoolman_spool_id, (close.id, 1)))
        return changes
    if close is None and runouts:
        return [(runouts[-1].layer_num, None, None, (runouts[-1].id, 0))]
    return []


def _has_spool_boundary(events: list, tray: int) -> bool:
    from backend.app.models.print_usage_event import EVENT_RUNOUT, EVENT_SPOOL_LOADED

    return any(e.global_tray_id == tray and e.event in (EVENT_RUNOUT, EVENT_SPOOL_LOADED) for e in events)


def feed_intervals(tray_changes: list[tuple[int, int]] | None, journal_events: list | None) -> list[FeedInterval]:
    """Feed intervals of a one-slot print that moved between trays.

    ``tray_changes`` is the raw chronology; it is normalized here. Returns
    ``[]`` when, normalized, it names at most one tray — the journal's per-tray
    boundaries answer that case. Otherwise one interval per normalized entry,
    each split further where the journal shows another reel loaded into that
    very tray while it was feeding (a refill at a runout pause). Neighbours with
    the same tray and the same attribution merge.

    The spool in a tray at a layer is the last identity event on that tray at
    or before the layer: the start, a tray change to it, or a reel loaded into
    it — in journal order, so a later event on the same layer wins; a refill
    counts from its runout's layer (``_refill_layers``). A tray the
    journal holds no spool boundary for (no runout, no reel loaded) is left for
    the writer to resolve (``frozen=False``) — unless part of the print's feed is
    stated unknown: the binding now may then hold a change nobody recorded, so a
    known stretch takes its reel from the journal's identity events, and nothing
    when there are none (post-rebuild F4).

    A runout tail of a tray (post-rebuild F-R4) is read as ``journal_boundaries_for_tray``
    reads it: its assignments and its own runout are not boundaries, and the identity
    changes at the episode's ``feed_return`` (``tail_identity_changes``).
    """
    from backend.app.services.print_usage_journal import tail_episodes, without_stale_refill_runouts

    chronology = normalize_tray_changes(tray_changes)
    if not chronology_splits(chronology):
        return []
    all_events = sorted(without_stale_refill_runouts(list(journal_events or [])), key=lambda e: e.id)
    episodes = tail_episodes(all_events)
    owned = tail_owned_ids(all_events, episodes)
    events = [e for e in all_events if e.id not in owned]
    history_lost = any(tray == UNKNOWN_FEED for tray, _layer in chronology)

    intervals: list[FeedInterval] = []
    for idx, (tray, start) in enumerate(chronology):
        end = chronology[idx + 1][1] if idx + 1 < len(chronology) else None
        if tray == UNKNOWN_FEED:
            # Nobody observed this stretch: frozen as nobody's, never filled from a live slot.
            intervals.append(FeedInterval(start, tray, None, None, True))
            continue
        tray_episodes = [ep for ep in episodes if ep.origin == tray]
        if not _has_spool_boundary(events, tray) and not tray_episodes and not history_lost:
            intervals.append(FeedInterval(start, tray, None, None, False))
            continue
        refills = _refill_layers(events, tray)
        marks = [
            ((e.id, 0), refills.get(e.id, e.layer_num), e.spool_id, e.spoolman_spool_id)
            for e in _identity_events(events, tray)
        ]
        for ep in tray_episodes:
            marks.extend(
                (order, layer, spool, spoolman)
                for layer, spool, spoolman, order in tail_identity_changes(ep, all_events)
            )
        marks.sort(key=lambda mark: mark[0])  # journal order
        current: tuple[int | None, int | None] | None = None
        changes: list[tuple[int, int | None, int | None]] = []
        for _order, layer, spool, spoolman in marks:
            if layer <= start:
                current = (spool, spoolman)
            elif end is None or layer < end:
                changes.append((layer, spool, spoolman))
        changes.sort(key=lambda change: change[0])  # stable: journal order within a layer
        first = (start, *current) if current is not None else (start, None, None)
        stretch = [first]
        for change in changes:
            if stretch[-1][0] == change[0]:
                stretch[-1] = change  # a later identity on the same layer wins
            else:
                stretch.append(change)
        intervals.extend(FeedInterval(layer, tray, spool, spoolman, True) for layer, spool, spoolman in stretch)

    merged: list[FeedInterval] = []
    for iv in intervals:
        prev = merged[-1] if merged else None
        if (
            prev is not None
            and prev.tray == iv.tray
            and prev.frozen == iv.frozen
            and (prev.spool_id, prev.spoolman_spool_id) == (iv.spool_id, iv.spoolman_spool_id)
        ):
            continue
        merged.append(iv)
    return merged


def add_autoswitch_purge(
    intervals: list[FeedInterval], grams: list[float], journal_events: list | None, purge_grams: float
) -> tuple[list[FeedInterval], list[float]]:
    """The emergency-swap purge of each autoswitch, charged to the backup that took over.

    The slicer's estimate holds the planned colour-change flushes but not the
    purge of an AMS backup switch — the backup reel feeds it, so it lands on
    the backup's interval: the first interval of ANOTHER tray starting within
    one layer of the runout. Added once per runout.

    ⚠️ It does not vanish with a zero-length interval (spec): a backup that fed
    the purge and nothing a layer number sees normalizes away, so the purge
    becomes an interval of its own — the backup the journal names for the
    runout (the first tray change to another tray by the next layer, as
    ``usage_tracker.journal_boundaries_for_tray`` names it), at the runout
    layer, appended after the print's intervals; ``None`` spool when the
    journal names none, which the writers report as not recorded. Returns the
    intervals to charge and their grams. ``runout_purge_grams`` defaults to 0.
    """
    from backend.app.models.print_usage_event import EVENT_RUNOUT, EVENT_TRAY_CHANGE, KIND_AUTOSWITCH
    from backend.app.services.print_usage_journal import without_stale_refill_runouts

    charged = list(intervals)
    out = list(grams)
    if purge_grams <= 0 or not journal_events:
        return charged, out
    events = sorted(without_stale_refill_runouts(list(journal_events)), key=lambda e: e.id)
    for runout in events:
        if runout.event != EVENT_RUNOUT or runout.kind != KIND_AUTOSWITCH or runout.global_tray_id is None:
            continue
        idx = next(
            (
                i
                for i, iv in enumerate(intervals)
                if iv.tray != runout.global_tray_id and abs(iv.start_layer - runout.layer_num) <= 1
            ),
            None,
        )
        if idx is not None:
            out[idx] += purge_grams
            continue
        backup = next(
            (
                e
                for e in events
                if e.id > runout.id
                and e.event == EVENT_TRAY_CHANGE
                and e.global_tray_id is not None
                and e.global_tray_id != runout.global_tray_id
                and e.layer_num <= runout.layer_num + 1
            ),
            None,
        )
        if backup is not None:
            charged.append(
                FeedInterval(runout.layer_num, backup.global_tray_id, backup.spool_id, backup.spoolman_spool_id, True)
            )
        else:
            charged.append(FeedInterval(runout.layer_num, runout.global_tray_id, None, None, True))
        out.append(purge_grams)
    return charged, out
