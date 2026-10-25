"""The in-memory repair against real independent DB sessions (spec printer-runtime-stall r3 A16).

Run on a SQLite WAL file (``test_runtime_recovery_wal.py``) and on PostgreSQL (``postgres_scenario_runner.py``,
mode ``runtime_recovery``). The process-local locks are the real ones here except where a scenario says so; no
hardware, the printer state is synthetic.
"""

import asyncio
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from sqlalchemy import func, select, text


async def run():
    from backend.app import main
    from backend.app.core.database import async_session, engine
    from backend.app.models.archive import PrintArchive
    from backend.app.models.print_queue import PrintQueueItem
    from backend.app.models.print_state_recovery_action import PrintStateRecoveryAction
    from backend.app.models.printer import Printer
    from backend.app.models.printer_queue import PrinterQueue
    from backend.app.services import (
        print_state_recovery_preview as tokens,
        print_state_recovery_store as store,
        queue_ops,
        runtime_context_release,
    )
    from backend.app.services.background_dispatch import background_dispatch
    from backend.app.services.bambu_mqtt import PrinterState
    from backend.app.services.print_run_binding import bind_print_run, current_print_run
    from backend.app.services.print_scheduler import scheduler
    from backend.app.services.print_state_recovery import RUNTIME_ACTION
    from backend.app.services.printer_manager import printer_manager

    states = {}

    async def seed():
        async with async_session() as db:
            printer = Printer(
                name="Runtime recovery",
                serial_number=f"RUNTIME-{len(states)}",
                ip_address="127.0.0.1",
                access_code="00000000",
                model="P1S",
            )
            db.add(printer)
            await db.flush()
            queue = PrinterQueue(printer_id=printer.id, status="idle")
            db.add(queue)
            await db.flush()
            start = datetime.now(timezone.utc) - timedelta(hours=2)
            archive = PrintArchive(
                printer_id=printer.id,
                queue_id=queue.id,
                filename="synthetic.gcode.3mf",
                file_path="synthetic",
                file_size=0,
                status="completed",
                started_at=start,
                completed_at=start + timedelta(hours=1),
                extra_data={},
            )
            db.add(archive)
            db.add(PrintQueueItem(queue_id=queue.id, status="pending", position=1))
            await db.commit()
            states[printer.id] = PrinterState(connected=True, state="FINISH", connection_generation=1)
            bind_print_run(
                printer_manager,
                printer_id=printer.id,
                archive_id=archive.id,
                expected_submission_id="9",
                origin="dispatch",
            )
            return printer.id, queue.id, archive.id

    async def preview(ids):
        async with async_session() as db:
            result = await store.make_preview(db, ids[0], "runtime", ids[2], RUNTIME_ACTION, "user:1")
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
        await asyncio.sleep(0.05)
        return True

    async def audit_rows(printer_id):
        async with async_session() as db:
            return await db.scalar(
                select(func.count())
                .select_from(PrintStateRecoveryAction)
                .where(PrintStateRecoveryAction.printer_id == printer_id)
            )

    results = {}
    with ExitStack() as patches:
        for registry in (
            "_print_run_bindings",
            "_print_start_admissions",
            "_print_start_resolutions",
            "_print_terminal_generations",
            "_print_run_finishing_bindings",
            "_pending_print_terminals",
        ):
            # Created lazily by their owner: a fresh server may not have them yet.
            patches.enter_context(patch.object(printer_manager, registry, {}, create=True))
        patches.enter_context(patch.object(main, "_active_macro_selection", {}))
        patches.enter_context(patch.object(main, "_active_swap_config", {}))
        patches.enter_context(
            patch.object(printer_manager, "peek_status", side_effect=lambda pid: (states[pid], 1.0, False))
        )
        patches.enter_context(patch.object(scheduler, "has_dispatch_in_flight", return_value=False))
        patches.enter_context(patch.object(background_dispatch, "has_work_for_printer", return_value=False))
        released = []
        real_release = runtime_context_release.release

        def counting(manager, expected):
            answer = real_release(manager, expected)
            released.append(answer)
            return answer

        patches.enter_context(patch.object(runtime_context_release, "release", counting))

        # A start racing the repair waits for its guards and then finds the queue paused.
        ids = await seed()
        payload = await preview(ids)
        held, release = asyncio.Event(), asyncio.Event()
        checks = 0

        async def hold_in_the_intent(_action, _db):
            nonlocal checks
            checks += 1
            if checks == 2:  # inside the first commit's guards
                held.set()
                await release.wait()

        first = asyncio.create_task(apply(payload, hold_in_the_intent))
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
                return "admitted"

        second = asyncio.create_task(claim())
        await wait_for_db_lock()
        release.set()
        outcome, refusal = await asyncio.wait_for(asyncio.gather(first, second), 30)
        assert isinstance(outcome, dict) and outcome["outcome"] == "applied", outcome
        assert refusal == "queue_paused", refusal
        assert current_print_run(printer_manager, ids[0]) is None
        results["new_start_sees_the_pause"] = True

        # The same token from two requests at once: one compare-and-clear, one intent and one outcome.
        released.clear()
        ids = await seed()
        payload = await preview(ids)
        pair = await asyncio.wait_for(asyncio.gather(apply(payload), apply(payload)), 30)
        assert all(isinstance(p, dict) and p["operation_id"] == payload["nonce"] for p in pair), pair
        assert released == [True], released
        assert await audit_rows(ids[0]) == 2
        results["one_clear_per_token"] = True

        # B bound between the two commits is never touched; the pause stays.
        released.clear()
        ids = await seed()
        payload = await preview(ids)
        checks = 0
        holder = {}

        async def b_between(_action, _db):
            nonlocal checks
            checks += 1
            if checks == 3:  # the second commit's recheck: the first is committed
                holder["b"] = bind_print_run(
                    printer_manager, printer_id=ids[0], archive_id=ids[2] + 500, observed_subtask_id="77"
                )

        result = await asyncio.wait_for(apply(payload, b_between), 30)
        assert result["outcome"] == "not_applied_changed", result
        assert current_print_run(printer_manager, ids[0]) is holder["b"]
        async with async_session() as db:
            assert (await db.get(PrinterQueue, ids[1])).is_paused is True
        results["b_between_commits_untouched"] = True
    return results
