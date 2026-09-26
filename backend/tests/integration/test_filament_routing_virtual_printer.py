"""VP writers and late MQTT options use the same durable routing rules."""

import json
import time
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from backend.app.models.auto_queue import AutoQueueItem
from backend.app.models.print_queue import PrintQueueItem
from backend.app.services.printer_manager import printer_manager
from backend.app.services.virtual_printer.manager import VirtualPrinterInstance
from backend.tests.fixtures.filament_routing_cases import write_routing_3mf
from backend.tests.integration.test_filament_routing_dispatch import setup_source

pytestmark = pytest.mark.integration


async def test_vp_rejects_captured_incompatible_model_despite_stale_library_metadata(
    db_session, test_engine, tmp_path, printer_factory, monkeypatch
):
    source, printer, queue, _ = await setup_source(db_session, tmp_path, printer_factory, monkeypatch)
    source.file_metadata = {"sliced_for_model": "P1P", "plates": [{"index": 15}]}
    await db_session.commit()
    write_routing_3mf(
        Path(source.file_path),
        {15: [{"id": 3, "type": "PLA", "color": "#FF0000", "used_g": "1"}]},
        model="A1",
    )
    vp = VirtualPrinterInstance(
        vp_id=1,
        name="Synthetic",
        mode="print_queue",
        model="C11",
        access_code="00000000",
        serial_suffix="000000001",
        target_printer_id=printer.id,
        base_dir=tmp_path,
        session_factory=async_sessionmaker(test_engine, expire_on_commit=False),
    )
    monkeypatch.setattr(vp, "_save_to_library", AsyncMock(return_value=source))
    monkeypatch.setattr(vp, "_find_best_queue", AsyncMock(return_value=queue))

    await vp._add_to_print_queue(Path(source.file_path), "127.0.0.1")
    assert (await db_session.execute(select(PrintQueueItem))).scalar_one_or_none() is None


async def test_vp_stamps_compatible_captured_file_as_non_exact(
    db_session, test_engine, tmp_path, printer_factory, monkeypatch
):
    source, printer, queue, _ = await setup_source(db_session, tmp_path, printer_factory, monkeypatch)
    source.file_metadata = {"sliced_for_model": "P1P", "plates": [{"index": 15}]}
    printer.model = "P1S"
    monkeypatch.setitem(printer_manager._models, printer.id, "P1S")
    await db_session.commit()
    vp = VirtualPrinterInstance(
        vp_id=1,
        name="Synthetic",
        mode="print_queue",
        model="C11",
        access_code="00000000",
        serial_suffix="000000001",
        target_printer_id=printer.id,
        base_dir=tmp_path,
        session_factory=async_sessionmaker(test_engine, expire_on_commit=False),
    )
    monkeypatch.setattr(vp, "_save_to_library", AsyncMock(return_value=source))
    monkeypatch.setattr(vp, "_find_best_queue", AsyncMock(return_value=queue))
    await vp._add_to_print_queue(Path(source.file_path), "127.0.0.1")

    row = (await db_session.execute(select(PrintQueueItem))).scalar_one()
    assert json.loads(row.filament_routing)["exact_model"] is False


@pytest.mark.parametrize(
    "save_mapping,mapping,expected", [(True, None, "auto"), (False, [254], "auto"), (True, [-1, -1, 254], "pinned")]
)
async def test_vp_only_pins_a_mapping_it_actually_captured(
    db_session, test_engine, tmp_path, printer_factory, monkeypatch, save_mapping, mapping, expected
):
    source, printer, queue, _ = await setup_source(db_session, tmp_path, printer_factory, monkeypatch)
    source.file_metadata = {"sliced_for_model": "P1P", "plates": [{"index": 15}]}
    await db_session.commit()
    vp = VirtualPrinterInstance(
        vp_id=1,
        name="Synthetic",
        mode="print_queue",
        model="C11",
        access_code="00000000",
        serial_suffix="000000001",
        target_printer_id=printer.id,
        auto_dispatch=True,
        save_ams_mapping=save_mapping,
        base_dir=tmp_path,
        session_factory=async_sessionmaker(test_engine, expire_on_commit=False),
    )
    monkeypatch.setattr(vp, "_save_to_library", AsyncMock(return_value=source))
    monkeypatch.setattr(vp, "_find_best_queue", AsyncMock(return_value=queue))
    vp._slicer_print_options[Path(source.file_path).name] = {"use_ams": True, "ams_mapping": mapping}
    await vp._add_to_print_queue(Path(source.file_path), "127.0.0.1")
    row = (await db_session.execute(select(PrintQueueItem))).scalar_one()
    rules = json.loads(row.filament_routing)
    assert rules["mode"] == expected
    if expected == "pinned":
        assert rules["physical_pins"]["3"]["source_id"] == 254


@pytest.mark.parametrize("mode", ["print_queue", "auto_queue"])
async def test_virtual_printer_intake_and_late_options_preserve_exact_plate_and_feed(
    db_session,
    test_engine,
    tmp_path,
    printer_factory,
    monkeypatch,
    mode,
):
    source, printer, queue, _ = await setup_source(db_session, tmp_path, printer_factory, monkeypatch)
    source.file_metadata = {"sliced_for_model": "P1P", "plates": [{"index": 15}]}
    await db_session.commit()
    vp = VirtualPrinterInstance(
        vp_id=1,
        name="Synthetic",
        mode=mode,
        model="C11",
        access_code="00000000",
        serial_suffix="000000001",
        target_printer_id=printer.id,
        auto_dispatch=True,
        base_dir=tmp_path,
        session_factory=async_sessionmaker(test_engine, expire_on_commit=False),
    )
    monkeypatch.setattr(vp, "_save_to_library", AsyncMock(return_value=source))
    monkeypatch.setattr(vp, "_find_best_queue", AsyncMock(return_value=queue))
    filename = Path(source.file_path).name
    vp._slicer_print_options[filename] = {"use_ams": True}
    if mode == "print_queue":
        await vp._add_to_print_queue(Path(source.file_path), "127.0.0.1")
        row = (await db_session.execute(select(PrintQueueItem))).scalar_one()
        rules = json.loads(row.filament_routing)
        assert rules["feed_policy"] == "auto" and rules["mode"] == "auto"
        restamp, recent = vp._restamp_recent_queue_item, vp._recent_queue_items
    else:
        await vp._add_to_auto_queue(Path(source.file_path), "127.0.0.1")
        row = (await db_session.execute(select(AutoQueueItem))).scalar_one()
        assert row.feed_policy == "auto" and row.force_color_match is False
        restamp, recent = vp._restamp_recent_auto_item, vp._recent_auto_items
    assert row.plate_id == 15
    recent[filename] = ([row.id], time.monotonic())
    await restamp(filename, {"use_ams": False})
    await db_session.refresh(row)
    assert row.use_ams is False
    assert (
        json.loads(row.filament_routing)["feed_policy"] if mode == "print_queue" else row.feed_policy
    ) == "external_only"
    row.status = "printing" if mode == "print_queue" else "assigned"
    await db_session.commit()
    recent[filename] = ([row.id], time.monotonic())
    await restamp(filename, {"use_ams": True})
    await db_session.refresh(row)
    assert row.use_ams is False
