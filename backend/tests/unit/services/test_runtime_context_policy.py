"""A finished run held in memory: shown always, released only on positive proof (spec r3 R3, R7, R7a, R7b)."""

from copy import deepcopy
from datetime import datetime, timedelta, timezone

import pytest

from backend.app.services.print_state_recovery import RUNTIME_ACTION, RecoveryFacts, classify, runtime_effect_debt

NOW = datetime(2026, 10, 25, 12, 0, tzinfo=timezone.utc)
OWNERS = (
    "dispatch_in_flight",
    "dispatch_work",
    "completion_scope",
    "live_completion",
    "swap_sending",
    "macro_tasks",
    "plug_off",
    "bed_cooldown",
    "archive_download",
)


def runtime(**over):
    data = {
        "telemetry": {"fresh": True, "state": "FINISH"},
        "current": {
            "ref": 1001,
            "archive_id": 19,
            "sequence": 3,
            "origin": "dispatch",
            "queue_item_id": 11,
            "expected_submission_id": "111",
            "observed_subtask_id": None,
            "effect_generation": 5,
            "client_generation": 1,
        },
        "admission": None,
        "resolution": False,
        "pending_terminal": False,
        "finishing": 0,
        "effect_generation": 5,
        "terminal_accepted": False,
        "owners": dict.fromkeys(OWNERS, False),
        "layer_timelapse": False,
        "macro_selection": {"present": True, "ref": 2002, "value": [], "valid": True},
        "swap_config": {"present": False, "ref": None, "value": None, "valid": True},
        "preheat_pinned": None,
        "plate_gate": False,
    }
    data.update(over)
    return data


def facts(*, queue=..., archive=..., live_runtime=None, printing_archives=0, active_items=()):
    q = {
        "id": 4,
        "printer_id": 7,
        "recovery_identity": "q",
        "status": "idle",
        "current_item_id": None,
        "is_paused": False,
    }
    a = {
        "id": 19,
        "printer_id": 7,
        "queue_id": 4,
        "recovery_identity": "a",
        "status": "completed",
        "started_at": NOW - timedelta(hours=2),
        "completed_at": NOW - timedelta(hours=1),
        "deleted_at": None,
        "print_time_seconds": 3600,
        "extra_data": {"recovered_by_startup_sweep": True},
    }
    return RecoveryFacts(
        printer_id=7,
        queue=q if queue is ... else queue,
        item=None,
        archive=a if archive is ... else archive,
        live={"mode": "unknown", "identity": (), "observed_at": 10.0},
        active_item_ids=active_items,
        printing_archive_ids=tuple(range(printing_archives)),
        now=NOW,
        runtime=live_runtime if live_runtime is not None else runtime(),
    )


def changed(base: RecoveryFacts, **runtime_over) -> RecoveryFacts:
    return RecoveryFacts(**{**base.__dict__, "runtime": {**deepcopy(base.runtime), **runtime_over}})


def test_a_finished_run_held_in_memory_is_released_on_proof():
    issue = classify(facts())
    assert issue == {"code": "terminal_runtime_context", "actions": [RUNTIME_ACTION], "blocked_reasons": []}


@pytest.mark.parametrize("status", ["completed", "failed", "cancelled"])
def test_every_terminal_outcome_qualifies(status):
    f = facts()
    assert classify(RecoveryFacts(**{**f.__dict__, "archive": {**f.archive, "status": status}}))["actions"] == [
        RUNTIME_ACTION
    ]


def test_a_printing_print_is_not_a_problem():
    f = facts(live_runtime=runtime(telemetry={"fresh": True, "state": "RUNNING"}))
    printing = RecoveryFacts(**{**f.__dict__, "archive": {**f.archive, "status": "printing", "completed_at": None}})
    assert classify(printing) is None


def test_a_printing_archive_on_an_idle_printer_is_shown_without_repair():
    f = facts()
    printing = RecoveryFacts(**{**f.__dict__, "archive": {**f.archive, "status": "printing", "completed_at": None}})
    issue = classify(printing)
    assert issue["code"] == "runtime_context_unresolved"
    assert issue["actions"] == [] and "archive_not_terminal" in issue["blocked_reasons"]


@pytest.mark.parametrize("owner", ["dispatch_in_flight", "dispatch_work", "completion_scope"])
def test_a_printing_archive_its_own_dispatch_still_explains_is_no_problem(owner):
    """A start just sent, the printer not yet out of FINISH: the dispatch that owns it explains the gap."""
    f = facts()
    printing = RecoveryFacts(**{**f.__dict__, "archive": {**f.archive, "status": "printing", "completed_at": None}})
    owners = {**printing.runtime["owners"], owner: True}
    assert classify(changed(printing, owners=owners)) is None


