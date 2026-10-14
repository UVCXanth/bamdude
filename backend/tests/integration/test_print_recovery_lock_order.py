"""Recovery must take every local guard before SQLite's writer, including all archives in autorepair."""

import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from backend.app.models.archive import PrintArchive
from backend.app.models.print_queue import PrintQueueItem
from backend.app.services import (
    archive_write_scope as archives,
    print_reconciliation,
    print_state_recovery_preview as tokens,
    print_state_recovery_store as store,
    queue_ops,
)
from backend.tests.integration.test_print_recovery_key_authority import recovery_key  # noqa: F401
from backend.tests.unit.services.test_terminal_queue_repair import telemetry  # noqa: F401

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]


async def held_first(monkeypatch, module, name):
    real = getattr(module, name)
    entered, release = asyncio.Event(), asyncio.Event()
    count = 0

    async def held(*args, **kwargs):
        nonlocal count
        count += 1
        if count == 1:
            entered.set()
            await release.wait()
        return await real(*args, **kwargs)

    monkeypatch.setattr(module, name, held)
    return entered, release


@pytest.mark.parametrize("writer", ["operator", "autorepair"])
async def test_recovery_and_another_archive_claim_on_the_same_lane_finish(recovery_key, monkeypatch, telemetry, writer):
    _, factory, (pid, iid, _), _raw = recovery_key
    start = datetime.now(timezone.utc) - timedelta(hours=2)
    async with factory() as db:
        other = PrintArchive(
            printer_id=pid,
            queue_id=pid,
            filename="other.gcode.3mf",
            file_path="synthetic",
            file_size=0,
            status="completed",
            started_at=start,
            completed_at=start + timedelta(hours=1),
            extra_data={},
        )
        db.add(other)
        await db.flush()
        other_id = other.id
        if writer == "autorepair":
            db.add(PrintQueueItem(queue_id=pid, archive_id=other.id, status="printing", started_at=start))
        await db.commit()
        preview = await store.make_preview(db, pid, "item", iid, "align_terminal_item", "user:1")

    if writer == "operator":
        entered, release = await held_first(monkeypatch, store, "load_active_archive_for_write")
        operation = store.apply_preview(factory, tokens.verify(preview["preview_token"]), "user:1", "Operator")
    else:
        entered, release = await held_first(monkeypatch, archives, "load_active_archive_for_write")

        async def repair():
            async with factory() as db:
                result = await print_reconciliation._repair_terminal_queue_items(db, pid, "IDLE")
                await db.commit()
                return result

        operation = repair()

    first = asyncio.create_task(operation)
    second_entered = asyncio.Event()

    async def other_claim():
        second_entered.set()
        async with factory() as db, queue_ops.claim_lanes(db, [pid], archive_id=other_id):
            await db.commit()

    second = None
    try:
        await asyncio.wait_for(entered.wait(), 5)
        second = asyncio.create_task(other_claim())
        await second_entered.wait()
        await asyncio.sleep(0.05)
        assert not second.done(), "the second writer must actually contend"
        release.set()
        results = await asyncio.wait_for(asyncio.gather(first, second, return_exceptions=True), 3)
        assert not [value for value in results if isinstance(value, BaseException)], results
    finally:
        release.set()
        for task in (first, second):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(*(task for task in (first, second) if task is not None), return_exceptions=True)
