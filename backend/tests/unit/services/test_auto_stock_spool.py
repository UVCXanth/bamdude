"""Synthetic inventory claims, physical insertion edges and real runout accounting."""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy import select

from backend.app.models.spool import Spool
from backend.app.models.spool_assignment import SpoolAssignment
from backend.app.services.auto_stock_spool import available_groups, claim_on_insertion
from backend.app.services.bambu_mqtt import BambuMQTTClient

GROUP = {
    "material": "PLA",
    "rgba": "FF0000FF",
    "brand": "Fixture",
    "subtype": "Basic",
    "filament_family_id": "GFA00",
    "label_weight": 1000,
}


def event(slot=0):
    return {
        "ams_id": 0,
        "tray_id": slot,
        "generation": 1,
        "sequence": 1,
        "observed_at": datetime.now(timezone.utc).replace(tzinfo=None),
    }


def manager(slot=0):
    tray = {
        "id": slot,
        "exists": True,
        "tray_type": "PLA",
        "tray_color": "FF0000FF",
        "tag_uid": "0000000000000000",
        "tray_uuid": "",
    }
    state = SimpleNamespace(
        connected=True, connection_generation=1, layer_num=140, raw_data={"ams": [{"id": 0, "tray": [tray]}]}
    )
    return SimpleNamespace(get_status=lambda _: state), state, tray


async def spool(db, **kw):
    row = Spool(**(GROUP | {"added_full": True, "weight_used": 0} | kw))
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


async def printer(factory, **kw):
    return await factory(ams_policies={"auto_stock_spool": {"enabled": True, "group": GROUP}}, **kw)


def client():
    c = BambuMQTTClient(ip_address="192.0.2.10", access_code="fixture", serial_number="Synthetic")
    c.state.connection_generation = 1
    return c


def units(ams=0, slot=0):
    return [{"id": ams, "tray": [{"id": slot, "tray_type": "PLA", "tray_color": "FF0000FF", "exists": True}]}]


def test_insertion_needs_a_fresh_empty_then_present_and_is_one_shot():
    c = client()
    assert c._stock_spool_insertions(units(), {"tray_exist_bits": "1"}) == []  # startup
    assert c._stock_spool_insertions(units(), {"tray_exist_bits": 0}) == []
    first = c._stock_spool_insertions(units(), {"tray_exist_bits": "1"})
    assert len(first) == 1 and first[0]["tray_id"] == 0
    assert c._stock_spool_insertions(units(), {"tray_exist_bits": "1"}) == []
    c._stock_spool_insertions(units(), {"tray_exist_bits": "0"})
    c.state.connection_generation = 2
    assert c._stock_spool_insertions(units(), {"tray_exist_bits": "1"}) == []  # reconnect


@pytest.mark.parametrize("bad", [None, "", "invalid", -1, True])
def test_missing_or_invalid_bits_do_not_use_cached_presence(bad):
    c = client()
    c._stock_spool_insertions(units(), {"tray_exist_bits": "0"})
    assert c._stock_spool_insertions(units(), {"tray_exist_bits": bad}) == []


@pytest.mark.parametrize("ams,slot,bits", [(0, 3, "8"), (128, 0, "10000"), (129, 0, "20000"), (6, 2, "4000000")])
def test_uses_existing_regular_ht_and_a2l_bit_layout(ams, slot, bits):
    c = client()
    c._stock_spool_insertions(units(ams, slot), {"tray_exist_bits": "0"})
    e = c._stock_spool_insertions(units(ams, slot), {"tray_exist_bits": bits})
    assert [(r["ams_id"], r["tray_id"]) for r in e] == [(ams, slot)]


def test_shutdown_and_unknown_external_slots_do_not_trigger():
    c = client()
    c._stock_spool_insertions(units(), {"tray_exist_bits": "1"})
    c._stock_spool_insertions(units(), {"tray_exist_bits": "0", "power_on_flag": False})
    assert c._stock_spool_insertions(units(), {"tray_exist_bits": "1"}) == []
    c._stock_spool_insertions(units(254), {"tray_exist_bits": "0"})
    assert c._stock_spool_insertions(units(254), {"tray_exist_bits": "ffffffff"}) == []


def test_command_ack_does_not_arm_insertion_but_status_does():
    c = client()
    fired = []
    c.on_spool_inserted = fired.append
    c._process_message({"print": {"command": "push_status", "ams": {"ams": units(), "tray_exist_bits": "0"}}})
    c._process_message({"print": {"command": "ams_filament_setting", "ams": {"ams": units(), "tray_exist_bits": "1"}}})
    assert fired == []
    c._process_message({"print": {"command": "push_status", "ams": {"ams": units(), "tray_exist_bits": "1"}}})
    assert len(fired) == 1