@pytest.mark.parametrize(
    ("archive_change", "reason"),
    [
        (None, "archive_missing"),
        ({"deleted_at": NOW}, "archive_missing"),
        ({"printer_id": 8}, "archive_foreign"),
        ({"queue_id": 99}, "archive_foreign"),
        ({"recovery_identity": None}, "identity_missing"),
        ({"extra_data": {"recovered_outcome_uncertain": True}}, "outcome_unknown"),
        ({"extra_data": "garbage"}, "effects_unreadable"),
    ],
)
def test_an_unproven_execution_is_explained_not_released(archive_change, reason):
    f = facts()
    archive = None if archive_change is None else {**f.archive, **archive_change}
    issue = classify(RecoveryFacts(**{**f.__dict__, "archive": archive}))
    assert issue["actions"] == []
    assert reason in issue["blocked_reasons"]


@pytest.mark.parametrize(
    ("telemetry", "reason"),
    [
        ({"fresh": True, "state": "RUNNING"}, "printer_printing"),
        ({"fresh": True, "state": "PAUSE"}, "printer_printing"),
        ({"fresh": False, "state": "FINISH"}, "live_unknown"),
        ({"fresh": True, "state": None}, "live_unknown"),
        ({"fresh": True, "state": "PREPARE"}, "live_unknown"),
    ],
)
def test_only_a_fresh_idle_printer_may_be_released(telemetry, reason):
    issue = classify(changed(facts(), telemetry=telemetry))
    assert issue["code"] == "terminal_runtime_context"
    assert issue["actions"] == [] and reason in issue["blocked_reasons"]


@pytest.mark.parametrize("owner", OWNERS)
@pytest.mark.parametrize(("value", "reason"), [(True, "context_owner_active"), (None, "context_owner_unknown")])
def test_any_live_owner_or_an_unknown_one_keeps_the_context(owner, value, reason):
    base = facts()
    issue = classify(changed(base, owners={**base.runtime["owners"], owner: value}))
    assert issue["actions"] == [] and reason in issue["blocked_reasons"]


def test_a_missing_owner_answer_is_unknown_not_false():
    base = facts()
    owners = dict(base.runtime["owners"])
    owners.pop("macro_tasks")
    issue = classify(changed(base, owners=owners))
    assert issue["actions"] == [] and "context_owner_unknown" in issue["blocked_reasons"]


@pytest.mark.parametrize(
    ("field", "value", "reason"),
    [
        ("resolution", True, "start_in_progress"),
        ("resolution", None, "context_owner_unknown"),
        ("pending_terminal", True, "terminal_buffered"),
        ("finishing", 1, "finishing_in_progress"),
        ("finishing", None, "context_owner_unknown"),
        ("terminal_accepted", None, "context_owner_unknown"),
    ],
)
def test_runtime_work_around_the_run_keeps_it(field, value, reason):
    issue = classify(changed(facts(), **{field: value}))
    assert issue["actions"] == [] and reason in issue["blocked_reasons"]


def test_a_newer_activity_than_the_run_keeps_it():
    issue = classify(changed(facts(), effect_generation=6))
    assert issue["actions"] == [] and "activity_changed" in issue["blocked_reasons"]


@pytest.mark.parametrize(
    "admission",
    [
        {"ref": 3003, "phase": "processing", "subtask_id": "111", "archive_id": 19, "generation": 5},
    ],
)
def test_a_start_still_processing_keeps_the_run(admission):
    issue = classify(changed(facts(), admission=admission))
    assert issue["actions"] == [] and "start_in_progress" in issue["blocked_reasons"]


def test_a_processed_start_of_this_very_run_is_released_with_it():
    admission = {"ref": 3003, "phase": "processed", "subtask_id": "111", "archive_id": 19, "generation": 5}
    assert classify(changed(facts(), admission=admission))["actions"] == [RUNTIME_ACTION]


@pytest.mark.parametrize(
    "admission",
    [
        # the wildcard copy: archive and generation say A, the device id says nothing
        {"ref": 3003, "phase": "processed", "subtask_id": None, "archive_id": 19, "generation": 5},
        # another start's id
        {"ref": 3003, "phase": "processed", "subtask_id": "222", "archive_id": 19, "generation": 5},
        {"ref": 3003, "phase": "processed", "subtask_id": "111", "archive_id": 20, "generation": 5},
        {"ref": 3003, "phase": "processed", "subtask_id": "111", "archive_id": 19, "generation": 4},
        {"ref": 3003, "phase": "strange", "subtask_id": "111", "archive_id": 19, "generation": 5},
        "unknown",
    ],
)
def test_a_start_not_proven_to_be_this_run_keeps_it(admission):
    issue = classify(changed(facts(), admission=admission))
    assert issue["actions"] == [] and "admission_unproven" in issue["blocked_reasons"]


