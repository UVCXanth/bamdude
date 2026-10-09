"""Synthetic order policy through the real API and captured-source producer."""

import pytest

from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer_queue import PrinterQueue
from backend.app.schemas.print_queue import PrintQueueItemCreate
from backend.app.services.queue_add import add_items_to_printer_queue
from backend.app.services.queue_ops import _copy_item_fields

pytestmark = pytest.mark.integration


@pytest.mark.asyncio
async def test_order_flag_snapshot_and_clone_do_not_change_printer_or_existing_work(
    committing_client,
    db_session,
    printer_factory,
    raw_gcode_source,
):
    a = (
        await committing_client.post("/api/v1/projects", json={"name": "Product A order", "auto_eject_enabled": True})
    ).json()
    b = (await committing_client.post("/api/v1/projects", json={"name": "Product B order"})).json()
    assert a["auto_eject_enabled"] is True
    assert b["auto_eject_enabled"] is False
    printer = await printer_factory(model="P1S", require_plate_clear=True, plate_detection_enabled=False)
    queue = PrinterQueue(printer_id=printer.id)
    db_session.add(queue)
    await db_session.commit()
    rows, _ = await add_items_to_printer_queue(
        db_session,
        PrintQueueItemCreate(
            queue_id=queue.id,
            library_file_id=raw_gcode_source.id,
            project_id=a["id"],
            quantity=2,
        ),
        None,
    )
    assert len(rows) == 2 and all(r.auto_eject is True and r.queue_source_id is not None for r in rows)
    old_id = rows[0].id
    changed = await committing_client.patch(f"/api/v1/projects/{a['id']}", json={"auto_eject_enabled": False})
    assert changed.status_code == 200 and changed.json()["auto_eject_enabled"] is False
    old = await db_session.get(PrintQueueItem, old_id, populate_existing=True)
    assert old.auto_eject is True
    assert _copy_item_fields(old, None, 99).auto_eject is True
    assert printer.require_plate_clear is True and printer.plate_detection_enabled is False
    new, _ = await add_items_to_printer_queue(
        db_session,
        PrintQueueItemCreate(
            queue_id=queue.id,
            library_file_id=raw_gcode_source.id,
            project_id=a["id"],
            quantity=1,
        ),
        None,
    )
    assert new[0].auto_eject is False
    null = await committing_client.patch(f"/api/v1/projects/{a['id']}", json={"auto_eject_enabled": None})
    assert null.status_code == 422
