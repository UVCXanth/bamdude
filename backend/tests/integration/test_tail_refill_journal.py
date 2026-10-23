"""The runout tail in the persisted usage journal (post-rebuild F, real database).

Spec: vault ``60-specs/ams-tail-refill-attribution-spec.md`` — F-R2 (``tail_start`` /
``feed_return``, one open episode, serialised check-and-append), F-R3 (an assignment during
the tail is identity only and never steals the old reel's id; the Spoolman assignment takes
the assignment lock, its remote I/O outside it), F-R4 (the seed of a joined print), F-R5
(the new reel's real runout still counts). Rows F01, F03, F04, F06, F07, F09, F10.
"""

import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy import select

import backend.app.models.printer_location  # noqa: F401 — resolves Printer's relationship
from backend.app.models.archive import PrintArchive
from backend.app.models.print_usage_event import (
    EVENT_FEED_RETURN,
    EVENT_RUNOUT,
    EVENT_SPOOL_LOADED,
    EVENT_START,
    EVENT_TAIL_START,
    KIND_GAP,
    KIND_PAUSE,
    PrintUsageEvent,
)
from backend.app.models.spool import Spool
from backend.app.models.spool_assignment import SpoolAssignment
from backend.app.services import print_usage_journal as journal
from backend.app.services.print_usage_journal import RunoutResult

pytestmark = pytest.mark.integration  # asyncio_mode = "auto" runs the coroutines

AMS, SLOT = 0, 2
TRAY = AMS * 4 + SLOT


async def a_print(db, printer_factory, *, subtask_id=None):
    printer = await printer_factory()
    archive = PrintArchive(
        printer_id=printer.id,
        filename="plate.gcode.3mf",
        print_name="plate",
        file_path="x/plate.gcode.3mf",
        file_size=1,
        status="printing",
        subtask_id=subtask_id,
    )
    db.add(archive)
    await db.commit()
    return SimpleNamespace(id=printer.id), SimpleNamespace(id=archive.id)


async def a_spool(db, name):
    spool = Spool(material="PLA", subtype="Basic", brand=name, color_name=name, rgba="FF0000FF", label_weight=1000)
    db.add(spool)
    await db.commit()
    return SimpleNamespace(id=spool.id)


async def bind(db, printer_id, spool_id):
    old = await db.scalar(
        select(SpoolAssignment).where(
            SpoolAssignment.printer_id == printer_id, SpoolAssignment.ams_id == AMS, SpoolAssignment.tray_id == SLOT
        )
    )
    if old is not None:
        await db.delete(old)
        await db.flush()
    db.add(
        SpoolAssignment(
            spool_id=spool_id,
            printer_id=printer_id,
            ams_id=AMS,
            tray_id=SLOT,
            created_at=datetime.now(timezone.utc).replace(tzinfo=None),
        )
    )
    await db.commit()


async def rows(db, printer_id, archive_id):
    db.expire_all()
    return [(e.event, e.layer_num, e.spool_id, e.kind) for e in await journal.load_events(db, printer_id, archive_id)]


@pytest.fixture
async def incident(db_session, printer_factory):
    """Printer 10's X2D: reel 309 feeding tray 2, the replacement 313 on the shelf."""
    printer, archive = await a_print(db_session, printer_factory)
    old, new = await a_spool(db_session, "old"), await a_spool(db_session, "new")
    await bind(db_session, printer.id, old.id)
    await journal.record_event(
        db_session, printer_id=printer.id, archive_id=archive.id, layer_num=0, event=EVENT_START,
        global_tray_id=TRAY, spool_id=old.id,
    )  # fmt: skip
    return printer, archive, old, new


async def tail_fact(db, printer, event, layer, *, after_gap=False, subtask_id=None, **observed):
    """One queued tail callback; ``observed`` carries what the real one carries (``generation``)."""
    async with journal.journal_lock(printer.id):
        return await journal.handle_feed_event(
            db, printer_id=printer.id, event=event, origin=TRAY, layer_num=layer, after_gap=after_gap,
            subtask_id=subtask_id, **observed,
        )  # fmt: skip


def a_client_on_print(generation, subtask_id=None):
    """The printer's MQTT client as the journal reads it: the print it is on now."""
    client = MagicMock()
    client.journal_generation.return_value = generation
    client.journal_held.return_value = False
    client.open_tail.return_value = None
    client.state.subtask_id = subtask_id
    return client


# ── F-R2 · the two tail facts ────────────────────────────────────────────────


async def test_the_tail_freezes_the_reel_running_out_and_the_return_the_reel_bound_then(db_session, incident):
    printer, archive, old, new = incident
    assert await tail_fact(db_session, printer, "tail_start", 40)
    assert not await tail_fact(db_session, printer, "tail_start", 41)  # one open episode
    await bind(db_session, printer.id, new.id)
    assert await tail_fact(db_session, printer, "feed_return", 42)
    assert not await tail_fact(db_session, printer, "feed_return", 43)  # nothing open to close

    assert await rows(db_session, printer.id, archive.id) == [
        (EVENT_START, 0, old.id, None),
        (EVENT_TAIL_START, 40, old.id, None),
        (EVENT_FEED_RETURN, 42, new.id, None),
    ]


async def test_a_return_seen_after_a_gap_is_marked(db_session, incident):
    printer, archive, old, new = incident
    await tail_fact(db_session, printer, "tail_start", 40)
    await tail_fact(db_session, printer, "feed_return", 50, after_gap=True)
    assert (await rows(db_session, printer.id, archive.id))[-1] == (EVENT_FEED_RETURN, 50, old.id, KIND_GAP)


async def test_a_fact_of_another_print_never_lands_in_this_one(db_session, printer_factory):
    """F-R2: the observation names subtask 7, the printing archive another one."""
    printer, archive = await a_print(db_session, printer_factory, subtask_id="8")
    assert not await tail_fact(db_session, printer, "tail_start", 40, subtask_id="7")
    assert await rows(db_session, printer.id, archive.id) == []


async def test_the_assignment_writer_rejects_the_tail_of_another_known_print(db_session, printer_factory):
    """F-R2: both tail writers ask one owner — the printing archive names another subtask
    than the client the open tail was read from, so the assignment journals nothing."""
    printer, archive = await a_print(db_session, printer_factory, subtask_id="new-print")
    client = a_client_on_print(3, subtask_id="old-print")
    client.open_tail.return_value = (TRAY, 40)
    with patch("backend.app.services.printer_manager.printer_manager") as pm:
        pm.get_client.return_value = client
        async with journal.journal_lock(printer.id):
            assert not await journal.ensure_tail_recorded(db_session, printer_id=printer.id, ams_id=AMS, tray_id=SLOT)
    assert await rows(db_session, printer.id, archive.id) == []