def test_a_processed_start_needs_a_run_that_has_a_device_id():
    base = facts()
    current = {**base.runtime["current"], "expected_submission_id": None, "observed_subtask_id": None}
    admission = {"ref": 3003, "phase": "processed", "subtask_id": "111", "archive_id": 19, "generation": 5}
    issue = classify(changed(base, current=current, admission=admission))
    assert issue["actions"] == [] and "admission_unproven" in issue["blocked_reasons"]


def test_without_an_admission_a_run_without_device_id_is_still_released():
    base = facts()
    current = {**base.runtime["current"], "expected_submission_id": None, "observed_subtask_id": None}
    assert classify(changed(base, current=current))["actions"] == [RUNTIME_ACTION]


@pytest.mark.parametrize(
    "selection",
    [
        {"present": True, "ref": 2002, "value": [], "valid": True},
        {"present": True, "ref": 2002, "value": [4, 9], "valid": True},
        {"present": False, "ref": None, "value": None, "valid": True},
    ],
)
def test_a_readable_macro_selection_never_blocks(selection):
    assert classify(changed(facts(), macro_selection=selection))["actions"] == [RUNTIME_ACTION]


def test_an_unreadable_macro_selection_blocks():
    selection = {"present": True, "ref": 2002, "value": None, "valid": False}
    issue = classify(changed(facts(), macro_selection=selection))
    assert issue["actions"] == [] and "registration_unreadable" in issue["blocked_reasons"]


def test_a_settled_swap_config_is_released():
    base = facts()
    archive = {
        **base.archive,
        "extra_data": {
            "swap_macro_events_pending": [],
            "bamdude_terminal_effects": {"swap_change_table": {"stage": "finished", "owner": "sweep", "at": "x"}},
        },
    }
    swap = {"present": True, "ref": 4004, "value": {"swap_macro_events": ["swap_mode_change_table"]}, "valid": True}
    f = RecoveryFacts(**{**base.__dict__, "archive": archive, "runtime": {**base.runtime, "swap_config": swap}})
    assert classify(f)["actions"] == [RUNTIME_ACTION]


@pytest.mark.parametrize(
    "extra",
    [
        {"swap_macro_events_pending": ["swap_mode_change_table"]},
        {"bamdude_terminal_effects": {"swap_change_table": {"stage": "owed"}}},
        {"bamdude_terminal_effects": {"swap_change_table": {"stage": "attempted"}}},
        {"bamdude_terminal_effects": {"swap_change_table": {"stage": "failed"}}},
    ],
)
def test_a_swap_still_owed_keeps_the_context_and_its_config(extra):
    base = facts()
    swap = {"present": True, "ref": 4004, "value": {"swap_macro_events": ["swap_mode_change_table"]}, "valid": True}
    f = RecoveryFacts(
        **{
            **base.__dict__,
            "archive": {**base.archive, "extra_data": extra},
            "runtime": {**base.runtime, "swap_config": swap},
        }
    )
    issue = classify(f)
    assert issue["actions"] == [] and "swap_debt" in issue["blocked_reasons"]


def test_an_unreadable_swap_config_blocks():
    swap = {"present": True, "ref": 4004, "value": None, "valid": False}
    issue = classify(changed(facts(), swap_config=swap))
    assert issue["actions"] == [] and "registration_unreadable" in issue["blocked_reasons"]


@pytest.mark.parametrize(
    ("extra", "debt"),
    [
        (None, []),
        ({}, []),
        ({"swap_macro_events_pending": []}, []),
        ({"bamdude_terminal_effects": {"swap_change_table": {"stage": "finished"}}}, []),
        ({"swap_macro_events_pending": ["swap_mode_change_table"]}, ["swap_debt"]),
        ({"swap_macro_events_pending": "x"}, ["effects_unreadable"]),
        ({"bamdude_terminal_effects": {"swap_change_table": {"stage": "owed"}}}, ["swap_debt"]),
        ({"bamdude_terminal_effects": {"swap_change_table": {"stage": "later"}}}, ["effects_unreadable"]),
        ({"bamdude_terminal_effects": {"swap_change_table": "finished"}}, ["effects_unreadable"]),
        ({"bamdude_terminal_effects": "x"}, ["effects_unreadable"]),
        ({"bamdude_terminal_effects": {"printer_cleanup": {"stage": "attempted"}}}, ["effects_pending"]),
        ({"bamdude_terminal_effects": {"printer_cleanup": {"stage": "uncertain"}}}, ["effects_pending"]),
        ({"bamdude_terminal_effects": {"finish_photo": {"stage": "later"}}}, ["effects_pending"]),
        ({"bamdude_terminal_effects": {"finish_photo": "finished"}}, ["effects_unreadable"]),
        # An effect that ended -- done, skipped, failed (completion never replays printer I/O), or finish
        # macros handed to their tasks (live ones are an owner of their own) -- owes nothing.
        ({"bamdude_terminal_effects": {"finish_photo": {"stage": "finished"}}}, []),
        ({"bamdude_terminal_effects": {"printer_cleanup": {"stage": "skipped"}}}, []),
        ({"bamdude_terminal_effects": {"smart_plug": {"stage": "failed"}}}, []),
        ({"bamdude_terminal_effects": {"finish_macros": {"stage": "scheduled"}}}, []),
        # RS-R1: a present but unreadable carrier proves nothing -- unreadable, never "absent" and never a crash.
        ({"swap_macro_events_pending": None}, ["effects_unreadable"]),
        ({"bamdude_terminal_effects": {"finish_photo": {"stage": []}}}, ["effects_unreadable"]),
        ({"bamdude_terminal_effects": {"finish_photo": {"stage": {}}}}, ["effects_unreadable"]),
        ({"bamdude_terminal_effects": {"finish_photo": {}}}, ["effects_unreadable"]),
        ({"bamdude_terminal_effects": {"swap_change_table": {"stage": []}}}, ["effects_unreadable"]),
        ({"swap_hold": {"reason": "r"}}, ["effects_pending"]),
        ({"auto_eject_pending": True}, ["effects_pending"]),
        ({"cleanup_pending": True}, ["effects_pending"]),
        ({"completion_effects": {}}, ["effects_pending"]),
        ("garbage", ["effects_unreadable"]),
    ],
)
def test_the_effect_reader_is_strict(extra, debt):
    assert runtime_effect_debt(extra) == debt


