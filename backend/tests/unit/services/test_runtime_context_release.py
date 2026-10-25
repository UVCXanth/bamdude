"""The one synchronous compare-and-clear of a finished run's context (spec printer-runtime-stall r3 R7, R7a)."""

from dataclasses import replace

import pytest

from backend.app import main
from backend.app.services import runtime_context_release as release
from backend.app.services.print_run_binding import (
    accept_unbound_completion,
    begin_print_run_finishing,
    begin_print_start_resolution,
    bind_print_run,
    claim_print_start,
    current_print_run,
    finish_print_start,
    snapshot_completion_token,
    start_admission,
)
from backend.app.services.printer_manager import PrinterManager

PID = 7


@pytest.fixture
def manager(monkeypatch):
    monkeypatch.setattr(main, "_active_macro_selection", {})
    monkeypatch.setattr(main, "_active_swap_config", {})
    return PrinterManager()


def a_finished_run_held(manager, *, with_admission=False):
    """A dispatched A, its start observed and processed, its completion never accepted."""
    run = bind_print_run(manager, printer_id=PID, archive_id=19, expected_submission_id="111", origin="dispatch")
    if with_admission:
        admission = claim_print_start(manager, PID, {"subtask_id": "111"})
        finish_print_start(manager, PID, admission)
    return run


def expectation(manager):
    return release.capture(manager, PID)


def test_it_releases_exactly_the_run_and_its_processed_start(manager):
    run = a_finished_run_held(manager, with_admission=True)
    main.register_macro_selection(PID, {"selected_macro_ids": []})
    expected = expectation(manager)
    assert expected.run.current is run and expected.run.admission is not None

    assert release.release(manager, expected) is True
    assert current_print_run(manager, PID) is None
    assert start_admission(manager, PID) is None
    assert PID not in main._active_macro_selection


def test_without_an_admission_only_the_run_goes(manager):
    a_finished_run_held(manager)
    expected = expectation(manager)
    assert release.release(manager, expected) is True
    assert current_print_run(manager, PID) is None


def test_the_generation_is_not_advanced_and_a_late_terminal_of_a_stays_silent(manager):
    """A20: the dedup mark makes a late unbound terminal of A a duplicate; B then completes normally."""
    run = a_finished_run_held(manager)
    generation = manager._print_effect_generations[PID]
    assert release.release(manager, expectation(manager)) is True
    assert manager._print_effect_generations[PID] == generation == run.effect_generation

    late = snapshot_completion_token(manager, PID)
    assert late.generation == generation
    assert accept_unbound_completion(manager, late) is False  # A is already done: nothing replays

    claim_print_start(manager, PID, {"subtask_id": "222"})  # a real B starts
    b_token = snapshot_completion_token(manager, PID)
    assert b_token.generation != generation
    assert accept_unbound_completion(manager, b_token) is True


def test_a_new_b_bound_before_the_swap_keeps_everything(manager):
    """A07: B replaced A after the check -- nothing of B, and nothing at all, is removed."""
    a_finished_run_held(manager)
    main.register_macro_selection(PID, {"selected_macro_ids": [3]})
    expected = expectation(manager)
    b = bind_print_run(manager, printer_id=PID, archive_id=20, observed_subtask_id="222", origin="external")

    assert release.release(manager, expected) is False
    assert current_print_run(manager, PID) is b
    assert main._active_macro_selection[PID] == [3]


def test_the_same_run_enriched_into_a_new_object_is_another_run(manager):
    """A08: an equal-looking replacement (``replace``) is not the object that was checked."""
    run = a_finished_run_held(manager)
    expected = expectation(manager)
    manager._print_run_bindings[PID] = replace(run)
    assert release.release(manager, expected) is False
    assert current_print_run(manager, PID) is not None


def test_the_same_archive_with_another_sequence_is_another_run(manager):
    run = a_finished_run_held(manager)
    expected = expectation(manager)
    manager._print_run_bindings[PID] = replace(run, sequence=run.sequence + 1)
    assert release.release(manager, expected) is False


@pytest.mark.parametrize(
    ("field", "value"),
    [("phase", "processing"), ("subtask_id", "333"), ("archive_id", 20), ("generation", 99)],
)
def test_an_admission_changed_in_place_keeps_everything(manager, field, value):
    """The admission is mutable: the same object with other fields is a different start."""
    a_finished_run_held(manager, with_admission=True)
    expected = expectation(manager)
    setattr(start_admission(manager, PID), field, value)
    assert release.release(manager, expected) is False
    assert current_print_run(manager, PID) is not None and start_admission(manager, PID) is not None