@pytest.mark.parametrize("bound", [True, False], ids=["next-print-bound", "nothing-bound-yet"])
async def test_a_late_callback_of_the_print_before_never_opens_an_episode_in_the_next(
    db_session, printer_factory, bound
):
    """F-R2: no device ids anywhere — the fact was observed in the client's previous print
    (journal generation 7); the client is on print 8 now, whose archive is printing, bound
    to it or not yet."""
    printer, archive = await a_print(db_session, printer_factory)
    if bound:
        journal.bind_tail_owner(printer.id, archive.id, 8)
    with patch("backend.app.services.printer_manager.printer_manager") as pm:
        pm.get_client.return_value = a_client_on_print(8)
        assert not await tail_fact(db_session, printer, "tail_start", 40, generation=7)
    assert await rows(db_session, printer.id, archive.id) == []


async def test_a_fact_of_the_new_print_never_lands_in_the_archive_of_the_last(db_session, printer_factory):
    """F-R2: print 8 started and its archive is not bound yet; the archive still printing
    belongs to print 7, so print 8's fact has no archive rather than the wrong one."""
    printer, previous = await a_print(db_session, printer_factory)
    journal.bind_tail_owner(printer.id, previous.id, 7)
    with patch("backend.app.services.printer_manager.printer_manager") as pm:
        pm.get_client.return_value = a_client_on_print(8)
        assert not await tail_fact(db_session, printer, "tail_start", 40, generation=8)
        client = a_client_on_print(8)
        client.open_tail.return_value = (TRAY, 40)
        pm.get_client.return_value = client
        async with journal.journal_lock(printer.id):
            assert not await journal.ensure_tail_recorded(db_session, printer_id=printer.id, ams_id=AMS, tray_id=SLOT)
    assert await rows(db_session, printer.id, previous.id) == []


async def test_the_feed_callback_carries_the_print_the_client_observed_it_in(printer_factory):
    """F-R2: the manager's wrapper reads the subtask and the journal generation on the MQTT
    thread, inside the observation — the queued handler may run after the next print began."""
    from backend.app.services.printer_manager import PrinterManager

    printer = await printer_factory()
    manager = PrinterManager()
    received = MagicMock()
    manager.set_feed_event_callback(received)
    with (
        patch("backend.app.services.printer_manager.BambuMQTTClient") as client_class,
        patch.object(manager, "_schedule_async"),
    ):
        client = client_class.return_value
        client.state.connected = True
        client.state.subtask_id = "577"
        client.journal_generation.return_value = 9
        await manager.connect_printer(printer)
        client_class.call_args.kwargs["on_feed_event"]("tail_start", TRAY, 40, False)
    received.assert_called_once_with(printer.id, "tail_start", TRAY, 40, False, "577", 9)


def test_the_run_lifecycle_binds_the_tail_owner_to_the_print_the_client_is_on(monkeypatch, tmp_path):
    """F-R2: the one choke point of own, external, adopted and recovered starts names the
    archive of the client's current journal generation."""
    from backend.app import main
    from backend.app.services.printer_manager import printer_manager

    class Manager:
        _uses_print_file_analysis_service = False

    monkeypatch.setattr(main, "printer_manager", Manager())
    monkeypatch.setattr(main.app_settings, "base_dir", tmp_path)
    monkeypatch.setattr(printer_manager, "get_client", lambda pid: a_client_on_print(5) if pid == 7 else None)

    main._bind_print_file_analysis_context(7, SimpleNamespace(id=42, file_path=None, plate_index=1, subtask_id=None))

    assert journal._tail_owners[7] == (5, 42)


async def test_the_current_tail_lands_in_the_archive_its_print_was_bound_to(db_session, printer_factory):
    """F-R2: the owner, not the newest printing row, decides — a stray newer printing row
    does not take print 8's tail."""
    printer, own = await a_print(db_session, printer_factory)
    stray = PrintArchive(
        printer_id=printer.id, filename="stray.3mf", print_name="stray", file_path="", file_size=1, status="printing"
    )
    db_session.add(stray)
    await db_session.flush()
    stray_id = stray.id
    await db_session.commit()
    journal.bind_tail_owner(printer.id, own.id, 8)
    with patch("backend.app.services.printer_manager.printer_manager") as pm:
        pm.get_client.return_value = a_client_on_print(8)
        assert await tail_fact(db_session, printer, "tail_start", 40, generation=8)
    assert [r[0] for r in await rows(db_session, printer.id, own.id)] == [EVENT_TAIL_START]
    assert await rows(db_session, printer.id, stray_id) == []


# ── F-R3 · runouts and assignments inside the tail ───────────────────────────


async def test_the_late_runout_of_the_tail_is_the_old_reels(db_session, incident):
    """F01: the runout pause arrives after 313 was bound — it is still 309's tube running dry."""
    printer, archive, old, new = incident
    await tail_fact(db_session, printer, "tail_start", 40)
    await bind(db_session, printer.id, new.id)
    async with journal.journal_lock(printer.id):
        result = await journal.record_runout(
            db_session, printer_id=printer.id, archive_id=archive.id, layer_num=42, kind=KIND_PAUSE,
            global_tray_id=TRAY, spool_id=new.id,
        )  # fmt: skip
    assert result is RunoutResult.NEW
    assert (await rows(db_session, printer.id, archive.id))[-1] == (EVENT_RUNOUT, 42, old.id, KIND_PAUSE)


async def test_after_the_return_a_runout_is_the_new_reels_and_opens_its_own_episode(db_session, incident):
    """F06: the new reel really ran out — its runout is neither folded nor renamed."""
    printer, archive, old, new = incident
    await tail_fact(db_session, printer, "tail_start", 40)
    async with journal.journal_lock(printer.id):
        await journal.record_runout(
            db_session, printer_id=printer.id, archive_id=archive.id, layer_num=42, kind=KIND_PAUSE,
            global_tray_id=TRAY, spool_id=old.id,
        )  # fmt: skip
    await bind(db_session, printer.id, new.id)
    await tail_fact(db_session, printer, "feed_return", 42)
    async with journal.journal_lock(printer.id):
        result = await journal.record_runout(
            db_session, printer_id=printer.id, archive_id=archive.id, layer_num=80, kind=KIND_PAUSE,
            global_tray_id=TRAY, spool_id=new.id,
        )  # fmt: skip
    assert result is RunoutResult.NEW
    assert (await rows(db_session, printer.id, archive.id))[-1] == (EVENT_RUNOUT, 80, new.id, KIND_PAUSE)


