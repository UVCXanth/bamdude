"""Captured sliced-model intent survives real single/batch routing edits."""

from contextlib import asynccontextmanager
from copy import deepcopy

import pytest
from sqlalchemy import select

from backend.app.models.auto_queue import AutoQueueItem
from backend.app.models.print_options_preference import PrintOptionsPreference
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.settings import Settings
from backend.app.services.auto_queue_scheduler import AutoQueueScheduler
from backend.app.services.filament_intake import item_descriptor, read_item_requirements
from backend.app.services.order_print_options import inherited_options
from backend.app.services.printer_manager import printer_manager
from backend.tests.integration.test_auto_queue_scheduler import _patch_printer_manager, rebalance_farm
from backend.tests.integration.test_filament_routing_dispatch import setup_source
from backend.tests.integration.test_queue_rebalance_api import _move, _pending

pytestmark = pytest.mark.integration


@pytest.fixture
async def routing_order(committing_client, db_session, tmp_path, printer_factory, monkeypatch):
    source, printer, _, _ = await setup_source(db_session, tmp_path, printer_factory, monkeypatch)
    printer.model = "P1S"
    monkeypatch.setitem(printer_manager._models, printer.id, "P1S")
    db_session.add(Settings(key="auto_queue_compatible_models", value="true"))
    await db_session.commit()
    response = await committing_client.post("/api/v1/auto-queue/", json={"library_file_id": source.id, "quantity": 2})
    assert response.status_code == 200, response.text
    rows = (await db_session.execute(select(AutoQueueItem).order_by(AutoQueueItem.id))).scalars().all()
    assert len(rows) == 2 and rows[0].batch_id == rows[1].batch_id
    choices = (await inherited_options(db_session, None, "P1P")).model_dump()
    choices.update(bed_levelling="off", timelapse=True, gcode_injection=True, preheat_override="off")
    opposing = {
        **choices,
        "bed_levelling": "on",
        "timelapse": False,
        "gcode_injection": False,
        "preheat_override": "on",
    }
    for row in rows:
        row.order_print_options = {"P1P": deepcopy(choices), "P1S": deepcopy(opposing)}
    db_session.add(
        PrintOptionsPreference(
            user_id=rows[0].created_by_id,
            printer_model="P1S",
            options={"print_options": opposing, "swap_macros": {"execute": False, "events": []}},
        )
    )
    await db_session.commit()

    @asynccontextmanager
    async def session():
        yield db_session

    monkeypatch.setattr("backend.app.services.auto_queue_scheduler.async_session", session)
    return rows, source, choices, opposing


async def edit(client, rows, door, payload):
    url = f"/api/v1/auto-queue/{rows[0].id}" if door == "single" else f"/api/v1/auto-queue/batch/{rows[0].batch_id}"
    response = await client.put(url, json=payload)
    assert response.status_code == 200, response.text
    return rows[:1] if door == "single" else rows


@pytest.mark.parametrize("door", ["single", "batch"])
@pytest.mark.parametrize("destination_entry", [False, True])
async def test_target_edit_keeps_captured_model_choices(
    committing_client, db_session, routing_order, door, destination_entry
):
    rows, source, choices, opposing = routing_order
    if not destination_entry:
        for row in rows:
            row.order_print_options = {"P1P": deepcopy(choices)}
        await db_session.commit()
    snapshots = {row.id: deepcopy(row.order_print_options) for row in rows}
    sources = {row.id: (row.queue_source_id, deepcopy(row.source_snapshot)) for row in rows}
    # The original and its metadata cannot overrule the already-captured bytes.
    source.filename = "P1S.gcode.3mf"
    source.file_metadata = {"sliced_for_model": "P1S"}
    await db_session.commit()
    from pathlib import Path

    Path(source.file_path).unlink()
    changed = await edit(committing_client, rows, door, {"target_model": "C12"})
    for row in rows:
        await db_session.refresh(row)
        assert (row.queue_source_id, row.source_snapshot) == sources[row.id]
        assert row.order_print_options == snapshots[row.id]
        assert row.target_model == ("P1S" if row in changed else "P1P")
    await AutoQueueScheduler().tick()
    placed = (await db_session.execute(select(PrintQueueItem))).scalar_one()
    assert placed.source_auto_item_id == rows[0].id
    assert placed.bed_levelling_mode == "off" and not placed.bed_levelling
    assert placed.timelapse and placed.gcode_injection and placed.preheat_override == "off"


