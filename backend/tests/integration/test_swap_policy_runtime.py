"""One runtime decision on our swap macros, after capture and before any effect -- spec r4 §8, plan T4.4-T4.5.

Whatever a job's options asked for, the dispatcher decides once -- right after the claim, the routing and the
copy of a source that had none -- from the job's own declaration: True mutes our macros (the source carries its
own sequence), False runs exactly what was asked under the printer's swap mode, and an unknown source with an
effective request fails before dispatch (D2) instead of starting without the swap it was asked for. The
decision rewrites ``job.options`` in place, so the three consumers -- the execution archive's pending events, the
swap-start macro and the in-memory config ``on_print_complete`` reads -- all see the same answer.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.core.config import settings
from backend.app.models.archive import PrintArchive
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer_queue import PrinterQueue
from backend.app.services import queue_sources, swap_compatibility as sc
from backend.app.services.filament_intake import routing_detail
from backend.app.services.queue_source_descriptor import SOURCE_SNAPSHOT_VERSION
from backend.tests.integration.test_dispatch_without_original import (
    PLATE,
    a_sliced_file,
    an_archive_source,
    dispatch_mocks,
    drain,
    scheduler_with_captured_dispatch,
)
from backend.tests.integration.test_filament_routing_dispatch import setup_source

pytestmark = pytest.mark.integration

EVENTS = ["swap_mode_start", "swap_mode_change_table"]


@pytest.fixture(autouse=True)
def clean_state():
    from backend.app.services.printer_manager import printer_manager

    queue_sources._reset_state()
    for attribute in (
        "_print_run_bindings",
        "_print_run_finishing_bindings",
        "_print_start_resolutions",
        "_pending_print_terminals",
    ):
        registry = getattr(printer_manager, attribute, None)
        if isinstance(registry, dict):
            registry.clear()
    printer_manager._awaiting_plate_clear.clear()
    yield
    deadline = time.monotonic() + 10
    while queue_sources.active_captures() and time.monotonic() < deadline:  # pragma: no cover - drain
        time.sleep(0.01)
    queue_sources._reset_state()


@pytest.fixture
def sessions(test_engine, monkeypatch):
    from backend.app.core import database

    factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr(database, "async_session", factory)
    return factory


async def a_blob(sessions, path):
    async def attach(session, source):
        return None

    receipt = await queue_sources.capture(
        queue_sources.CaptureRequest(path=path, format="3mf", display_filename=path.name)
    )
    return await queue_sources.publish(receipt, attach, session_factory=sessions)


class Effects:
    """What reached the hardware and the completion handler's config."""

    def __init__(self, monkeypatch, service):
        import backend.app.main as main_module
        import backend.app.services.background_dispatch as bd

        self.macros: list[str] = []
        self.registered: list[dict] = []

        async def find_swap_macro(db, event, printer):
            return SimpleNamespace(gcode=f"; {event}", name=event)

        async def execute_macro_and_wait(printer_id, gcode, name):
            self.macros.append(name)
            return True, "ok"

        monkeypatch.setattr("backend.app.services.macro_executor.find_swap_macro", find_swap_macro)
        monkeypatch.setattr(bd.printer_manager, "execute_macro_and_wait", execute_macro_and_wait)
        # The real swap-start step, not dispatch_mocks' stub: it reads job.options itself.
        monkeypatch.setattr(
            service,
            "_run_swap_macro_if_needed",
            bd.BackgroundDispatchService._run_swap_macro_if_needed.__get__(service),
        )
        monkeypatch.setattr(
            main_module, "register_swap_config", lambda printer_id, options: self.registered.append(dict(options))
        )


async def a_claimed_job(db, sessions, tmp_path, printer, queue, *, kind, fact, origin):
    """A job holding the printer's claim, with its own captured source and the declaration ``fact``."""
    if kind == "library":
        from backend.app.models.library import LibraryFile

        path = a_sliced_file(tmp_path / "lamp.gcode.3mf")
        source = LibraryFile(filename=path.name, file_path=str(path), file_size=path.stat().st_size, file_type="gcode")
        db.add(source)
        await db.commit()
        link = {"library_file_id": source.id}
    else:
        source = await an_archive_source(db, tmp_path, printer.id)
        path = settings.base_dir / source.file_path
        link = {"archive_id": source.id}
    blob = await a_blob(sessions, path)
    snapshot = {
        "version": SOURCE_SNAPSHOT_VERSION,
        "provenance": {"kind": "library_file" if kind == "library" else "archive", "id": source.id},
        "display_filename": source.filename,
        "format": "3mf",
        "plate_fallback": PLATE if kind == "archive" else None,
        **sc.snapshot_fields(sc.SourceFact(fact) if fact is not None else sc.UNKNOWN_SOURCE),
    }
    from backend.app.services.filament_policy_write import prepare_routing

    routing, plate = await prepare_routing(db, printer_id=printer.id, **link)
    started = datetime.now(timezone.utc)
    item = PrintQueueItem(
        queue_id=queue.id,
        status="printing" if origin == "direct" else "pending",
        started_at=started if origin == "direct" else None,
        position=1,
        origin=origin,
        queue_source_id=blob.id,
        source_snapshot=snapshot,
        filament_routing=routing,
        plate_id=plate,
        execute_swap_macros=True,
        swap_macro_events=json.dumps(EVENTS),
        **link,
    )
    db.add(item)
    await db.flush()
    if origin == "direct":
        claim = await db.get(PrinterQueue, queue.id)
        claim.status, claim.current_item_id = "printing", item.id
    await db.commit()
    return item, source