async def test_an_assignment_during_the_tail_is_an_identity_note_corrected_by_the_next(db_session, incident):
    """F02/F07: no runout yet — the assignment still names the reel now in the slot; a later
    one corrects that note instead of adding a second; re-linking the old reel is nothing."""
    printer, archive, old, new = incident
    await tail_fact(db_session, printer, "tail_start", 40)
    other = await a_spool(db_session, "other")

    async with journal.journal_lock(printer.id):
        await journal.note_assignment_change(
            db_session, printer_id=printer.id, ams_id=AMS, tray_id=SLOT, spool_id=old.id, layer_num=40
        )
        await journal.note_assignment_change(
            db_session, printer_id=printer.id, ams_id=AMS, tray_id=SLOT, spool_id=other.id, layer_num=41
        )
        await journal.note_assignment_change(
            db_session, printer_id=printer.id, ams_id=AMS, tray_id=SLOT, spool_id=new.id, layer_num=41
        )
    assert [r for r in await rows(db_session, printer.id, archive.id) if r[0] == EVENT_SPOOL_LOADED] == [
        (EVENT_SPOOL_LOADED, 41, new.id, None)
    ]


async def test_a_correction_without_a_tail_or_a_runout_journals_no_replacement(db_session, incident):
    """F03: an RFID match or a fixed wrong link is not a physical replacement."""
    printer, archive, old, new = incident
    async with journal.journal_lock(printer.id):
        await journal.note_assignment_change(
            db_session, printer_id=printer.id, ams_id=AMS, tray_id=SLOT, spool_id=new.id, layer_num=30
        )
    assert await rows(db_session, printer.id, archive.id) == [(EVENT_START, 0, old.id, None)]


async def test_a_tail_without_a_pause_offers_no_running_replacement_prompt(db_session, incident):
    """F10 / F-R6: no manual running-tail question — the window stays shut while RUNNING."""
    printer, archive, old, new = incident
    await tail_fact(db_session, printer, "tail_start", 40)
    state = MagicMock(state="RUNNING", layer_num=41)
    with patch("backend.app.services.printer_manager.printer_manager") as pm:
        pm.get_status.return_value = state
        assert await journal.manual_replacement_window(db_session, printer.id, ams_id=AMS, tray_id=SLOT) is None


# ── F09 · the assignment writes the open tail first, atomically ──────────────


def latched(printer_manager_mock, origin=TRAY, layer=40):
    client = MagicMock()
    client.open_tail.return_value = (origin, layer)
    printer_manager_mock.get_client.return_value = client


async def test_an_assignment_racing_the_queued_tail_callback_keeps_the_old_reel_on_the_tail(db_session, incident):
    """F09: tail observed → callback queued → the operator binds 313 first. The assignment
    records the tail with 309 before it rewrites the binding; the callback then finds the
    episode open and writes nothing."""
    printer, archive, old, new = incident
    with patch("backend.app.services.printer_manager.printer_manager") as pm:
        latched(pm)
        async with journal.journal_lock(printer.id):
            assert await journal.ensure_tail_recorded(db_session, printer_id=printer.id, ams_id=AMS, tray_id=SLOT)
            await bind(db_session, printer.id, new.id)  # commits the tail_start with the binding
        assert not await tail_fact(db_session, printer, "tail_start", 40)

    assert [r for r in await rows(db_session, printer.id, archive.id) if r[0] == EVENT_TAIL_START] == [
        (EVENT_TAIL_START, 40, old.id, None)
    ]


async def test_a_failed_binding_write_takes_its_tail_start_with_it(db_session, incident):
    """F09: the tail_start and the binding commit together or not at all."""
    printer, archive, old, new = incident
    with patch("backend.app.services.printer_manager.printer_manager") as pm:
        latched(pm)
        async with journal.journal_lock(printer.id):
            assert await journal.ensure_tail_recorded(db_session, printer_id=printer.id, ams_id=AMS, tray_id=SLOT)
            await db_session.rollback()
    assert await rows(db_session, printer.id, archive.id) == [(EVENT_START, 0, old.id, None)]


async def test_another_slot_or_no_tail_writes_nothing(db_session, incident):
    printer, archive, old, new = incident
    with patch("backend.app.services.printer_manager.printer_manager") as pm:
        latched(pm, origin=TRAY + 1)
        async with journal.journal_lock(printer.id):
            assert not await journal.ensure_tail_recorded(db_session, printer_id=printer.id, ams_id=AMS, tray_id=SLOT)
        pm.get_client.return_value.open_tail.return_value = None
        async with journal.journal_lock(printer.id):
            assert not await journal.ensure_tail_recorded(db_session, printer_id=printer.id, ams_id=AMS, tray_id=SLOT)


async def test_the_internal_assignment_route_records_the_tail_with_the_reel_going_out(
    async_client, db_session, incident
):
    """F09 through the real route: POST /inventory/assignments during an observed tail."""
    printer, archive, old, new = incident
    status = MagicMock(state="RUNNING", layer_num=41)
    status.raw_data = {"ams": {"ams": [{"id": AMS, "tray": [{"id": SLOT, "tray_type": "PLA"}]}]}}
    status.nozzles = [MagicMock(nozzle_diameter="0.4")]
    with patch("backend.app.services.printer_manager.printer_manager") as pm:
        latched(pm)
        pm.get_status.return_value = status
        pm.ensure_fresh_connection = AsyncMock(return_value=True)
        response = await async_client.post(
            "/api/v1/inventory/assignments",
            json={"spool_id": new.id, "printer_id": printer.id, "ams_id": AMS, "tray_id": SLOT},
        )
    assert response.status_code == 200, response.text
    assert [r for r in await rows(db_session, printer.id, archive.id) if r[0] != EVENT_START] == [
        (EVENT_TAIL_START, 40, old.id, None),
        (EVENT_SPOOL_LOADED, 41, new.id, None),
    ]


