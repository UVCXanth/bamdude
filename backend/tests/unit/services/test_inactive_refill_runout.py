"""One narrow physical proof; absence of data never invents an empty reel."""

from types import SimpleNamespace

import pytest

from backend.app.services.print_usage_journal import without_stale_refill_runouts
from backend.app.services.usage_tracker import journal_boundaries_for_tray


def _event(eid, event, tray, spool, layer, *, kind=None, occupied=None, spoolman=False):
    return SimpleNamespace(
        id=eid,
        event=event,
        kind=kind,
        global_tray_id=tray,
        spool_id=None if spoolman else spool,
        spoolman_spool_id=spool if spoolman else None,
        layer_num=layer,
        slot_occupied=occupied,
        archive_id=927,
        printer_id=1,
    )


def _refill(*, spoolman=False, new_layer=18):
    return [
        _event(10, "tray_change", 0, 301, 0, spoolman=spoolman),
        _event(20, "runout", 0, 301, 6, kind="autoswitch", occupied=False, spoolman=spoolman),
        _event(30, "tray_change", 1, 305, 6, spoolman=spoolman),
        _event(40, "spool_loaded", 0, 308, 18, occupied=True, spoolman=spoolman),
        _event(50, "runout", 0, 308, new_layer, kind="autoswitch", occupied=True, spoolman=spoolman),
    ]


@pytest.mark.parametrize("spoolman", [False, True])
@pytest.mark.parametrize("new_layer", [18, 19, 100])
def test_delayed_status_over_a_refilled_inactive_slot_has_no_accounting_authority(spoolman, new_layer):
    events = _refill(spoolman=spoolman, new_layer=new_layer)
    assert [e.id for e in without_stale_refill_runouts(events)] == [10, 20, 30, 40]
    assert len(events) == 5  # The original forensic record stays intact.
    expected = [(0, None, 301), (6, None, 305)] if spoolman else [(0, 301, None), (6, 305, None)]
    assert journal_boundaries_for_tray(events, 0) == expected


@pytest.mark.parametrize("return_id", [35, 45])
def test_an_observed_return_to_the_source_keeps_the_next_real_runout(return_id):
    events = _refill()
    events.insert(-1, _event(return_id, "tray_change", 0, 308, 18))
    assert len(without_stale_refill_runouts(events)) == len(events)


@pytest.mark.parametrize(
    "field,value",
    [
        ("slot_occupied", None),
        ("slot_occupied", False),
        ("kind", "pause"),
        ("kind", "manual"),
        ("kind", "ambiguous"),
        ("archive_id", 928),
        ("printer_id", 10),
    ],
)
def test_incomplete_or_different_runout_evidence_keeps_existing_semantics(field, value):
    events = _refill()
    setattr(events[-1], field, value)
    assert len(without_stale_refill_runouts(events)) == len(events)


@pytest.mark.parametrize("occupied", [None, False])
def test_a_books_only_or_unknown_refill_is_not_the_physical_refill_proof(occupied):
    events = _refill()
    events[-2].slot_occupied = occupied
    assert len(without_stale_refill_runouts(events)) == len(events)


@pytest.mark.parametrize("tray,backup", [(0, 4), (128, 129), (254, 255)])
def test_another_ams_unit_or_external_holder_cannot_prove_the_source_inactive(tray, backup):
    events = _refill()
    for event in events:
        event.global_tray_id = backup if event.event == "tray_change" and event.id == 30 else tray
    assert len(without_stale_refill_runouts(events)) == len(events)


def test_missing_or_late_backup_evidence_does_not_suppress_a_runout():
    events = _refill()
    assert len(without_stale_refill_runouts([e for e in events if e.id != 30])) == 4
    events[2].layer_num = 10
    assert len(without_stale_refill_runouts(events)) == 5


def test_same_reel_refed_or_no_old_identity_does_not_match_the_replacement_proof():
    events = _refill()
    events[1].spool_id = 308
    assert len(without_stale_refill_runouts(events)) == 5
    events[1].spool_id = None
    assert len(without_stale_refill_runouts(events)) == 5


def test_rejected_status_does_not_become_ancestry_for_another_inactive_refill():
    events = _refill()
    events.extend(
        [
            _event(60, "spool_loaded", 0, 309, 20, occupied=True),
            _event(70, "runout", 0, 309, 21, kind="autoswitch", occupied=True),
        ]
    )
    accepted = without_stale_refill_runouts(events)
    assert [e.id for e in accepted] == [10, 20, 30, 40, 60]
    assert without_stale_refill_runouts(accepted) == accepted


def test_the_first_early_runout_still_closes_the_real_reel():
    event = _event(1, "runout", 0, 301, 0, kind="autoswitch", occupied=True)
    assert without_stale_refill_runouts([event]) == [event]