@pytest.mark.parametrize("door", ["single", "batch"])
@pytest.mark.parametrize("combined_edit", [False, True])
async def test_job_toggle_edit_updates_source_entry_not_routing_entry(
    committing_client, db_session, routing_order, door, combined_edit
):
    rows, _, choices, opposing = routing_order
    if not combined_edit:
        await edit(committing_client, rows, door, {"target_model": "P1S"})
    payload = {"bed_levelling": "on", "timelapse": False}
    if combined_edit:
        payload["target_model"] = "P1S"
    changed = await edit(committing_client, rows, door, payload)
    for row in rows:
        await db_session.refresh(row)
        expected = {**choices, "bed_levelling": "on", "timelapse": False} if row in changed else choices
        assert row.order_print_options == {"P1P": expected, "P1S": opposing}
    await AutoQueueScheduler().tick()
    placed = (await db_session.execute(select(PrintQueueItem))).scalar_one()
    assert placed.bed_levelling_mode == "on" and not placed.timelapse
    assert placed.gcode_injection and placed.preheat_override == "off"


async def test_removed_routing_restriction_does_not_remove_order_intent(committing_client, db_session, routing_order):
    rows, _, choices, opposing = routing_order
    await edit(committing_client, rows, "single", {"target_model": None})
    await db_session.refresh(rows[0])
    assert rows[0].target_model is None
    assert rows[0].order_print_options == {"P1P": choices, "P1S": opposing}
    await AutoQueueScheduler().tick()
    placed = (await db_session.execute(select(PrintQueueItem))).scalar_one()
    assert placed.bed_levelling_mode == "off" and placed.timelapse


@pytest.mark.parametrize("door", ["single", "batch"])
async def test_unreadable_capture_refuses_snapshot_edit_without_partial_changes(
    committing_client, db_session, routing_order, door
):
    rows, _, _, _ = routing_order
    before = {row.id: deepcopy(row.order_print_options) for row in rows}
    descriptor = await item_descriptor(db_session, rows[0])
    descriptor.path.unlink()
    url = f"/api/v1/auto-queue/{rows[0].id}" if door == "single" else f"/api/v1/auto-queue/batch/{rows[0].batch_id}"
    response = await committing_client.put(url, json={"bed_levelling": "on", "target_model": "P1S"})
    assert response.status_code == 422, response.text
    for row in rows:
        await db_session.refresh(row)
        assert row.target_model == "P1P" and row.order_print_options == before[row.id]


@pytest.mark.parametrize("door", ["single", "batch"])
async def test_unrelated_job_edit_does_not_require_readable_capture(committing_client, db_session, routing_order, door):
    rows, _, _, _ = routing_order
    before = {row.id: deepcopy(row.order_print_options) for row in rows}
    descriptor = await item_descriptor(db_session, rows[0])
    descriptor.path.unlink()
    changed = await edit(committing_client, rows, door, {"manual_start": True})
    for row in rows:
        await db_session.refresh(row)
        assert row.manual_start == (row in changed)
        assert row.order_print_options == before[row.id]


async def test_actual_rebalance_selects_new_captured_source_entry_then_promotes(
    committing_client, db_session, printer_factory, tmp_path, monkeypatch
):
    farm = await rebalance_farm(db_session, printer_factory, tmp_path)
    mini = (await inherited_options(db_session, None, "A1 Mini")).model_dump()
    mini.update(flow_cali="off", preheat_override="off", timelapse=True)
    original = (await inherited_options(db_session, None, "P1S")).model_dump()
    original.update(preheat_override="on", timelapse=False)
    farm.item.order_print_options = {"P1S": original, "A1 Mini": mini}
    await db_session.commit()
    result = await _move(db_session, farm)
    assert (result.converted, result.created) == (1, 2), result.skipped
    rows = await _pending(db_session)
    assert len(rows) == 3
    for row in rows:
        assert (await read_item_requirements(db_session, row)).model == "A1 Mini"
        assert row.queue_source_id and row.library_file_id == farm.small.id
        assert row.order_print_options == {"P1S": original, "A1 Mini": mini}

    @asynccontextmanager
    async def session():
        yield db_session

    monkeypatch.setattr("backend.app.services.auto_queue_scheduler.async_session", session)
    eligible, scheduler = _patch_printer_manager({farm.p1s.id, farm.mini.id})
    with eligible, scheduler:
        await AutoQueueScheduler().tick()
    placed = (await db_session.execute(select(PrintQueueItem))).scalar_one()
    assert placed.queue_id == farm.mini_q.id
    assert placed.source_auto_item_id == farm.item.id
    assert placed.flow_cali_mode == "off" and not placed.flow_cali
    assert placed.timelapse and placed.preheat_override == "off"
