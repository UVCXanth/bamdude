"""Recovery against T9 writers on real PostgreSQL, with local locks disabled.

Run in the existing isolated scenario interpreter only after the T9 branch is integrated.
"""

import asyncio
import uuid

from backend.tests.integration.swap_claim_scenarios import _outcome, _process_locks_off, _waiting_on_a_lock
from backend.tests.integration.swap_declaration_scenarios import (
    _actor,
    _archive_farm,
    _job_rights,
    _rights,
    _storage_guard_off,
    _user,
)


def _idle_printers() -> None:
    """What recovery and the autorepair read live: a connected, idle printer with nothing in flight."""
    from unittest.mock import Mock

    from backend.app.services.background_dispatch import background_dispatch
    from backend.app.services.bambu_mqtt import PrinterState
    from backend.app.services.print_scheduler import scheduler
    from backend.app.services.printer_manager import printer_manager

    state = PrinterState(connected=True, state="IDLE", connection_generation=1)
    printer_manager.peek_status = Mock(return_value=(state, 10.0, False))
    scheduler.has_dispatch_in_flight = Mock(return_value=False)
    background_dispatch.has_work_for_printer = Mock(return_value=False)


async def _stuck_run(queue_id: int) -> tuple[int, int]:
    from datetime import datetime, timedelta, timezone

    from backend.app.core.database import async_session
    from backend.app.models.archive import PrintArchive
    from backend.app.models.print_queue import PrintQueueItem
    from backend.app.models.printer_queue import PrinterQueue

    started = datetime.now(timezone.utc).replace(tzinfo=None, microsecond=0) - timedelta(hours=2)
    async with async_session() as db:
        archive = PrintArchive(
            printer_id=queue_id,
            queue_id=queue_id,
            filename="stuck.gcode.3mf",
            file_path="",
            file_size=0,
            status="completed",
            started_at=started,
            completed_at=started + timedelta(hours=1),
            print_time_seconds=3600,
            extra_data={},
        )
        db.add(archive)
        await db.flush()
        item = PrintQueueItem(queue_id=queue_id, archive_id=archive.id, status="printing", started_at=started)
        db.add(item)
        await db.flush()
        queue = await db.get(PrinterQueue, queue_id)
        queue.status, queue.current_item_id = "printing", item.id
        await db.commit()
        return archive.id, item.id


async def _recovery_payload(printer_id: int, item_id: int) -> dict:
    from backend.app.core.database import async_session
    from backend.app.services import print_state_recovery_preview as tokens, print_state_recovery_store as store

    async with async_session() as db:
        preview = await store.make_preview(
            db, printer_id, "item", item_id, "align_terminal_item", "user:1", confirmed_completed=True
        )
    return tokens.verify(preview["preview_token"])


def _first_call_held(module, name, nth: int = 1):
    """Hold the ``nth`` call of ``module.name`` until released -- the point where its writer holds everything."""
    real = getattr(module, name)
    holds, release, calls = asyncio.Event(), asyncio.Event(), [0]

    async def held(*args, **kwargs):
        calls[0] += 1
        if calls[0] == nth:
            holds.set()
            await release.wait()
        return await real(*args, **kwargs)

    setattr(module, name, held)
    return holds, release, (lambda: setattr(module, name, real))


async def _waits_or_finishes(task, seconds: float = 3.0) -> int:
    """Up to ``seconds``: the number of sessions PostgreSQL shows waiting on a lock, or 0 once ``task`` finished."""
    for _ in range(int(seconds / 0.025)):
        if task.done():
            return 0
        seen = await _waiting_on_a_lock()
        if seen:
            return seen
        await asyncio.sleep(0.025)
    return 0


async def _pair(hold_module, hold_name, first_coro_factory, second_coro_factory, *, nth: int = 1) -> dict:
    holds, release, restore = _first_call_held(hold_module, hold_name, nth)
    try:
        first = asyncio.ensure_future(_outcome(first_coro_factory()))
        await asyncio.wait_for(holds.wait(), 30)
        second = asyncio.ensure_future(_outcome(second_coro_factory()))
        waited = await _waits_or_finishes(second)
        release.set()
        return {"first": await first, "second": await second, "waited": waited}
    finally:
        release.set()
        restore()


