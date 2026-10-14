"""Who may clear a swap printer's plate at the end of a print (swap-source-lifecycle spec r4 §10 D5, plan T7).

A source that declares its own plate-swap sequence clears the plate only for THE run BamDude can prove it
addressed: a bound terminal it accepted, of a proven origin (its dispatch, an external start it saw, an exact
device subtask), completed, with the archive's declaration strictly True, read once after the last-chance
attach -- and never for an order auto-eject archive, whose own plate lifecycle stays. A run found by a name, an
alias or an ILIKE, or one adopted after the fact, archives as before but clears nothing. A missing status is
completed; an empty one is not.
"""

from __future__ import annotations

import pytest

from backend.app import main
from backend.app.models.archive import PrintArchive
from backend.app.services import swap_compatibility as sc
from backend.tests.integration.swap_terminal_support import (
    CONFLICT,
    LEGACY,
    an_execution,
    archive_of,
    complete,
    gate_armed,
    make_rig,  # noqa: F401 -- the fixture
    stand_gate,
)

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]

STATUSES = {
    "completed": {"status": "completed", "subtask_id": "81"},
    "failed": {"status": "failed", "subtask_id": "81"},
    "cancelled": {"status": "cancelled", "subtask_id": "81"},
    "missing": {"subtask_id": "81"},
    "empty": {"status": "", "subtask_id": "81"},
}
FACTS = {
    "true": True,
    "false": False,
    "unknown": None,
    "conflict": CONFLICT,
    "legacy_false": LEGACY,
    "legacy_true": (LEGACY, True),
}
#: The only combinations whose baked sequence clears the plate: strictly True (a legacy True column counts, D1)
#: and completed (a missing status is completed; an empty one is not).
CLEARS = {(fact, status) for fact in ("true", "legacy_true") for status in ("completed", "missing")}


@pytest.mark.parametrize("status_label", list(STATUSES))
@pytest.mark.parametrize("fact_label", list(FACTS))
async def test_live_bound_terminal_swap_clear_matrix(fact_label, status_label, make_rig):
    rig = await make_rig()
    await an_execution(rig, fact=FACTS[fact_label])

    await complete(rig, STATUSES[status_label])

    clears = (fact_label, status_label) in CLEARS
    assert gate_armed(rig) is (not clears)
    rig.macro.assert_not_awaited()


async def test_a_baked_clear_also_releases_a_standing_gate(make_rig):
    rig = await make_rig()
    await stand_gate(rig)
    await an_execution(rig, fact=True)

    await complete(rig)

    assert gate_armed(rig) is False


async def test_unknown_does_not_release_a_standing_gate(make_rig):
    rig = await make_rig(require_plate_clear=False)
    await stand_gate(rig)
    await an_execution(rig, fact=None)

    await complete(rig)

    assert gate_armed(rig) is True


@pytest.mark.parametrize("how", ["adopted_or_alias_binding", "unbound_alias", "unbound_ilike"])
async def test_name_only_rebound_adopt_alias_and_ilike_do_not_clear(how, make_rig):
    rig = await make_rig()
    archive_id, _item = await an_execution(
        rig, fact=True, bound=how == "adopted_or_alias_binding", origin="observed", name="lamp"
    )
    if how == "unbound_alias":
        main._active_prints[(rig.printer_id, "lamp.gcode.3mf")] = archive_id

    await complete(rig, {"status": "completed", "filename": "lamp.gcode.3mf", "subtask_name": "lamp"})

    assert (await archive_of(rig, archive_id)).status == "completed", "the run is still archived"
    assert gate_armed(rig) is True, "a name proves no run, so the baked sequence clears nothing"


async def test_exact_rebound_terminal_keeps_authority(make_rig):
    rig = await make_rig()
    await an_execution(rig, fact=True, origin="exact_subtask")

    await complete(rig)

    assert gate_armed(rig) is False


async def test_a_live_external_start_is_a_proven_origin(make_rig):
    rig = await make_rig()
    await an_execution(rig, fact=True, origin="external")

    await complete(rig)

    assert gate_armed(rig) is False


async def test_duplicate_stale_generation_and_newer_owner_keep_plate(make_rig, monkeypatch):
    rig = await make_rig()
    await stand_gate(rig)
    await an_execution(rig, fact=True)
    # A newer run owns the printer by the time this completion reaches its plate decision.
    monkeypatch.setattr("backend.app.services.print_run_binding.print_effect_is_current", lambda *_a, **_k: False)

    await complete(rig)

    assert gate_armed(rig) is True, "the old run neither releases the standing gate nor arms a new one"


async def test_a_replayed_terminal_changes_nothing(make_rig):
    rig = await make_rig()
    await an_execution(rig, fact=True)
    await complete(rig)
    assert gate_armed(rig) is False

    await stand_gate(rig)  # the operator's next print armed it meanwhile
    await complete(rig)  # the duplicate of the same terminal

    assert gate_armed(rig) is True


async def test_last_chance_attach_changes_only_current_terminal_decision(make_rig, monkeypatch):
    rig = await make_rig()
    archive_id, _item = await an_execution(rig, fact=None, file_path="")
    async with rig.db() as db:
        row = await db.get(PrintArchive, archive_id)
        sc.write_archive_fact(row, None, pending_external=True)
        await db.commit()

    async def last_chance_attach(archive_id):
        # The 3MF lands in the completion's own last-chance window, declaring a baked sequence.
        async with rig.db() as db:
            row = await db.get(PrintArchive, archive_id)
            row.file_path = "archive/1/job.swap.gcode.3mf"
            sc.write_archive_fact(row, True)
            await db.commit()
        return "recovered"

    monkeypatch.setattr(
        "backend.app.services.archive_download_retry.archive_download_retry.retry_archive", last_chance_attach
    )

    await complete(rig)

    assert gate_armed(rig) is False, "the decision reads the fact after the awaited attach"


async def test_late_attach_cannot_replay_effects(make_rig):
    rig = await make_rig()
    archive_id, _item = await an_execution(rig, fact=None, file_path="")
    await complete(rig)
    assert gate_armed(rig) is True

    # The file arrives later (a retained claim, a manual retry) and says True; the terminal already decided.
    async with rig.db() as db:
        row = await db.get(PrintArchive, archive_id)
        sc.write_archive_fact(row, True)
        await db.commit()
    await complete(rig)  # a replayed terminal of the finished run

    assert gate_armed(rig) is True
    rig.macro.assert_not_awaited()


async def test_auto_eject_true_source_keeps_gate_receipt_lifecycle(make_rig):
    # A non-swap printer that does not even ask for plate confirmation: the order's auto-eject owns the plate.
    rig = await make_rig(require_plate_clear=False, swap_mode=False)
    await an_execution(rig, fact=True, auto_eject=True)

    await complete(rig)

    assert gate_armed(rig) is True, "True never skips the auto-eject arm"


async def test_a_baked_clear_with_no_gate_makes_no_release_call(make_rig, monkeypatch):
    """The release is guarded on a gate actually standing: without one every swap print would publish a
    redundant write and status broadcast for a flag already false."""
    from unittest.mock import MagicMock

    rig = await make_rig()
    await an_execution(rig, fact=True)
    setter = MagicMock()
    monkeypatch.setattr(rig.manager, "set_awaiting_plate_clear", setter)

    await complete(rig)

    setter.assert_not_called()