async def run(db, monkeypatch, test_engine, item, source, printer, *, kind, origin):
    from backend.app.services.background_dispatch import PrintDispatchJob

    factory = async_sessionmaker(test_engine, expire_on_commit=False)
    service = dispatch_mocks(monkeypatch, factory)
    effects = Effects(monkeypatch, service)
    if origin == "queue":
        scheduler, spawned = scheduler_with_captured_dispatch(monkeypatch)
        assert await scheduler.check_queue() is True
        await drain(spawned)
        return effects, None
    job = PrintDispatchJob(
        id=1,
        kind="print_library_file" if kind == "library" else "reprint_archive",
        source_id=source.id,
        source_name=source.filename,
        printer_id=printer.id,
        printer_name=printer.name,
        options={"plate_id": PLATE, "execute_swap_macros": True, "swap_macro_events": list(EVENTS)},
        queue_item_id=item.id,
    )
    await service._run_active_job(job)
    return effects, job


@pytest.mark.parametrize("fact", [True, None, False], ids=["baked", "unknown", "plain"])
@pytest.mark.parametrize("kind", ["library", "archive"])
@pytest.mark.parametrize("origin", ["queue", "direct"])
async def test_runner_backstop_covers_all_three_macro_consumers(
    origin, kind, fact, db_session, test_engine, tmp_path, printer_factory, monkeypatch, sessions
):
    _unused, printer, queue, mqtt = await setup_source(db_session, tmp_path, printer_factory, monkeypatch)
    printer.swap_mode_enabled = True
    await db_session.commit()
    settings.archive_dir.mkdir(parents=True, exist_ok=True)
    item, source = await a_claimed_job(
        db_session, sessions, tmp_path, printer, queue, kind=kind, fact=fact, origin=origin
    )

    effects, _job = await run(db_session, monkeypatch, test_engine, item, source, printer, kind=kind, origin=origin)

    row = await db_session.get(PrintQueueItem, item.id, populate_existing=True)
    executions = [
        a
        for a in (await db_session.execute(select(PrintArchive))).scalars()
        if a.id != getattr(source, "id", None) or kind == "library"
    ]
    executions = [a for a in executions if a.status != "completed"]
    if fact is None:
        # D2: refused before any effect -- no archive, no macro, no config; a visible failure, not a silent strip.
        assert effects.macros == [] and effects.registered == []
        assert executions == []
        mqtt._client.publish.assert_not_called()
        assert row.status == "failed"
        assert row.error_message == routing_detail(sc.UNKNOWN_SOURCE_REASON)["message"]
        assert row.gate_acknowledged is True
        assert row.waiting_reason is None and row.waiting_reason_code is None
        assert json.loads(row.swap_macro_events) == EVENTS  # what was asked is kept for the operator
        return
    mqtt._client.publish.assert_called_once()
    (execution,) = executions
    pending = (execution.extra_data or {}).get("swap_macro_events_pending")
    if fact is True:
        # Baked: none of ours run, none are pending, none are registered for completion.
        assert effects.macros == []
        assert not pending
        assert all(not options.get("execute_swap_macros") for options in effects.registered)
    else:
        # Plain: exactly what was asked, under the printer's swap mode.
        assert effects.macros == ["swap_mode_start"]
        assert pending == ["swap_mode_change_table"]
        assert effects.registered and effects.registered[-1]["execute_swap_macros"] is True
        assert effects.registered[-1]["swap_macro_events"] == EVENTS


# --- the watchdog learns what the swap start really did (§8, T4.7) ---------------------------------------------------


