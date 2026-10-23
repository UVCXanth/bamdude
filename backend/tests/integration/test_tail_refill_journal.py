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

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]

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


async def tail_fact(db, printer, event, layer, *, after_gap=False, subtask_id=None):
    async with journal.journal_lock(printer.id):
        return await journal.handle_feed_event(
            db, printer_id=printer.id, event=event, origin=TRAY, layer_num=layer, after_gap=after_gap,
            subtask_id=subtask_id,
        )  # fmt: skip


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