async def scenario_integrated_lock_order() -> dict:
    """Recovery holds its archive (and, if it takes it, its lane) while a change_table claim / a refresh of ANOTHER
    archive on the same lane starts; the autorepair holds the first of two printing archives while a claim of the
    second starts. Whatever waits, nothing may deadlock, time out or fail."""
    from backend.app.core.database import async_session
    from backend.app.models.archive import PrintArchive
    from backend.app.services import (
        archive_write_scope,
        print_reconciliation,
        print_state_recovery_store as store,
        swap_job_refresh as jobs,
        swap_terminal,
    )

    _process_locks_off()
    _storage_guard_off()  # two processes share no storage guard either
    _idle_printers()
    out: dict = {}
    user = await _user()

    async def owed(archive_id):
        async with async_session() as db:
            archive = await db.get(PrintArchive, archive_id)
            archive.extra_data = {**(archive.extra_data or {}), "swap_macro_events_pending": ["swap_mode_change_table"]}
            await db.commit()

    # Recovery vs a change_table claim of another archive on its lane.
    farm = await _archive_farm(user)
    lane = farm.printers[0]
    _a, item = await _stuck_run(lane)
    await owed(farm.archive_id)
    payload = await _recovery_payload(lane, item)
    out["recovery_vs_claim"] = await _pair(
        store,
        "read_facts",
        lambda: store.apply_preview(async_session, payload, "user:1", "Operator"),
        lambda: swap_terminal.claim_change_table(
            async_session, farm.archive_id, queue_id=lane, owner="pg", allow_absent=True
        ),
        nth=2,
    )
    swap_terminal._sending.discard(farm.archive_id)

    # Recovery vs a refresh of another archive's job on its lane.
    farm = await _archive_farm(user)
    lane = farm.printers[0]
    _a, item = await _stuck_run(lane)
    payload = await _recovery_payload(lane, item)
    listing = await jobs.candidates(
        "archive", farm.archive_id, actor=_actor(user), rights=_rights(), job_rights=_job_rights()
    )
    out["recovery_vs_refresh"] = await _pair(
        store,
        "read_facts",
        lambda: store.apply_preview(async_session, payload, "user:1", "Operator"),
        lambda: _refresh_raises(farm, user, listing),
        nth=2,
    )

    # The autorepair over two printing archives vs a claim of the second.
    farm = await _archive_farm(user)
    lane = farm.printers[0]
    first, _i1 = await _stuck_run(lane)
    second, _i2 = await _stuck_run(lane)
    await owed(second)

    async def autorepair():
        async with async_session() as db:
            await print_reconciliation._repair_terminal_queue_items(db, lane, "IDLE")
            await db.commit()

    out["autorepair_vs_claim"] = await _pair(
        archive_write_scope,
        "load_active_archive_for_write",
        autorepair,
        lambda: swap_terminal.claim_change_table(async_session, second, queue_id=lane, owner="pg", allow_absent=True),
        nth=2,
    )
    swap_terminal._sending.discard(second)
    out["first_before_second"] = first < second
    return out


async def _refresh_raises(farm, user, listing):
    """A refresh as a coroutine that raises on a refusal (``_outcome`` turns any exception into its report)."""
    from backend.app.services import swap_job_refresh as jobs

    return await jobs.refresh(
        "archive",
        farm.archive_id,
        declaration_id=listing["declaration_id"],
        source_revision=listing["source_revision"],
        jobs=[jobs.JobRef(entry["kind"], entry["id"], entry["revision"]) for entry in listing["jobs"]],
        operation_id=str(uuid.uuid4()),
        actor=_actor(user),
        rights=_rights(),
        job_rights=_job_rights(),
    )
