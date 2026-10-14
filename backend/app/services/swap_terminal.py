"""What a finished run may do to a swap printer's plate (swap-source-lifecycle spec r4 §10, plan T7).

Two decisions, both taken once per run, and both asked by the live completion and by the connect-edge sweep:

* **baked clear** -- the source's own plate-swap sequence cleared the plate: only for a run BamDude can prove
  it addressed, completed, over a declaration strictly True, and never for an order auto-eject archive;
* **our change_table** -- the macro dispatch left owed: only for a proven, completed run on a printer still in
  swap mode, over a source KNOWN not to carry its own sequence (False). Anything else HOLDS: nothing runs, the
  event stays owed, the plate is not cleared, and the queue waits with a reason.

The reason says whether our swap cycle had begun -- the start macro's outcome dispatch recorded on the
execution archive. A list of requested events proves nothing.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from backend.app.i18n import current_language, t
from backend.app.services import swap_compatibility

#: The swap-start macro's outcome, recorded on the execution archive by dispatch: ``possibly_fired`` from the
#: moment the command may leave, ``fired`` once the printer acknowledged it.
START_EFFECT_KEY = "swap_start_effect"
START_POSSIBLY_FIRED = "possibly_fired"
START_FIRED = "fired"

#: What a held run records on its archive: the codes the archive card shows (never a sentence).
HOLD_KEY = "swap_hold"

CYCLE_STARTED = "started"
CYCLE_POSSIBLY_STARTED = "possibly_started"
CYCLE_NOT_STARTED = "not_started"

#: Why our change_table did not run. Each is a key of ``filament_routing`` and of the frontend's archive card.
HOLD_SOURCE_UNKNOWN = "swap_hold_source_unknown"
HOLD_SOURCE_BAKED = "swap_hold_source_baked"
HOLD_RUN_UNPROVEN = "swap_hold_run_unproven"
HOLD_NOT_COMPLETED = "swap_hold_not_completed"
HOLD_SWAP_OFF = "swap_hold_swap_off"
HOLD_OUTCOME_UNCERTAIN = "swap_hold_outcome_uncertain"
HOLD_MACRO_ERROR = "swap_hold_macro_error"
HOLD_REASONS = frozenset(
    {
        HOLD_SOURCE_UNKNOWN,
        HOLD_SOURCE_BAKED,
        HOLD_RUN_UNPROVEN,
        HOLD_NOT_COMPLETED,
        HOLD_SWAP_OFF,
        HOLD_OUTCOME_UNCERTAIN,
        HOLD_MACRO_ERROR,
    }
)


def record_start_effect(archive, stage: str) -> None:
    """Dispatch's one writer of the start macro's outcome on the execution archive (a new dict, other keys kept)."""
    if stage not in (START_POSSIBLY_FIRED, START_FIRED):
        raise ValueError(f"not a swap-start outcome: {stage!r}")
    extra = getattr(archive, "extra_data", None)
    merged = dict(extra) if isinstance(extra, Mapping) else {}
    merged[START_EFFECT_KEY] = stage
    archive.extra_data = merged


def cycle_state(extra: Mapping | None) -> str:
    """Whether our swap cycle began for this run, from what dispatch recorded.

    An archive with a declaration record was created by a dispatch that records the start, so no record of the
    start means it was not called. One without (from before the fix) has no fact either way: may have started.
    """
    extra = extra if isinstance(extra, Mapping) else {}
    effect = extra.get(START_EFFECT_KEY)
    if effect == START_FIRED:
        return CYCLE_STARTED
    if effect == START_POSSIBLY_FIRED:
        return CYCLE_POSSIBLY_STARTED
    if swap_compatibility.CARRIER_KEY in extra:
        return CYCLE_NOT_STARTED
    return CYCLE_POSSIBLY_STARTED


def baked_clears(fact: Any, *, completed: bool, proven: bool, auto_eject: bool) -> bool:
    """D5: the source's own sequence cleared the plate -- this exact run, completed, strictly True, no auto-eject."""
    return completed and proven and fact is True and not auto_eject


def change_table_hold(fact: Any, *, completed: bool, proven: bool, swap_mode: bool) -> str | None:
    """D3: ``None`` when our owed change_table may run; otherwise why it holds."""
    if not completed:
        return HOLD_NOT_COMPLETED
    if not proven:
        return HOLD_RUN_UNPROVEN
    if fact is True:
        return HOLD_SOURCE_BAKED
    if fact is not False:
        return HOLD_SOURCE_UNKNOWN
    if not swap_mode:
        return HOLD_SWAP_OFF
    return None


async def pending_fact(db, archive, execution_item) -> bool | None:
    """The declaration our owed change_table is decided on.

    The archive's own record answers. Only a record-less archive (from before the fix, whose False the reader
    calls unknown) may ask the job that ran it -- the exact execution-linked row the caller proved -- through
    that job's own snapshot and its §6 resolution; never a source archive of a reprint, never a name.
    """
    fact = swap_compatibility.archive_fact(archive)
    if fact.recorded or fact.invalid or fact.value is not None or execution_item is None:
        return fact.value
    from backend.app.services.filament_intake import item_descriptor

    descriptor = await item_descriptor(db, execution_item)
    return descriptor.swap_fact.value if descriptor is not None else None


def hold_text(reason: str, cycle: str, lang: str | None = None) -> str:
    """The sentence the operator reads -- the cycle's when it may have begun, the reason's otherwise."""
    lang = lang or current_language()
    if cycle == CYCLE_STARTED:
        return t(lang, "filament_routing", "swap_cycle_started")
    if cycle == CYCLE_POSSIBLY_STARTED:
        return t(lang, "filament_routing", "swap_cycle_possibly_started")
    return t(lang, "filament_routing", reason)


def hold_record(reason: str, cycle: str) -> dict:
    return {"reason": reason, "cycle": cycle}


def clear_hold(archive) -> bool:
    """Our table swap ran: what an earlier decision recorded as held no longer stands (a new dict, other keys
    kept). Returns whether there was a hold to clear."""
    extra = getattr(archive, "extra_data", None)
    if not isinstance(extra, Mapping) or HOLD_KEY not in extra:
        return False
    archive.extra_data = {key: value for key, value in extra.items() if key != HOLD_KEY}
    return True