async def test_the_spoolman_assignment_waits_for_the_slot_lock_but_never_holds_it_over_the_network(
    async_client, db_session, printer_factory
):
    """F09 / F-R3: the remote spool lookup runs outside the assignment lock, the binding write
    inside it — a slow Spoolman blocks neither a runout callback nor another assignment."""
    from backend.app.main import _get_ams_assignment_lock
    from backend.app.models.spoolman_slot_assignment import SpoolmanSlotAssignment

    printer = await printer_factory()
    reached, release = asyncio.Event(), asyncio.Event()

    async def slow_get_spool(spool_id):
        reached.set()
        await release.wait()
        return {
            "id": spool_id,
            "remaining_weight": 800.0,
            "used_weight": 200.0,
            "registered": "2026-09-01T10:00:00",
            "filament": {"id": 5, "name": "PLA", "material": "PLA", "color_hex": "FF0000", "weight": 1000,
                         "spool_weight": 250, "vendor": {"id": 1, "name": "Bambu Lab"}},
            "extra": {},
        }  # fmt: skip

    spoolman = MagicMock(get_spool=slow_get_spool, get_spools=AsyncMock(return_value=[]))
    lock = _get_ams_assignment_lock(printer.id)
    with (
        patch("backend.app.api.routes.spoolman_inventory._get_client", new=AsyncMock(return_value=spoolman)),
        patch("backend.app.api.routes.spoolman_inventory.printer_manager") as route_pm,
        patch("backend.app.core.websocket.ws_manager.broadcast", new_callable=AsyncMock),
    ):
        route_pm.get_client.return_value = None
        request = asyncio.create_task(
            async_client.post(
                "/api/v1/spoolman/inventory/slot-assignments",
                json={"spoolman_spool_id": 12, "printer_id": printer.id, "ams_id": AMS, "tray_id": SLOT},
            )
        )
        await asyncio.wait_for(reached.wait(), 5)
        assert not lock.locked()  # the network wait holds no lock
        async with lock:
            release.set()
            # The route now either finishes (it took no lock) or queues on ours.
            for _ in range(500):
                if request.done() or lock._waiters:
                    break
                await asyncio.sleep(0.01)
            assert not request.done(), "the binding was written without the slot's assignment lock"
            db_session.expire_all()
            assert await db_session.scalar(select(SpoolmanSlotAssignment.spoolman_spool_id)) is None
        response = await asyncio.wait_for(request, 10)
    assert response.status_code == 200, response.text
    db_session.expire_all()
    assert await db_session.scalar(select(SpoolmanSlotAssignment.spoolman_spool_id)) == 12


# ── F04 · the seed of a joined print ────────────────────────────────────────


async def test_the_restart_seed_gives_the_joined_client_its_open_tail_back(db_session, incident):
    """F04: the journal holds an open tail; the restarted client's first report is the origin
    — the return happened while BamDude was down, so it is a gap return."""
    import logging

    from backend.app.main import _restore_usage_tracking_session
    from backend.app.services.bambu_mqtt import BambuMQTTClient

    printer, archive, old, new = incident
    await tail_fact(db_session, printer, "tail_start", 40)
    client = BambuMQTTClient(ip_address="1.2.3.4", serial_number="SEED1", access_code="1")
    client.on_feed_event = MagicMock()
    client.on_print_running_observed = MagicMock()
    client._previous_gcode_state = "RUNNING"
    client._previous_gcode_file = "plate.3mf"
    client.state.raw_data = {"ams": {"ams": [{"id": AMS, "tray": [{"id": SLOT, "tray_type": "PLA"}]}]}}
    client._process_message(
        {"print": {"ams": {"tray_now": str(TRAY)}, "gcode_state": "RUNNING", "gcode_file": "plate.3mf",
                   "layer_num": 50, "total_layer_num": 200, "subtask_name": "plate"}}
    )  # fmt: skip
    generation = client.on_print_running_observed.call_args.args[0]["_journal_generation"]

    with patch("backend.app.main.printer_manager") as pm:
        pm.get_client.return_value = client
        await _restore_usage_tracking_session(
            printer.id, client.state, db_session, logging.getLogger(__name__), generation=generation
        )

    assert client.on_feed_event.call_args_list[-1].args == ("feed_return", TRAY, 50, True)
    assert client.state.last_loaded_tray == TRAY


def a_restarted_client_seeing_the_origin(layer=50):
    """The restarted client's first status: a print running, the feed already back on the origin."""
    from backend.app.services.bambu_mqtt import BambuMQTTClient

    client = BambuMQTTClient(ip_address="1.2.3.4", serial_number="SEED2", access_code="1")
    client.on_feed_event = MagicMock()
    client.on_tray_change = MagicMock()
    client.on_print_running_observed = MagicMock()
    client._previous_gcode_state = "RUNNING"
    client._previous_gcode_file = "plate.3mf"
    client.state.raw_data = {"ams": {"ams": [{"id": AMS, "tray": [{"id": SLOT, "tray_type": "PLA"}]}]}}
    client._process_message(
        {"print": {"ams": {"tray_now": str(TRAY)}, "gcode_state": "RUNNING", "gcode_file": "plate.3mf",
                   "layer_num": layer, "total_layer_num": 200, "subtask_name": "plate"}}
    )  # fmt: skip
    return client


@pytest.fixture
def seed_retries(monkeypatch, test_engine):
    """The retries run at once, on this database, and the test awaits the one it spawned."""
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from backend.app import main

    spawned = []
    monkeypatch.setattr(main, "_USAGE_SEED_RETRY_DELAYS", (0, 0, 0))
    monkeypatch.setattr(main, "async_session", async_sessionmaker(test_engine, expire_on_commit=False))
    monkeypatch.setattr(main, "spawn_background_task", lambda coroutine, **_: spawned.append(coroutine))
    return spawned


def a_flaky_read(monkeypatch, failures):
    """The restore's first database read fails ``failures`` times (a locked database), then works."""
    from backend.app.services import usage_tracker

    real = usage_tracker.get_persisted_print_name
    calls = []

    async def read(db, printer_id):
        calls.append(printer_id)
        if len(calls) <= failures:
            raise RuntimeError("database is locked")
        return await real(db, printer_id)

    monkeypatch.setattr(usage_tracker, "get_persisted_print_name", read)
    return calls


async def test_a_failed_seed_is_retried_from_the_same_evidence(db_session, incident, monkeypatch, seed_retries):
    """M2: the restore's first read failed; the retry reads the journal and the held report
    again and seeds the print — the open tail closes at the observed return, nothing lost."""
    import logging

    from backend.app.main import _restore_usage_tracking_session

    printer, archive, old, new = incident
    await tail_fact(db_session, printer, "tail_start", 40)
    client = a_restarted_client_seeing_the_origin()
    a_flaky_read(monkeypatch, failures=1)

    with patch("backend.app.main.printer_manager") as pm:
        pm.get_client.return_value = client
        pm.get_status.return_value = client.state
        assert not await _restore_usage_tracking_session(
            printer.id, client.state, db_session, logging.getLogger(__name__), generation=client.journal_generation()
        )
        assert client.journal_held() and len(seed_retries) == 1
        await seed_retries.pop()

    assert not client.journal_held()
    assert client.on_feed_event.call_args_list[-1].args == ("feed_return", TRAY, 50, True)


