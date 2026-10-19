"""The print lifecycle's process-global registries never outlive a test.

``printer_manager`` is a singleton, and the print-start admissions, start resolutions, run bindings, effect and
terminal generations hang off it -- as ``print_reconciliation._live_completions`` hangs off its module. A test that
drives ``on_print_start`` through the real manager leaves an admission behind; operator print-state recovery reads
"an admission without a run" as a busy printer and offers no repair, so every recovery test that later lands on the
same worker failed (CI, 2026-10-15) while each passed on its own. The pair below is that order, pinned.
"""

REGISTRIES = (
    "_print_start_admissions",
    "_print_start_resolutions",
    "_print_run_bindings",
    "_print_run_finishing_bindings",
    "_print_effect_generations",
    "_print_terminal_generations",
    "_pending_print_terminals",
)


def test_a_test_may_leave_the_print_registries_dirty():
    from backend.app.services import print_reconciliation
    from backend.app.services.printer_manager import printer_manager

    for name in REGISTRIES:
        setattr(printer_manager, name, {1: object()})
    printer_manager._print_lifecycle_stopping = True
    print_reconciliation._live_completions[1] = 1


def test_the_next_test_starts_with_clean_print_registries():
    from backend.app.services import print_reconciliation
    from backend.app.services.printer_manager import printer_manager

    assert {name: dict(getattr(printer_manager, name, None) or {}) for name in REGISTRIES} == {
        name: {} for name in REGISTRIES
    }
    assert not getattr(printer_manager, "_print_lifecycle_stopping", False)
    assert print_reconciliation._live_completions == {}