def test_an_admission_that_appeared_after_the_check_keeps_everything(manager):
    a_finished_run_held(manager)
    expected = expectation(manager)
    claim_print_start(manager, PID, {"subtask_id": "222"})
    assert release.release(manager, expected) is False


@pytest.mark.parametrize("work", ["resolution", "finishing", "pending_terminal", "stopping"])
def test_any_work_around_the_run_keeps_everything(manager, work):
    run = a_finished_run_held(manager)
    expected = expectation(manager)
    if work == "resolution":
        begin_print_start_resolution(manager, PID, {"subtask_id": "111"})
    elif work == "finishing":
        manager._print_run_finishing_bindings = {(PID, 18): replace(run, archive_id=18)}
    elif work == "pending_terminal":
        manager._pending_print_terminals = {PID: {1: object()}}
    else:
        manager._print_lifecycle_stopping = True
    assert release.release(manager, expected) is False
    assert current_print_run(manager, PID) is run


def test_a_run_that_entered_finishing_is_not_current_any_more(manager):
    a_finished_run_held(manager)
    expected = expectation(manager)
    begin_print_run_finishing(manager, PID, 19)
    assert release.release(manager, expected) is False


def test_a_newer_activity_keeps_everything(manager):
    a_finished_run_held(manager)
    expected = expectation(manager)
    manager._print_effect_generations[PID] += 1
    assert release.release(manager, expected) is False


def test_a_terminal_mark_of_a_newer_activity_keeps_everything(manager):
    run = a_finished_run_held(manager)
    expected = expectation(manager)
    manager._print_terminal_generations = {PID: run.effect_generation + 1}
    assert release.release(manager, expected) is False


@pytest.mark.parametrize("selection", [[], [4, 9]])
def test_the_macro_selection_goes_whatever_it_holds(manager, selection):
    """A22: an empty selection is present -- left, it would silence the next print's own choice."""
    a_finished_run_held(manager)
    main.register_macro_selection(PID, {"selected_macro_ids": selection})
    assert release.release(manager, expectation(manager)) is True
    assert PID not in main._active_macro_selection


def test_a_settled_swap_config_goes(manager):
    a_finished_run_held(manager)
    main.register_swap_config(PID, {"execute_swap_macros": True, "swap_macro_events": ["swap_mode_change_table"]})
    assert release.release(manager, expectation(manager)) is True
    assert PID not in main._active_swap_config


@pytest.mark.parametrize("registry", ["macro", "swap"])
@pytest.mark.parametrize("change", ["replaced", "mutated", "added", "removed"])
def test_a_registration_that_changed_keeps_everything(manager, registry, change):
    """A24: the whole compare-and-clear refuses -- run, admission, dedup and both registrations unchanged."""
    a_finished_run_held(manager, with_admission=True)
    store = main._active_macro_selection if registry == "macro" else main._active_swap_config
    value = [1] if registry == "macro" else {"swap_macro_events": ["swap_mode_change_table"]}
    if change != "added":
        store[PID] = value
    expected = expectation(manager)
    if change == "replaced":
        store[PID] = [1] if registry == "macro" else {"swap_macro_events": ["swap_mode_change_table"]}
    elif change == "mutated":
        store[PID].append(2) if registry == "macro" else store[PID]["swap_macro_events"].append("x")
    elif change == "added":
        store[PID] = value
    else:
        store.pop(PID)
    marks = dict(getattr(manager, "_print_terminal_generations", {}) or {})

    assert release.release(manager, expected) is False
    assert current_print_run(manager, PID) is not None and start_admission(manager, PID) is not None
    assert dict(getattr(manager, "_print_terminal_generations", {}) or {}) == marks


def test_nothing_of_another_printer_is_touched(manager):
    a_finished_run_held(manager)
    other = bind_print_run(manager, printer_id=8, archive_id=30, origin="dispatch")
    main.register_macro_selection(8, {"selected_macro_ids": [5]})
    assert release.release(manager, expectation(manager)) is True
    assert current_print_run(manager, 8) is other and main._active_macro_selection[8] == [5]


def test_capture_of_a_printer_without_a_run_is_nothing_to_release(manager):
    assert release.capture(manager, PID) is None