async def test_a_seed_that_keeps_failing_ends_the_hold_with_the_feed_unknown(
    db_session, incident, monkeypatch, seed_retries
):
    """M2: every read fails — the hold ends visibly: the feed is unknown until the held
    report, which is journaled, instead of the completion reading the old chronology."""
    import logging

    from backend.app.main import _restore_usage_tracking_session
    from backend.app.utils.usage_attribution import UNKNOWN_FEED

    printer, archive, old, new = incident
    client = a_restarted_client_seeing_the_origin()
    calls = a_flaky_read(monkeypatch, failures=100)

    with patch("backend.app.main.printer_manager") as pm:
        pm.get_client.return_value = client
        pm.get_status.return_value = client.state
        await _restore_usage_tracking_session(
            printer.id, client.state, db_session, logging.getLogger(__name__), generation=client.journal_generation()
        )
        await seed_retries.pop()

    assert len(calls) == 4  # the first try and three retries, then no more
    assert not client.journal_held()
    assert client.state.tray_change_log == [(UNKNOWN_FEED, 0), (TRAY, 50)]
    assert [c.args for c in client.on_tray_change.call_args_list] == [(UNKNOWN_FEED, 0), (TRAY, 50)]


async def test_a_seed_retry_leaves_a_print_that_moved_on_alone(db_session, incident, monkeypatch, seed_retries):
    import logging

    from backend.app.main import _restore_usage_tracking_session

    printer, archive, old, new = incident
    client = a_restarted_client_seeing_the_origin()
    generation = client.journal_generation()
    calls = a_flaky_read(monkeypatch, failures=100)

    with patch("backend.app.main.printer_manager") as pm:
        pm.get_client.return_value = client
        pm.get_status.return_value = client.state
        await _restore_usage_tracking_session(
            printer.id, client.state, db_session, logging.getLogger(__name__), generation=generation
        )
        client._previous_gcode_state, client._was_running = "IDLE", False
        client._process_message({"print": {"gcode_state": "RUNNING", "gcode_file": "next.3mf"}})
        await seed_retries.pop()

    assert len(calls) == 1  # the retry of the old print read nothing
    assert client.journal_generation() != generation
    assert client.journal_held()  # the next print's own hold, not ended by the old print's retry


# ── F-R3 / F-R4 · an assignment while the journal waits for its seed ─────────