@pytest.mark.asyncio
async def test_claims_fifo_distinct_spools_for_two_slots(db_session, printer_factory):
    p = await printer(printer_factory)
    first, second = await spool(db_session), await spool(db_session)
    pm, state, _ = manager()
    state.raw_data["ams"][0]["tray"].append({"id": 1, "exists": True, "tray_type": "PLA"})
    assert (await claim_on_insertion(db_session, printer_id=p.id, event=event(), manager=pm))["spool_id"] == first.id
    assert (await claim_on_insertion(db_session, printer_id=p.id, event=event(1), manager=pm))["spool_id"] == second.id
    assert len((await db_session.execute(select(SpoolAssignment))).scalars().all()) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("added_full", [True, None])
async def test_full_unused_stock_without_historical_marker_is_claimed(db_session, printer_factory, added_full):
    p = await printer(printer_factory)
    s = await spool(db_session, added_full=added_full)
    assert await available_groups(db_session) == [GROUP | {"available_count": 1}]
    pm, _, _ = manager()
    result = await claim_on_insertion(db_session, printer_id=p.id, event=event(), manager=pm)
    assert result["spool_id"] == s.id
    # Compatibility is read-only; do not backfill or reinterpret stock history.
    await db_session.refresh(s)
    assert s.added_full is added_full


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "change",
    [
        {"material": "PETG"},
        {"filament_diameter": "2.85"},
        {"extra_colors": "FF0000,000000"},
        {"rgba": "000000FF"},
        {"filament_family_id": "GFA99"},
        {"brand": "Other"},
        {"subtype": "Matte"},
        {"label_weight": 750},
        {"weight_used": 1},
        {"added_full": False},
        {"added_full": None, "weight_used": 1, "weight_used_baseline": 1},
        {"added_full": None, "last_used": datetime(2026, 1, 1)},
        {"added_full": None, "tag_uid": "1234567890ABCDEF"},
        {"added_full": None, "archived_at": datetime(2026, 1, 1)},
        {"archived_at": datetime(2026, 1, 1)},
        {"last_used": datetime(2026, 1, 1)},
        {"tag_uid": "1234567890ABCDEF"},
        {"tray_uuid": "1234567890ABCDEF1234567890ABCDEF"},
    ],
)
async def test_ineligible_stock_is_never_substituted_or_created(db_session, printer_factory, change):
    p = await printer(printer_factory)
    await spool(db_session, **change)
    pm, _, _ = manager()
    assert (await claim_on_insertion(db_session, printer_id=p.id, event=event(), manager=pm))[
        "reason"
    ] == "no_full_stock"
    assert (await db_session.execute(select(SpoolAssignment))).scalars().all() == []


@pytest.mark.asyncio
async def test_assigned_spool_is_excluded_globally(db_session, printer_factory):
    p, other = await printer(printer_factory), await printer_factory()
    s = await spool(db_session)
    db_session.add(SpoolAssignment(printer_id=other.id, ams_id=0, tray_id=0, spool_id=s.id))
    await db_session.commit()
    assert await available_groups(db_session) == []
    pm, _, _ = manager()
    assert (await claim_on_insertion(db_session, printer_id=p.id, event=event(), manager=pm))[
        "reason"
    ] == "no_full_stock"


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["off", "corrupt", "stale", "reconnect", "disconnected", "missing", "rfid", "manual"])
async def test_guards_leave_stock_and_manual_assignments_intact(db_session, printer_factory, mode):
    p = await printer(printer_factory)
    s = await spool(db_session)
    pm, state, tray = manager()
    e = event()
    if mode in ("off", "corrupt"):
        p.ams_policies = {} if mode == "off" else {"auto_stock_spool": {"enabled": True}}
        await db_session.commit()
    elif mode == "stale":
        e["observed_at"] -= timedelta(seconds=31)
    elif mode == "reconnect":
        state.connection_generation = 2
    elif mode == "disconnected":
        state.connected = False
    elif mode == "missing":
        tray["exists"] = False
    elif mode == "rfid":
        tray["tag_uid"] = "1234567890ABCDEF"
    else:
        manual = await spool(db_session, weight_used=100)
        db_session.add(SpoolAssignment(printer_id=p.id, ams_id=0, tray_id=0, spool_id=manual.id))
        await db_session.commit()
    assert (await claim_on_insertion(db_session, printer_id=p.id, event=e, manager=pm))["reason"] != "assigned"
    assert s.weight_used == 0
    assert all(a.spool_id != s.id for a in (await db_session.execute(select(SpoolAssignment))).scalars())


@pytest.mark.asyncio
async def test_live_presence_is_checked_again_after_stock_selection(db_session, printer_factory):
    p = await printer(printer_factory)
    await spool(db_session)
    pm, state, _ = manager()
    empty = SimpleNamespace(**vars(state))
    empty.raw_data = {"ams": []}
    pm.get_status = MagicMock(side_effect=[state, empty])
    assert (await claim_on_insertion(db_session, printer_id=p.id, event=event(), manager=pm))[
        "reason"
    ] == "presence_unknown"
    assert (await db_session.execute(select(SpoolAssignment))).scalars().all() == []


