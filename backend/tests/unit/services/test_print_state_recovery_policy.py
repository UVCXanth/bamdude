"""Operator repairs require positive run evidence, including for deletion."""

from copy import deepcopy
from datetime import datetime, timedelta, timezone

import pytest

from backend.app.services.print_state_recovery import RecoveryFacts, classify, plan_action


def facts():
    now = datetime.now(timezone.utc)
    return RecoveryFacts(
        printer_id=7,
        queue={
            "id": 4,
            "printer_id": 7,
            "recovery_identity": "q",
            "status": "printing",
            "current_item_id": 11,
            "is_paused": False,
        },
        item={
            "id": 11,
            "queue_id": 4,
            "recovery_identity": "i",
            "status": "printing",
            "archive_id": 19,
            "started_at": now - timedelta(hours=2),
            "source_snapshot": None,
        },
        archive={
            "id": 19,
            "printer_id": 7,
            "queue_id": 4,
            "recovery_identity": "a",
            "status": "completed",
            "started_at": now - timedelta(hours=2) + timedelta(seconds=5),
            "completed_at": now - timedelta(hours=1),
            "print_time_seconds": 3600,
            "extra_data": None,
        },
        live={"mode": "inactive", "identity": (1, "IDLE"), "observed_at": 10.0},
        active_item_ids=(11,),
        printing_archive_ids=(),
        archive_users=1,
        references=(),
        now=now,
    )


def test_completed_pair_offers_addressed_align_and_delete():
    f = facts()
    assert classify(f)["code"] == "terminal_archive_active_item"
    assert set(classify(f)["actions"]) == {"align_terminal_item", "delete_stale_item"}
    plan = plan_action(f, "align_terminal_item")
    assert plan["item"] == {"status": "completed", "completed_at": f.archive["completed_at"], "waiting_reason": None}
    assert plan["queue"] == {"current_item_id": None, "status": "paused", "is_paused": True}
    assert not plan["archive"]


@pytest.mark.parametrize("status", ["failed", "cancelled", "aborted", "stopped"])
def test_failure_history_can_be_aligned_but_never_deleted(status):
    f = facts()
    f.archive["status"] = status
    assert classify(f)["actions"] == ["align_terminal_item"]


@pytest.mark.parametrize("ref", ["auto_parent", "auto_child", "calibration", "receipt", "project", "unknown_fk"])
def test_any_dependent_reference_removes_delete(ref):
    f = facts()
    f = RecoveryFacts(**{**f.__dict__, "references": (ref,)})
    assert "delete_stale_item" not in classify(f)["actions"]


@pytest.mark.parametrize(
    "defect",
    [
        "source",
        "wrong_queue",
        "shared",
        "clock",
        "trash",
        "uncertain",
        "effect",
        "malformed",
        "offline",
        "missing_start",
    ],
)
def test_ambiguous_pair_never_offers_a_write(defect):
    f = facts()
    if defect == "source":
        f.item["source_snapshot"] = {"provenance": {"kind": "archive", "id": 19}}
    elif defect == "wrong_queue":
        f.archive["queue_id"] = 9
    elif defect == "shared":
        f = RecoveryFacts(**{**f.__dict__, "archive_users": 2})
    elif defect == "clock":
        f.archive["started_at"] = f.item["started_at"] - timedelta(seconds=1)
    elif defect == "trash":
        f.archive["deleted_at"] = f.now
    elif defect == "uncertain":
        f.archive["extra_data"] = {"recovered_outcome_uncertain": True}
    elif defect == "effect":
        f.archive["extra_data"] = {"swap_macro_events_pending": ["swap_mode_change_table"]}
    elif defect == "malformed":
        f.item["source_snapshot"] = ["broken"]
    elif defect == "offline":
        f.live["mode"] = "unknown"
    else:
        f.archive["started_at"] = None
    assert not classify(f)["actions"]


def test_estimate_is_visible_and_never_unlocks_delete():
    f = facts()
    f.archive["completed_at"] = None
    assert classify(f)["actions"] == ["fill_estimated_end_and_align"]
    with pytest.raises(ValueError):
        plan_action(f, "fill_estimated_end_and_align")
    p = plan_action(f, "fill_estimated_end_and_align", confirmed_completed=True)
    assert p["archive"]["completed_at"] == f.archive["started_at"] + timedelta(seconds=3600)
    f.archive.update(p["archive"])
    assert "delete_stale_item" not in classify(f)["actions"]


@pytest.mark.parametrize("duration", [0, -1, float("inf"), float("nan"), None, 10**12])
def test_invalid_or_future_estimate_has_no_action(duration):
    f = facts()
    f.archive.update(completed_at=None, print_time_seconds=duration)
    assert not classify(f)["actions"]


def test_successor_repair_keeps_entire_header_unchanged():
    f = facts()
    f.queue.update(current_item_id=22, is_paused=True)
    f.live.update(mode="successor", item_id=22, started_at=f.now - timedelta(minutes=10))
    before = deepcopy(f.queue)
    assert plan_action(f, "align_terminal_item")["queue"] == {}
    assert plan_action(f, "delete_stale_item")["queue"] == {}
    assert f.queue == before
    f.archive["completed_at"] = None
    assert not classify(f)["actions"]


def test_orphan_header_is_paused_without_clearing_a_gate():
    f = facts()
    f = RecoveryFacts(**{**f.__dict__, "item": None, "archive": None, "active_item_ids": ()})
    f.queue["current_item_id"] = None
    assert classify(f)["actions"] == ["release_orphan_header"]
    assert plan_action(f, "release_orphan_header")["queue"]["is_paused"]