@pytest.mark.parametrize(
    "extra",
    [
        {"swap_macro_events_pending": None},
        {"bamdude_terminal_effects": {"finish_photo": {"stage": []}}},
        {"bamdude_terminal_effects": {"finish_photo": {"stage": {}}}},
    ],
)
def test_an_unreadable_effect_record_is_a_visible_row_without_repair(extra):
    """RS-R1: shown with its reason and no action -- never released, never a crash of the reader."""
    f = facts()
    issue = classify(RecoveryFacts(**{**f.__dict__, "archive": {**f.archive, "extra_data": extra}}))
    assert issue is not None and issue["actions"] == []
    assert "effects_unreadable" in issue["blocked_reasons"]


def test_a_printer_without_a_queue_is_shown_without_repair():
    issue = classify(facts(queue=None))
    assert issue["code"] == "terminal_runtime_context"
    assert issue["actions"] == [] and "queue_missing" in issue["blocked_reasons"]


@pytest.mark.parametrize(
    ("queue_change", "printing_archives", "active_items"),
    [
        ({"status": "printing"}, 0, ()),
        ({"current_item_id": 11}, 0, ()),
        ({}, 1, ()),
        ({}, 0, (11,)),
        ({"recovery_identity": None}, 0, ()),
    ],
)
def test_any_database_owner_keeps_the_context(queue_change, printing_archives, active_items):
    base = facts(printing_archives=printing_archives, active_items=active_items)
    f = RecoveryFacts(**{**base.__dict__, "queue": {**base.queue, **queue_change}})
    issue = classify(f)
    assert issue["actions"] == []
    assert {"queue_busy", "identity_missing"} & set(issue["blocked_reasons"])


def test_an_open_layer_timelapse_keeps_the_run():
    """RS-R2: a timelapse session takes the next print's layers by printer -- left, it would film B into A."""
    issue = classify(changed(facts(), layer_timelapse=True))
    assert issue["actions"] == [] and "timelapse_open" in issue["blocked_reasons"]


def test_an_unknown_timelapse_answer_keeps_the_run():
    issue = classify(changed(facts(), layer_timelapse=None))
    assert issue["actions"] == [] and "context_owner_unknown" in issue["blocked_reasons"]


def test_the_plate_gate_and_a_residual_preheat_never_block():
    """R7b and A21: shown, not a veto, and not something this repair changes."""
    issue = classify(changed(facts(), plate_gate=True, preheat_pinned=["bed", "chamber"]))
    assert issue["actions"] == [RUNTIME_ACTION]


def test_a_paused_queue_does_not_block():
    base = facts()
    assert classify(RecoveryFacts(**{**base.__dict__, "queue": {**base.queue, "is_paused": True}}))["actions"] == [
        RUNTIME_ACTION
    ]


@pytest.mark.parametrize("field", ["resolution", "finishing"])
def test_lingering_start_or_finish_without_a_run_is_an_observation(field):
    base = facts()
    value = True if field == "resolution" else 1
    issue = classify(changed(base, current=None, **{field: value}))
    # A start or completion still under way is a phase, not a contradiction (R3): observed, never repaired.
    assert issue["code"] == "runtime_phase_lingering"
    assert issue["actions"] == [] and issue["observation"] is True


def test_no_runtime_context_is_no_problem():
    assert classify(changed(facts(), current=None)) is None