def slot_reads(client, tray, tray_type):
    client.state.raw_data = {
        "ams": {"ams": [{"id": tray // 4, "tray": [{"id": tray % 4, "tray_type": tray_type, "tray_color": ""}]}]},
        "vt_tray": [{"id": 254}, {"id": 255}],
    }


def a_joined_client_feeding_a_tail(tray=TRAY, layer=40):
    """A client that joined a running print whose first report is the external sentinel with
    ``tray`` empty — a runout tail, held with the rest until the restart seed."""
    from backend.app.services.bambu_mqtt import BambuMQTTClient

    client = BambuMQTTClient(ip_address="1.2.3.4", serial_number="HOLD1", access_code="1")
    client.on_feed_event = MagicMock()
    client.on_print_running_observed = MagicMock()
    client._previous_gcode_state = "RUNNING"
    client._previous_gcode_file = "plate.3mf"
    slot_reads(client, tray, "")
    client._process_message(
        {"print": {"ams": {"tray_now": "254"}, "gcode_state": "RUNNING", "gcode_file": "plate.3mf",
                   "layer_num": layer, "total_layer_num": 200}}
    )  # fmt: skip
    assert client.journal_held()
    return client


async def replay(db, printer_id, client):
    """main's queued feed callbacks, in the order the client emitted them, then forgotten."""
    for event, origin, layer, after_gap in [c.args for c in client.on_feed_event.call_args_list]:
        async with journal.journal_lock(printer_id):
            await journal.handle_feed_event(
                db, printer_id=printer_id, event=event, origin=origin, layer_num=layer, after_gap=after_gap,
                generation=client.journal_generation(),
            )  # fmt: skip
    client.on_feed_event.reset_mock()


async def seed_and_replay(db, printer_id, client, tray=TRAY):
    assert client.seed_usage_journal(
        client.journal_generation(), log=[(tray, 0)], last_loaded_tray=tray, tail_origin=None
    )
    await replay(db, printer_id, client)


async def frozen(db, printer_id, archive_id, event):
    db.expire_all()
    return [
        (e.layer_num, e.spool_id, e.spoolman_spool_id)
        for e in await journal.load_events(db, printer_id, archive_id)
        if e.event == event
    ]


async def test_an_assignment_while_the_journal_waits_for_its_seed_keeps_the_old_reel_on_the_tail(db_session, incident):
    """F-R3: the tail was seen before the seed, so the assignment could not record it; the
    replay freezes the reel going out at that assignment, never the replacement."""
    printer, archive, old, new = incident
    client = a_joined_client_feeding_a_tail()
    with patch("backend.app.services.printer_manager.printer_manager") as pm:
        pm.get_client.return_value = client
        async with journal.journal_lock(printer.id):
            assert not await journal.ensure_tail_recorded(db_session, printer_id=printer.id, ams_id=AMS, tray_id=SLOT)
            await bind(db_session, printer.id, new.id)
        await seed_and_replay(db_session, printer.id, client)

    assert await frozen(db_session, printer.id, archive.id, EVENT_TAIL_START) == [(40, old.id, None)]


async def test_after_such_an_assignment_the_late_runout_stays_old_and_the_return_splits_the_tray(db_session, incident):
    """F-R3 / F-R4: the tube's late runout is the old reel's, the feed back names the new
    reel, and the completion boundaries split the tray at the return."""
    from backend.app.services.usage_tracker import journal_boundaries_for_tray

    printer, archive, old, new = incident
    client = a_joined_client_feeding_a_tail()
    with patch("backend.app.services.printer_manager.printer_manager") as pm:
        pm.get_client.return_value = client
        async with journal.journal_lock(printer.id):
            await journal.ensure_tail_recorded(db_session, printer_id=printer.id, ams_id=AMS, tray_id=SLOT)
            await bind(db_session, printer.id, new.id)
        await seed_and_replay(db_session, printer.id, client)
        async with journal.journal_lock(printer.id):
            ids = await journal.freeze_spool_ids(db_session, printer.id, TRAY)
            await journal.record_runout(
                db_session, printer_id=printer.id, archive_id=archive.id, layer_num=42, kind=KIND_PAUSE,
                global_tray_id=TRAY, spool_id=ids[0], spoolman_spool_id=ids[1],
            )  # fmt: skip
        slot_reads(client, TRAY, "PLA")
        client._process_message({"print": {"ams": {"tray_now": str(TRAY)}, "layer_num": 45}})
        await replay(db_session, printer.id, client)

    assert await frozen(db_session, printer.id, archive.id, EVENT_RUNOUT) == [(42, old.id, None)]
    assert await frozen(db_session, printer.id, archive.id, EVENT_FEED_RETURN) == [(45, new.id, None)]
    events = await journal.load_events(db_session, printer.id, archive.id)
    assert [(layer, spool) for layer, spool, _ in journal_boundaries_for_tray(events, TRAY)] == [
        (0, old.id),
        (45, new.id),
    ]


async def test_an_unknown_reel_going_out_stays_unknown_never_the_new_one(db_session, printer_factory):
    """F-R3: nothing was bound to the slot when the assignment came — the tail's reel is not
    proven, and the replacement is not made up as its owner."""
    printer, archive = await a_print(db_session, printer_factory)
    new = await a_spool(db_session, "new")
    client = a_joined_client_feeding_a_tail()
    with patch("backend.app.services.printer_manager.printer_manager") as pm:
        pm.get_client.return_value = client
        async with journal.journal_lock(printer.id):
            await journal.ensure_tail_recorded(db_session, printer_id=printer.id, ams_id=AMS, tray_id=SLOT)
            await bind(db_session, printer.id, new.id)
        await seed_and_replay(db_session, printer.id, client)

    assert await frozen(db_session, printer.id, archive.id, EVENT_TAIL_START) == [(40, None, None)]


async def test_a_second_tail_held_after_its_return_belongs_to_the_reel_that_came_back(db_session, incident):
    """F07: two tails held through one seed — the outgoing reel the assignment caught is the
    first tail's only; the reel the feed came back with owns the second."""
    printer, archive, old, new = incident
    client = a_joined_client_feeding_a_tail()
    slot_reads(client, TRAY, "PLA")
    client._process_message({"print": {"ams": {"tray_now": str(TRAY)}, "layer_num": 45}})
    slot_reads(client, TRAY, "")
    client._process_message({"print": {"ams": {"tray_now": "254"}, "layer_num": 60}})
    with patch("backend.app.services.printer_manager.printer_manager") as pm:
        pm.get_client.return_value = client
        async with journal.journal_lock(printer.id):
            await journal.ensure_tail_recorded(db_session, printer_id=printer.id, ams_id=AMS, tray_id=SLOT)
            await bind(db_session, printer.id, new.id)
        await seed_and_replay(db_session, printer.id, client)

    assert await frozen(db_session, printer.id, archive.id, EVENT_TAIL_START) == [
        (40, old.id, None),
        (60, new.id, None),
    ]


async def test_a_held_tail_the_journal_lost_leaves_the_reel_going_out_to_no_later_tail(db_session, incident):
    """The first replayed tail's handler failed (main logs and drops it); the feed came back
    and ran out again — that later tail is the returned reel's, not the one caught going out."""
    printer, archive, old, new = incident
    client = a_joined_client_feeding_a_tail()
    slot_reads(client, TRAY, "PLA")
    client._process_message({"print": {"ams": {"tray_now": str(TRAY)}, "layer_num": 45}})
    slot_reads(client, TRAY, "")
    client._process_message({"print": {"ams": {"tray_now": "254"}, "layer_num": 60}})
    with patch("backend.app.services.printer_manager.printer_manager") as pm:
        pm.get_client.return_value = client
        async with journal.journal_lock(printer.id):
            await journal.ensure_tail_recorded(db_session, printer_id=printer.id, ams_id=AMS, tray_id=SLOT)
            await bind(db_session, printer.id, new.id)
        assert client.seed_usage_journal(
            client.journal_generation(), log=[(TRAY, 0)], last_loaded_tray=TRAY, tail_origin=None
        )
        lost, *rest = [c.args for c in client.on_feed_event.call_args_list]
        assert lost[:3] == ("tail_start", TRAY, 40)
        client.on_feed_event.call_args_list[:] = [c for c in client.on_feed_event.call_args_list if c.args != lost]
        await replay(db_session, printer.id, client)

    assert rest[0][0] == "feed_return"
    assert await frozen(db_session, printer.id, archive.id, EVENT_TAIL_START) == [(60, new.id, None)]


async def test_a_seed_that_comes_late_journals_every_held_transition_at_its_own_layer(db_session, incident):
    """M2: a long wait for the seed — three tails and their returns held while the print ran
    on; the late seed journals them in order, each at the layer its report carried, and the
    completion boundaries split the tray at the returns."""
    from backend.app.services.usage_tracker import journal_boundaries_for_tray

    printer, archive, old, new = incident
    client = a_joined_client_feeding_a_tail(layer=40)
    for back, out in ((45, 60), (66, 80), (85, 99)):
        slot_reads(client, TRAY, "PLA")
        client._process_message({"print": {"ams": {"tray_now": str(TRAY)}, "layer_num": back}})
        slot_reads(client, TRAY, "")
        client._process_message({"print": {"ams": {"tray_now": "254"}, "layer_num": out}})
    client.state.layer_num = 120  # the seed lands long after
    with patch("backend.app.services.printer_manager.printer_manager") as pm:
        pm.get_client.return_value = client
        await seed_and_replay(db_session, printer.id, client)

    tails = await frozen(db_session, printer.id, archive.id, EVENT_TAIL_START)
    returns = await frozen(db_session, printer.id, archive.id, EVENT_FEED_RETURN)
    assert [t[0] for t in tails] == [40, 60, 80, 99]
    assert [r[0] for r in returns] == [45, 66, 85]
    events = await journal.load_events(db_session, printer.id, archive.id)
    assert [layer for layer, _spool, _ in journal_boundaries_for_tray(events, TRAY)] == [0, 45, 66, 85]


async def test_an_assignment_held_without_a_tail_leaves_a_later_live_tail_to_the_binding(db_session, incident):
    """F03: the slot was only re-linked while the journal waited; the reel that runs out
    after the seed is the one bound then."""
    printer, archive, old, new = incident
    from backend.app.services.bambu_mqtt import BambuMQTTClient

    client = BambuMQTTClient(ip_address="1.2.3.4", serial_number="HOLD2", access_code="1")
    client.on_feed_event = MagicMock()
    client.on_print_running_observed = MagicMock()
    client._previous_gcode_state = "RUNNING"
    client._previous_gcode_file = "plate.3mf"
    slot_reads(client, TRAY, "PLA")
    client._process_message(
        {"print": {"ams": {"tray_now": str(TRAY)}, "gcode_state": "RUNNING", "gcode_file": "plate.3mf",
                   "layer_num": 40, "total_layer_num": 200}}
    )  # fmt: skip
    with patch("backend.app.services.printer_manager.printer_manager") as pm:
        pm.get_client.return_value = client
        async with journal.journal_lock(printer.id):
            await journal.ensure_tail_recorded(db_session, printer_id=printer.id, ams_id=AMS, tray_id=SLOT)
            await bind(db_session, printer.id, new.id)
        await seed_and_replay(db_session, printer.id, client)
        slot_reads(client, TRAY, "")
        client._process_message({"print": {"ams": {"tray_now": "254"}, "layer_num": 80}})
        await replay(db_session, printer.id, client)

    assert await frozen(db_session, printer.id, archive.id, EVENT_TAIL_START) == [(80, new.id, None)]


async def test_the_internal_assignment_route_during_the_seed_wait_keeps_the_old_reel_on_the_tail(
    async_client, db_session, incident
):
    """F09 through the real route (manual inventory) while the journal waits for its seed."""
    printer, archive, old, new = incident
    client = a_joined_client_feeding_a_tail()
    status = MagicMock(state="RUNNING", layer_num=40)
    status.raw_data = {"ams": {"ams": [{"id": AMS, "tray": [{"id": SLOT, "tray_type": "PLA"}]}]}}
    status.nozzles = [MagicMock(nozzle_diameter="0.4")]
    with patch("backend.app.services.printer_manager.printer_manager") as pm:
        pm.get_client.return_value = client
        pm.get_status.return_value = status
        pm.ensure_fresh_connection = AsyncMock(return_value=True)
        response = await async_client.post(
            "/api/v1/inventory/assignments",
            json={"spool_id": new.id, "printer_id": printer.id, "ams_id": AMS, "tray_id": SLOT},
        )
        assert response.status_code == 200, response.text
        await seed_and_replay(db_session, printer.id, client)

    assert await frozen(db_session, printer.id, archive.id, EVENT_TAIL_START) == [(40, old.id, None)]


async def test_the_spoolman_assignment_during_the_seed_wait_keeps_the_old_reel_on_the_tail(
    async_client, db_session, printer_factory
):
    """F09 through the Spoolman route while the journal waits for its seed."""
    from backend.app.models.spoolman_slot_assignment import SpoolmanSlotAssignment

    printer, archive = await a_print(db_session, printer_factory)
    db_session.add(SpoolmanSlotAssignment(printer_id=printer.id, ams_id=AMS, tray_id=SLOT, spoolman_spool_id=11))
    await db_session.commit()
    spoolman = MagicMock(
        get_spool=AsyncMock(
            return_value={
                "id": 12, "remaining_weight": 800.0, "used_weight": 200.0, "registered": "2026-09-01T10:00:00",
                "filament": {"id": 5, "name": "PLA", "material": "PLA", "color_hex": "FF0000", "weight": 1000,
                             "spool_weight": 250, "vendor": {"id": 1, "name": "Bambu Lab"}},
                "extra": {},
            }
        ),
        get_spools=AsyncMock(return_value=[]),
    )  # fmt: skip
    client = a_joined_client_feeding_a_tail()
    with (
        patch("backend.app.api.routes.spoolman_inventory._get_client", new=AsyncMock(return_value=spoolman)),
        patch("backend.app.api.routes.spoolman_inventory.printer_manager") as route_pm,
        patch("backend.app.services.printer_manager.printer_manager") as pm,
        patch("backend.app.core.websocket.ws_manager.broadcast", new_callable=AsyncMock),
    ):
        route_pm.get_client.return_value = None
        pm.get_client.return_value = client
        response = await async_client.post(
            "/api/v1/spoolman/inventory/slot-assignments",
            json={"spoolman_spool_id": 12, "printer_id": printer.id, "ams_id": AMS, "tray_id": SLOT},
        )
        assert response.status_code == 200, response.text
        await seed_and_replay(db_session, printer.id, client)

    assert await frozen(db_session, printer.id, archive.id, EVENT_TAIL_START) == [(40, None, 11)]


async def test_the_rfid_assignment_during_the_seed_wait_keeps_the_old_reel_on_the_tail(db_session, incident):
    """F09 through the RFID writer while the journal waits for its seed."""
    from backend.app.services.spool_tag_matcher import auto_assign_spool, create_spool_from_tray
    from backend.tests.unit.services.test_spool_tag_matcher import SAMPLE_TRAY

    printer, archive, old, _new = incident
    tagged = await create_spool_from_tray(db_session, SAMPLE_TRAY)
    client = a_joined_client_feeding_a_tail()
    writer_pm = MagicMock()
    writer_pm.get_status.return_value = None
    writer_pm.get_client.return_value = None
    writer_pm.ensure_fresh_connection = AsyncMock(return_value=True)
    writer_pm.ensure_fresh_connection_for_printer = AsyncMock(return_value=True)
    with patch("backend.app.services.printer_manager.printer_manager") as pm:
        pm.get_client.return_value = client
        assignment = await auto_assign_spool(printer.id, AMS, SLOT, tagged, writer_pm, db_session)
        assert assignment.spool_id == tagged.id
        await seed_and_replay(db_session, printer.id, client)

    assert await frozen(db_session, printer.id, archive.id, EVENT_TAIL_START) == [(40, old.id, None)]


async def test_a_stock_insertion_during_the_seed_wait_keeps_the_old_reel_on_the_tail(
    db_session, printer_factory, tmp_path
):
    """F09 through the stock-insertion writer while the journal waits for its seed: the pause
    runout of the old reel was journaled before the restart, the first report after it is
    the tail."""
    from backend.app.services.auto_stock_spool import claim_on_insertion
    from backend.tests.unit.services.test_auto_stock_spool import event, manager, printer as stock_printer, spool
    from backend.tests.unit.services.test_usage_tracker_runout import _journal, _make_archive

    p = await stock_printer(printer_factory)
    archive = await _make_archive(db_session, p, tmp_path)
    old = await spool(db_session, weight_used=700)
    await spool(db_session)
    db_session.add(SpoolAssignment(printer_id=p.id, ams_id=0, tray_id=0, spool_id=old.id, fingerprint_type="PLA"))
    await db_session.commit()
    p_id, archive_id, old_id = p.id, archive.id, old.id
    await _journal(db_session, p, archive, [(EVENT_RUNOUT, KIND_PAUSE, 0, 140, old.id)])
    client = a_joined_client_feeding_a_tail(tray=0, layer=141)
    pm, _, _ = manager()
    with patch("backend.app.services.printer_manager.printer_manager") as live:
        live.get_client.return_value = client
        outcome = await claim_on_insertion(db_session, printer_id=p_id, event=event(), manager=pm)
        assert outcome["reason"] == "assigned"
        await seed_and_replay(db_session, p_id, client, tray=0)

    assert await frozen(db_session, p_id, archive_id, EVENT_TAIL_START) == [(141, old_id, None)]


async def test_a_stock_insertion_during_the_tail_records_the_tail_with_the_reel_going_out(
    db_session, printer_factory, tmp_path
):
    """F09: the insertion writer is an assignment writer too — the tail first, then the binding."""
    from backend.app.models.print_usage_event import KIND_PAUSE as PAUSE
    from backend.app.services.auto_stock_spool import claim_on_insertion
    from backend.tests.unit.services.test_auto_stock_spool import event, manager, printer as stock_printer, spool
    from backend.tests.unit.services.test_usage_tracker_runout import _journal, _make_archive

    p = await stock_printer(printer_factory)
    archive = await _make_archive(db_session, p, tmp_path)
    old = await spool(db_session, weight_used=700)
    await spool(db_session)
    db_session.add(SpoolAssignment(printer_id=p.id, ams_id=0, tray_id=0, spool_id=old.id, fingerprint_type="PLA"))
    await db_session.commit()
    p_id, archive_id, old_id = p.id, archive.id, old.id
    await _journal(db_session, p, archive, [(EVENT_RUNOUT, PAUSE, 0, 140, old.id)])
    pm, _, _ = manager()
    with patch("backend.app.services.printer_manager.printer_manager") as live:
        latched(live, origin=0, layer=138)
        outcome = await claim_on_insertion(db_session, printer_id=p_id, event=event(), manager=pm)
    assert outcome["reason"] == "assigned"
    assert [r for r in await rows(db_session, p_id, archive_id) if r[0] == EVENT_TAIL_START] == [
        (EVENT_TAIL_START, 138, old_id, None)
    ]


async def test_the_x2d_incident_replayed_end_to_end(db_session, incident):
    """F01: the real MQTT parser feeds the real callbacks, journal, assignment and projection —
    empty origin → tail 254 → a reel goes in (the slot reads loaded) → the operator binds 313 →
    the late pause-runout of 309's tube → the feed back on tray 2. No phantom tray change; the
    old reel to the return, the new one after it."""
    from backend.app.models.print_usage_event import EVENT_TRAY_CHANGE
    from backend.app.services.bambu_mqtt import BambuMQTTClient
    from backend.app.services.usage_tracker import journal_boundaries_for_tray, record_tray_change_event

    printer, archive, old, new = incident
    client = BambuMQTTClient(ip_address="1.2.3.4", serial_number="X2D-1006", access_code="1")
    client._was_running, client._completion_triggered = True, False
    client.state.state, client.state.layer_num, client.state.total_layers = "RUNNING", 40, 200
    client.state.tray_now = client.state.last_loaded_tray = TRAY
    client.state.tray_change_log = [(TRAY, 0)]

    def slot(tray_type):
        client.state.raw_data = {
            "ams": {"ams": [{"id": AMS, "tray": [{"id": SLOT, "tray_type": tray_type, "tray_color": ""}]}]},
            "vt_tray": [{"id": 254}, {"id": 255}],
        }

    queued = []
    client.on_feed_event = lambda *args: queued.append(("feed", args))
    client.on_usage_event = lambda *args: queued.append(("usage", args))
    client.on_tray_change = lambda *args: queued.append(("tray", args))

    async def drain():
        """What main.py's callbacks do, in the order the client queued them."""
        for kind, args in queued:
            async with journal.journal_lock(printer.id):
                if kind == "feed":
                    event, origin, layer, after_gap = args
                    await journal.handle_feed_event(
                        db_session, printer_id=printer.id, event=event, origin=origin, layer_num=layer,
                        after_gap=after_gap,
                    )  # fmt: skip
                elif kind == "tray":
                    await record_tray_change_event(db_session, printer.id, *args)
                else:
                    event, kind_, tray, layer = args
                    ids = await journal.freeze_spool_ids(db_session, printer.id, tray)
                    await journal.record_runout(
                        db_session, printer_id=printer.id, archive_id=archive.id, layer_num=layer, kind=kind_,
                        global_tray_id=tray, spool_id=ids[0], spoolman_spool_id=ids[1],
                    )  # fmt: skip
        queued.clear()

    def tray_now(tray, layer):
        client.state.layer_num = layer
        client._process_message({"print": {"ams": {"tray_now": str(tray)}}})

    slot("")
    tray_now(254, 40)
    await drain()
    slot("PLA")  # the new reel is in the slot (or our ams_filament_setting echoed)
    tray_now(254, 41)
    await drain()
    with patch("backend.app.services.printer_manager.printer_manager") as pm:
        pm.get_client.return_value = client
        async with journal.journal_lock(printer.id):
            await journal.ensure_tail_recorded(db_session, printer_id=printer.id, ams_id=AMS, tray_id=SLOT)
            await bind(db_session, printer.id, new.id)
            await journal.note_assignment_change(
                db_session, printer_id=printer.id, ams_id=AMS, tray_id=SLOT, spool_id=new.id, layer_num=41
            )
    client.state.layer_num = 42
    client._process_message({"print": {"hms": [{"attr": 0x07002200, "code": 0x00020001}]}})
    await drain()
    tray_now(TRAY, 42)
    await drain()

    events = await journal.load_events(db_session, printer.id, archive.id)
    assert not [e for e in events if e.event == EVENT_TRAY_CHANGE]
    assert [(e.event, e.spool_id) for e in events if e.event in (EVENT_RUNOUT, EVENT_TAIL_START)] == [
        (EVENT_TAIL_START, old.id),
        (EVENT_RUNOUT, old.id),
    ]
    assert [(layer, spool) for layer, spool, _ in journal_boundaries_for_tray(events, TRAY)] == [
        (0, old.id),
        (42, new.id),
    ]
