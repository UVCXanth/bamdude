"""Real independent DB sessions; no hardware and no process-local serialization."""

import asyncio
from contextlib import ExitStack, asynccontextmanager
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock, patch

from sqlalchemy import func, select, text


@asynccontextmanager
async def no_process_lock(*_args):
    yield


async def run():
    from backend.app.core.database import async_session, engine
    from backend.app.models.archive import PrintArchive
    from backend.app.models.auto_queue import AutoQueueItem
    from backend.app.models.print_queue import PrintQueueItem
    from backend.app.models.print_state_recovery_action import PrintStateRecoveryAction
    from backend.app.models.printer import Printer
    from backend.app.models.printer_queue import PrinterQueue
    from backend.app.services import (
        archive_write_scope as scopes,
        print_reconciliation,
        print_state_recovery_preview as tokens,
        print_state_recovery_store as store,
        queue_ops,
        queue_sources,
    )
    from backend.app.services.background_dispatch import background_dispatch
    from backend.app.services.bambu_mqtt import PrinterState
    from backend.app.services.print_scheduler import scheduler
    from backend.app.services.printer_manager import printer_manager

    states = {}

    async def seed():
        async with async_session() as db:
            printer = Printer(
                name="Recovery test",
                serial_number=f"RECOVERY-{len(states)}",
                ip_address="127.0.0.1",
                access_code="00000000",
                model="P1S",
            )
            db.add(printer)
            await db.flush()
            q = PrinterQueue(printer_id=printer.id, status="printing")
            db.add(q)
            await db.flush()
            start = datetime.now(timezone.utc) - timedelta(hours=2)
            archive = PrintArchive(
                printer_id=printer.id,
                queue_id=q.id,
                filename="synthetic.gcode.3mf",
                file_path="synthetic",
                file_size=0,
                status="completed",
                started_at=start + timedelta(seconds=2),
                completed_at=start + timedelta(hours=1),
                extra_data={},
            )
            db.add(archive)
            await db.flush()
            item = PrintQueueItem(queue_id=q.id, archive_id=archive.id, status="printing", started_at=start)
            db.add(item)
            await db.flush()
            q.current_item_id = item.id
            await db.commit()
            states[printer.id] = PrinterState(connected=True, state="IDLE", connection_generation=1)

            # asynccontextmanager instances are single-use; factories below
            # provide a reusable lock for every concurrent entry instead.
            class Reusable:
                async def __aenter__(self):
                    return self

                async def __aexit__(self, *_):
                    return False

            scopes._archive_locks[archive.id] = Reusable()
            queue_ops._queue_claim_locks[q.id] = Reusable()
            return printer.id, q.id, archive.id, item.id

    async def preview(ids, action="align_terminal_item"):
        async with async_session() as db:
            result = await store.make_preview(db, ids[0], "item", ids[3], action, "user:1")
        return tokens.verify(result["preview_token"])

    async def apply(payload, recheck=None):
        try:
            return await store.apply_preview(async_session, payload, "user:1", "Synthetic operator", recheck=recheck)
        except ValueError as exc:
            return str(exc)

    async def wait_for_db_lock():
        if engine.dialect.name == "postgresql":
            for _ in range(200):
                async with async_session() as observer:
                    waiting = await observer.scalar(
                        text(
                            "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'"
                        )
                    )
                if waiting:
                    return True
                await asyncio.sleep(0.01)
            raise AssertionError("second session never waited on the DB lock")
        # SQLite's busy handler waits in its worker thread; the operation is
        # already issued and must not finish before the holder commits.
        await asyncio.sleep(0.05)
        return True

    results = {}
    with ExitStack() as patches:
        patches.enter_context(patch.dict(scopes._archive_locks))
        patches.enter_context(patch.dict(queue_ops._queue_claim_locks))
        patches.enter_context(
            patch.object(printer_manager, "peek_status", side_effect=lambda pid: (states[pid], 1.0, False))
        )
        patches.enter_context(patch.object(scheduler, "has_dispatch_in_flight", return_value=False))
        patches.enter_context(patch.object(background_dispatch, "has_work_for_printer", return_value=False))
        patches.enter_context(patch.object(queue_sources, "storage_mutation", no_process_lock))

        # Operator owns archive then queue; autorepair waits, then sees the
        # completed item and does not replay or overwrite the operator audit.
        ids = await seed()
        payload = await preview(ids)
        held, release = asyncio.Event(), asyncio.Event()
        auth_checks = 0

        async def pause(_action):
            nonlocal auth_checks
            auth_checks += 1
            if auth_checks % 2:
                return  # The first authority refresh runs before DB guards.
            held.set()
            await release.wait()

        first = asyncio.create_task(apply(payload, pause))
        await asyncio.wait_for(held.wait(), 10)

        async def autorepair():
            async with async_session() as db:
                result = await print_reconciliation._repair_terminal_queue_items(db, ids[0], "IDLE")
                await db.commit()
                return result

        second = asyncio.create_task(autorepair())
        await wait_for_db_lock()
        assert not second.done()
        release.set()
        first_result, auto_result = await asyncio.wait_for(asyncio.gather(first, second), 20)
        assert isinstance(first_result, dict) and auto_result == []
        results["operator_vs_autorepair"] = True

        # Same preview applied by two independent sessions returns ONE result.
        ids = await seed()
        payload = await preview(ids)
        pair = await asyncio.wait_for(asyncio.gather(apply(payload), apply(payload)), 20)
        assert isinstance(pair[0], dict) and pair[0] == pair[1], pair
        async with async_session() as db:
            assert (
                await db.scalar(
                    select(func.count())
                    .select_from(PrintStateRecoveryAction)
                    .where(PrintStateRecoveryAction.printer_id == ids[0])
                )
                == 1
            )
        results["concurrent_idempotency"] = True

        # A new FK ref holds KEY SHARE on the item before apply gets FOR UPDATE.
        # The committed ref must be seen by the late authoritative read.
        ids = await seed()
        payload = await preview(ids, "delete_stale_item")
        async with async_session() as refwriter:
            refwriter.add(AutoQueueItem(status="assigned", assigned_to_item_id=ids[3]))
            await refwriter.flush()
            operation = asyncio.create_task(apply(payload))
            await wait_for_db_lock()
            assert not operation.done()
            await refwriter.commit()
        result = await asyncio.wait_for(operation, 20)
        assert result == "recovery_changed", result
        async with async_session() as db:
            assert await db.get(PrintQueueItem, ids[3]) is not None
        results["late_foreign_reference"] = True

        # Archive edits serialize before the guard and invalidate the preview.
        ids = await seed()
        payload = await preview(ids)
        async with async_session() as editor, scopes.archive_write_scope(editor, ids[2]):
            a = await scopes.load_active_archive_for_write(editor, ids[2])
            a.completed_at += timedelta(seconds=5)
            await editor.flush()
            operation = asyncio.create_task(apply(payload))
            await wait_for_db_lock()
            await editor.commit()
        assert await asyncio.wait_for(operation, 20) == "recovery_changed"
        results["archive_edit"] = True

        # Normal admission cannot race through the paused header after repair.
        ids = await seed()
        payload = await preview(ids)
        held, release = asyncio.Event(), asyncio.Event()
        first = asyncio.create_task(apply(payload, pause))
        await asyncio.wait_for(held.wait(), 10)

        async def claim():
            from backend.app.services.printer_occupancy import (
                PrinterOccupancyConflict,
                read_queue_occupancy,
                require_direct_admission,
            )

            async with async_session() as db, queue_ops.queue_claim_scope(db, ids[1]):
                occupancy = await read_queue_occupancy(db, ids[1], for_update=True)
                try:
                    require_direct_admission(occupancy)
                except PrinterOccupancyConflict as exc:
                    return exc.code
                raise AssertionError("admission crossed a paused queue")

        second = asyncio.create_task(claim())
        await wait_for_db_lock()
        release.set()
        _, refusal = await asyncio.wait_for(asyncio.gather(first, second), 20)
        assert refusal == "queue_paused"
        results["new_claim"] = True

        # Epoch restore and actual delete/recreate (same numeric id) are fenced.
        ids = await seed()
        payload = await preview(ids)
        queue_sources.invalidate_receipts()
        assert await apply(payload) == "recovery_changed"
        payload = await preview(ids)
        async with async_session() as db:
            item = await db.get(PrintQueueItem, ids[3])
            original = {k: getattr(item, k) for k in ("id", "queue_id", "archive_id", "status", "started_at")}
            old_identity = item.recovery_identity
            await db.delete(item)
            await db.flush()
            replacement = PrintQueueItem(**original)
            db.add(replacement)
            await db.commit()
            assert replacement.recovery_identity != old_identity
        assert await apply(payload) == "recovery_changed"
        results["restore_and_id_reuse"] = True
    return results
