"""A rack-position pick, from the queue to the MQTT wire (upstream #1784, 3954d3a7).

Upstream shipped two seam bugs past a green suite that tested the pieces: the
group data reached one of three routes, and the field was missing from one
schema. So this drives the REAL chain — queue add → ``check_queue`` → the
``background_dispatch`` runner → ``start_print`` → the command published — with
only device I/O mocked, and reads the answer off the wire.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker

from backend.app.models.library import LibraryFile
from backend.app.models.printer_queue import PrinterQueue
from backend.app.schemas.print_queue import PrintQueueItemCreate
from backend.app.services.bambu_mqtt import BambuMQTTClient
from backend.app.services.printer_manager import printer_manager
from backend.tests.fixtures.filament_routing_cases import write_routing_3mf
from backend.tests.integration.test_dispatch_without_original import (  # noqa: F401 - fixtures
    clean_spool_state,
    dispatch_mocks,
    drain,
    scheduler_with_captured_dispatch,
    sessions,
)

pytestmark = pytest.mark.integration

PLATE = 1
# Upstream's plate: groups 2/0/1, groups 1 and 2 both on the rack carriage
# (slicer extruder 2), group 0 on the fixed hotend.
FILAMENTS = [
    {"id": 1, "type": "PLA", "color": "#FF0000", "used_g": "3.1", "group_id": 2},
    {"id": 2, "type": "PLA", "color": "#FFFF00", "used_g": "2.2", "group_id": 0},
    {"id": 3, "type": "PLA", "color": "#0000FF", "used_g": "1.3", "group_id": 1},
]
RACK_SETTINGS = {
    "physical_extruder_map": ["1", "0"],
    "extruder_max_nozzle_count": ["1", "6"],
    "extruder_nozzle_stats": ["High Flow#1", "High Flow#6"],
    "nozzle_diameter": ["0.4", "0.4"],
}


def _rack_info(present):
    """``device.nozzle.info``: the docks named, plus the fixed hotend (id 1)."""
    return [{"id": 15 + p, "diameter": "0.4", "type": "HH01"} for p in present] + [
        {"id": 1, "diameter": "0.4", "type": "HH01"}
    ]


async def _h2c_job(db, tmp_path, printer_factory, monkeypatch, *, rack, choice):
    path = write_routing_3mf(
        tmp_path / "benchy.gcode.3mf",
        {PLATE: [{**f, "nozzle_diameter": "0.40", "volume_type": "High Flow"} for f in FILAMENTS]},
        model="O1C2",
        settings=RACK_SETTINGS,
        nozzle_groups={0: 1, 1: 2, 2: 2},
    )
    source = LibraryFile(filename=path.name, file_path=str(path), file_size=path.stat().st_size, file_type="gcode")
    printer = await printer_factory(model="H2C")
    queue = PrinterQueue(id=printer.id, printer_id=printer.id)
    db.add_all([source, queue])
    await db.commit()

    mqtt = BambuMQTTClient("127.0.0.1", "RACK_SYNTHETIC", "00000000", model="H2C")
    mqtt._client = MagicMock()
    mqtt.state.connected, mqtt.state.state = True, "IDLE"
    mqtt._process_message(
        {
            "print": {
                "command": "push_status",
                # AMS 0 feeds extruder 0, the rack carriage: red and blue.
                "ams": {
                    "ams": [
                        {
                            "id": 0,
                            "info": "0",
                            "tray": [
                                {"id": 0, "tray_type": "PLA", "tray_color": "FF0000"},
                                {"id": 1, "tray_type": "PLA", "tray_color": "0000FF"},
                            ],
                        }
                    ]
                },
                # The fixed hotend's external spool: yellow.
                "vir_slot": [{"id": 254, "tray_type": "PLA", "tray_color": "FFFF00"}],
                "device": {"nozzle": {"info": _rack_info(rack)}},
            }
        }
    )
    monkeypatch.setitem(printer_manager._clients, printer.id, mqtt)
    monkeypatch.setitem(printer_manager._models, printer.id, "H2C")

    from backend.app.services.queue_add import add_items_to_printer_queue

    items, _queue = await add_items_to_printer_queue(
        db,
        PrintQueueItemCreate(queue_id=queue.id, library_file_id=source.id, plate_id=PLATE, nozzle_rack_choice=choice),
        None,
    )
    return items[0], mqtt


async def _dispatch(monkeypatch, test_engine):
    """Run the queue once; return the order of the FTP calls the runner made."""
    events: list[str] = []
    factory = async_sessionmaker(test_engine, expire_on_commit=False)

    async def upload(*_args, **_kwargs):
        events.append("upload")
        return True

    service = dispatch_mocks(monkeypatch, factory, upload=upload)
    import backend.app.services.background_dispatch as bd

    async def delete(*_args, **_kwargs):
        events.append("delete")
        return True

    monkeypatch.setattr(bd, "delete_file_async", delete)
    monkeypatch.setattr(bd, "report_failure_if_unwatched", AsyncMock())
    scheduler, spawned = scheduler_with_captured_dispatch(monkeypatch)
    assert await scheduler.check_queue() is True
    await drain(spawned)
    return service, events


def _published(mqtt) -> dict:
    mqtt._client.publish.assert_called_once()
    return json.loads(mqtt._client.publish.call_args.args[1])["print"]


async def test_a_pick_that_fits_reaches_the_wire(
    db_session, test_engine, tmp_path, printer_factory, monkeypatch, sessions
):
    """R1 for group 2, R3 for group 1: BambuStudio's 2026-08-13 dispatch, [16, 1, 18]."""
    item, mqtt = await _h2c_job(
        db_session, tmp_path, printer_factory, monkeypatch, rack=(1, 2, 3, 4, 5, 6), choice={2: 1, 1: 3}
    )

    await _dispatch(monkeypatch, test_engine)

    assert _published(mqtt)["nozzle_mapping"][:3] == [16, 1, 18]
    await db_session.refresh(item)
    assert item.status == "printing"


async def test_no_pick_is_assigned_rather_than_left_to_the_firmware(
    db_session, test_engine, tmp_path, printer_factory, monkeypatch, sessions
):
    """This plate went out with no ``nozzle_mapping`` at all before (#2800's
    guard withholds two rack hotends); now each group gets a position."""
    _item, mqtt = await _h2c_job(
        db_session, tmp_path, printer_factory, monkeypatch, rack=(1, 2, 3, 4, 5, 6), choice=None
    )

    await _dispatch(monkeypatch, test_engine)

    assert _published(mqtt)["nozzle_mapping"][:3] == [17, 1, 16]


async def test_a_stale_pick_refuses_and_takes_the_file_off_the_card(
    db_session, test_engine, tmp_path, printer_factory, monkeypatch, sessions
):
    """Position 3 was emptied after the job was queued: the print is refused,
    not sent to another hotend, and the uploaded file does not stay on the card
    to be started by hand."""
    item, mqtt = await _h2c_job(db_session, tmp_path, printer_factory, monkeypatch, rack=(1, 2), choice={2: 1, 1: 3})

    _service, events = await _dispatch(monkeypatch, test_engine)

    mqtt._client.publish.assert_not_called()
    await db_session.refresh(item)
    assert item.status == "failed"
    assert "rack position 3" in item.error_message
    assert "upload" in events
    assert "delete" in events[events.index("upload") :], events