@pytest.mark.parametrize(
    ("fact", "macro_ok", "watched", "effect"),
    [
        (True, True, False, "not_called"),  # muted by the backstop although the row asked for it
        (False, True, True, "fired"),
        (False, False, None, "possibly_fired"),  # sent, unconfirmed: the dispatch fails and nothing is watched
    ],
    ids=["baked-muted", "plain-fired", "plain-failed"],
)
async def test_watchdog_uses_actual_start_effect_not_requested_event(
    fact, macro_ok, watched, effect, db_session, test_engine, tmp_path, printer_factory, monkeypatch, sessions
):
    import backend.app.services.background_dispatch as bd

    _unused, printer, queue, mqtt = await setup_source(db_session, tmp_path, printer_factory, monkeypatch)
    printer.swap_mode_enabled = True
    await db_session.commit()
    settings.archive_dir.mkdir(parents=True, exist_ok=True)
    item, _source = await a_claimed_job(
        db_session, sessions, tmp_path, printer, queue, kind="library", fact=fact, origin="queue"
    )
    factory = async_sessionmaker(test_engine, expire_on_commit=False)
    service = dispatch_mocks(monkeypatch, factory)
    Effects(monkeypatch, service)
    if not macro_ok:
        monkeypatch.setattr(bd.printer_manager, "execute_macro_and_wait", AsyncMock(return_value=(False, "timeout")))
    outcomes: list[dict] = []
    real_run = service.run_from_queue_item

    async def recording_run(**kwargs):
        outcome = await real_run(**kwargs)
        outcomes.append(outcome)
        return outcome

    monkeypatch.setattr(service, "run_from_queue_item", recording_run)
    scheduler, spawned = scheduler_with_captured_dispatch(monkeypatch)

    assert await scheduler.check_queue() is True
    await drain(spawned)

    assert [outcome.get("swap_start_effect") for outcome in outcomes] == [effect]
    if watched is None:
        scheduler._watchdog_print_start.assert_not_called()
    else:
        scheduler._watchdog_print_start.assert_called_once()
        assert scheduler._watchdog_print_start.call_args.kwargs["swap_start_fired"] is watched


# --- what a D2 refusal leaves behind, and what the backstop never touches (§8, T4.5, T4.8) ---------------------------


async def a_second_queue(db, printer_factory, monkeypatch, mqtt):
    from backend.app.services.printer_manager import printer_manager

    other = await printer_factory(model="P1P")
    queue = PrinterQueue(id=other.id, printer_id=other.id, status="printing")
    db.add(queue)
    await db.commit()
    monkeypatch.setitem(printer_manager._clients, other.id, mqtt)
    monkeypatch.setitem(printer_manager._models, other.id, "P1P")
    return other, queue


async def test_unknown_request_is_visible_and_releases_only_own_claim(
    db_session, test_engine, tmp_path, printer_factory, monkeypatch, sessions
):
    _unused, printer, queue, mqtt = await setup_source(db_session, tmp_path, printer_factory, monkeypatch)
    printer.swap_mode_enabled = True
    await db_session.commit()
    settings.archive_dir.mkdir(parents=True, exist_ok=True)
    other_printer, other_queue = await a_second_queue(db_session, printer_factory, monkeypatch, mqtt)
    item, source = await a_claimed_job(
        db_session, sessions, tmp_path, printer, queue, kind="library", fact=None, origin="queue"
    )

    await run(db_session, monkeypatch, test_engine, item, source, printer, kind="library", origin="queue")

    row = await db_session.get(PrintQueueItem, item.id, populate_existing=True)
    assert row.status == "failed" and row.error_message
    claim = await db_session.get(PrinterQueue, queue.id, populate_existing=True)
    assert claim.status == "idle" and claim.current_item_id is None
    untouched = await db_session.get(PrinterQueue, other_queue.id, populate_existing=True)
    assert untouched.status == "printing"


async def test_unknown_failed_job_requires_retry_even_after_source_change(
    db_session, test_engine, tmp_path, printer_factory, monkeypatch, sessions
):
    from backend.app.models.library import LibraryFile

    _unused, printer, queue, mqtt = await setup_source(db_session, tmp_path, printer_factory, monkeypatch)
    printer.swap_mode_enabled = True
    await db_session.commit()
    settings.archive_dir.mkdir(parents=True, exist_ok=True)
    item, source = await a_claimed_job(
        db_session, sessions, tmp_path, printer, queue, kind="library", fact=None, origin="queue"
    )
    await run(db_session, monkeypatch, test_engine, item, source, printer, kind="library", origin="queue")
    assert (await db_session.get(PrintQueueItem, item.id, populate_existing=True)).status == "failed"

    # The library row now declares a known answer; the job's own snapshot does not move, and nothing re-arms it.
    library = await db_session.get(LibraryFile, source.id)
    library.swap_compatible = False
    await db_session.commit()
    scheduler, spawned = scheduler_with_captured_dispatch(monkeypatch)
    await scheduler.check_queue()
    await drain(spawned)

    assert (await db_session.get(PrintQueueItem, item.id, populate_existing=True)).status == "failed"
    mqtt._client.publish.assert_not_called()