@pytest.mark.asyncio
async def test_failed_journal_rolls_back_claim(db_session, printer_factory):
    p = await printer(printer_factory)
    await spool(db_session)
    pm, _, _ = manager()
    with (
        patch(
            "backend.app.services.print_usage_journal.note_assignment_change",
            AsyncMock(side_effect=RuntimeError("synthetic failure")),
        ),
        pytest.raises(RuntimeError),
    ):
        await claim_on_insertion(db_session, printer_id=p.id, event=event(), manager=pm)
    await db_session.rollback()
    assert (await db_session.execute(select(SpoolAssignment))).scalars().all() == []


@pytest.mark.asyncio
async def test_ambiguous_runout_cannot_replace_an_existing_assignment(db_session, printer_factory, tmp_path):
    from backend.app.models.print_usage_event import EVENT_RUNOUT, KIND_AMBIGUOUS
    from backend.tests.unit.services.test_usage_tracker_runout import _journal, _make_archive

    p = await printer(printer_factory)
    archive = await _make_archive(db_session, p, tmp_path)
    old = await spool(db_session, weight_used=700)
    await spool(db_session)
    db_session.add(SpoolAssignment(printer_id=p.id, ams_id=0, tray_id=0, spool_id=old.id, fingerprint_type="PLA"))
    await db_session.commit()
    await _journal(db_session, p, archive, [(EVENT_RUNOUT, KIND_AMBIGUOUS, 0, 140, old.id)])
    pm, _, _ = manager()
    assert (await claim_on_insertion(db_session, printer_id=p.id, event=event(), manager=pm))[
        "reason"
    ] == "assignment_priority"
    assert (await db_session.execute(select(SpoolAssignment.spool_id))).scalar_one() == old.id


@pytest.mark.asyncio
async def test_rfid_arriving_during_sql_wait_takes_priority(db_session, printer_factory):
    p = await printer(printer_factory)
    await spool(db_session)
    pm, state, _ = manager()
    tagged = SimpleNamespace(**vars(state))
    tagged.raw_data = {"ams": [{"id": 0, "tray": [{"id": 0, "exists": True, "tag_uid": "1234567890ABCDEF"}]}]}
    pm.get_status = MagicMock(side_effect=[state, tagged])
    assert (await claim_on_insertion(db_session, printer_id=p.id, event=event(), manager=pm))[
        "reason"
    ] == "rfid_priority"
    assert (await db_session.execute(select(SpoolAssignment))).scalars().all() == []


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["pause", "autoswitch"])
async def test_auto_refill_journal_splits_real_completion_at_runout(db_session, printer_factory, tmp_path, kind):
    from backend.app.models.print_usage_event import EVENT_RUNOUT, EVENT_SPOOL_LOADED, EVENT_START
    from backend.app.services.print_usage_journal import load_events
    from backend.app.services.usage_tracker import _active_sessions, on_print_complete
    from backend.tests.unit.services.test_usage_tracker_runout import (
        _journal,
        _make_archive,
        _patched_3mf,
        _pm,
        _session,
    )

    p = await printer(printer_factory)
    archive = await _make_archive(db_session, p, tmp_path)
    old, new = await spool(db_session, weight_used=700), await spool(db_session)
    db_session.add(SpoolAssignment(printer_id=p.id, ams_id=0, tray_id=0, spool_id=old.id, fingerprint_type="PLA"))
    await db_session.commit()
    await _journal(db_session, p, archive, [(EVENT_START, None, 0, 0, old.id), (EVENT_RUNOUT, kind, 0, 140, old.id)])
    pm, _, _ = manager()
    outcome = await claim_on_insertion(db_session, printer_id=p.id, event=event(), manager=pm)
    assert outcome == {"reason": "assigned", "spool_id": new.id}
    journal = await load_events(db_session, p.id, archive.id)
    assert [(r.spool_id, r.layer_num) for r in journal if r.event == EVENT_SPOOL_LOADED] == [(new.id, 140)]
    assert (await claim_on_insertion(db_session, printer_id=p.id, event=event(), manager=pm))[
        "reason"
    ] == "assignment_priority"
    _active_sessions[p.id] = _session(p.id)
    try:
        p1, p2 = _patched_3mf([{"slot_id": 1, "used_g": 300.0, "type": "PLA", "color": "#FF0000"}])
        with p1, p2:
            await on_print_complete(
                p.id, {"status": "completed"}, _pm(total_layers=200), db_session, archive_id=archive.id
            )
        await db_session.refresh(old)
        await db_session.refresh(new)
        assert old.weight_used == pytest.approx(1000)
        assert new.weight_used == pytest.approx(90)
    finally:
        _active_sessions.clear()