async def test_policy_failure_does_not_block_following_item_or_previous_success_gate(
    db_session, test_engine, tmp_path, printer_factory, monkeypatch, sessions
):
    _unused, printer, queue, mqtt = await setup_source(db_session, tmp_path, printer_factory, monkeypatch)
    printer.swap_mode_enabled = True
    await db_session.commit()
    settings.archive_dir.mkdir(parents=True, exist_ok=True)
    refused, source = await a_claimed_job(
        db_session, sessions, tmp_path, printer, queue, kind="library", fact=None, origin="queue"
    )
    following, _ = await a_claimed_job(
        db_session, sessions, tmp_path / "next", printer, queue, kind="archive", fact=False, origin="queue"
    )
    following.position, following.require_previous_success = 2, True
    following.execute_swap_macros, following.swap_macro_events = False, None
    await db_session.commit()

    await run(db_session, monkeypatch, test_engine, refused, source, printer, kind="library", origin="queue")
    scheduler, spawned = scheduler_with_captured_dispatch(monkeypatch)
    await scheduler.check_queue()
    await drain(spawned)

    assert (await db_session.get(PrintQueueItem, refused.id, populate_existing=True)).gate_acknowledged is True
    # A refusal before dispatch is no physical failure: the next job's require_previous_success lets it start.
    assert (await db_session.get(PrintQueueItem, following.id, populate_existing=True)).status == "printing"


@pytest.mark.parametrize(
    ("fact", "swap_mode"),
    [(True, True), (False, True)],
    ids=["baked-swap-printer", "plain-swap-printer"],
)
async def test_runtime_policy_preserves_other_macros_and_order_options(
    fact, swap_mode, db_session, test_engine, tmp_path, printer_factory, monkeypatch, sessions
):
    """The swap decision touches our swap fields only: the operator's other macros stay as they were."""
    import backend.app.main as main_module

    _unused, printer, queue, mqtt = await setup_source(db_session, tmp_path, printer_factory, monkeypatch)
    printer.swap_mode_enabled = swap_mode
    await db_session.commit()
    settings.archive_dir.mkdir(parents=True, exist_ok=True)
    item, source = await a_claimed_job(
        db_session, sessions, tmp_path, printer, queue, kind="library", fact=fact, origin="queue"
    )
    item.selected_macro_ids = json.dumps([7, 9])
    await db_session.commit()
    factory = async_sessionmaker(test_engine, expire_on_commit=False)
    service = dispatch_mocks(monkeypatch, factory)
    Effects(monkeypatch, service)
    selections: list[dict] = []
    monkeypatch.setattr(
        main_module, "register_macro_selection", lambda printer_id, options: selections.append(dict(options))
    )
    scheduler, spawned = scheduler_with_captured_dispatch(monkeypatch)
    assert await scheduler.check_queue() is True
    await drain(spawned)

    assert selections, "the dispatch reached the macro registration"
    options = selections[-1]
    assert options["selected_macro_ids"] == [7, 9]  # our swap decision never touches the operator's other macros
    assert options["execute_swap_macros"] is (swap_mode and not fact)


async def test_the_backstop_changes_only_the_swap_fields(db_session, printer_factory):
    """Auto-eject, selected macros and print options pass through the decision untouched (on a printer without
    swap mode, where auto-eject may run at all -- the auto-eject/swap-mode conflict stays as it is)."""
    from backend.app.services.background_dispatch import BackgroundDispatchService, PrintDispatchJob
    from backend.app.services.queue_source_descriptor import QueueSourceDescriptor

    printer = await printer_factory(model="P1P")
    options = {
        "plate_id": PLATE,
        "execute_swap_macros": True,
        "swap_macro_events": list(EVENTS),
        "selected_macro_ids": [7, 9],
        "auto_eject": True,
        "auto_eject_settings": {"mode": "order"},
        "timelapse": True,
    }
    job = PrintDispatchJob(
        id=1,
        kind="print_library_file",
        source_id=1,
        source_name="x",
        printer_id=printer.id,
        printer_name="p",
        options=options,
    )
    job.source = QueueSourceDescriptor(
        path=settings.base_dir / "x.3mf",
        format="3mf",
        sha256="a" * 64,
        size_bytes=1,
        display_filename="x.3mf",
        swap_fact=sc.SourceFact(True),
    )
    before = dict(options)

    await BackgroundDispatchService._apply_swap_source_policy(db_session, job)

    assert job.options is options  # in place
    assert options["execute_swap_macros"] is False and options["swap_macro_events"] == []
    assert {k: v for k, v in options.items() if not k.startswith("execute_swap") and k != "swap_macro_events"} == {
        k: v for k, v in before.items() if not k.startswith("execute_swap") and k != "swap_macro_events"
    }
