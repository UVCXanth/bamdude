"""Order print choices and auto-eject retain independent creation snapshots."""

import pytest
from sqlalchemy import select

from backend.app.models.auto_queue import AutoQueueItem
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer_queue import PrinterQueue
from backend.tests.integration.test_order_print_options import (
    custom_options,
    enqueue,
    mixed_order,  # noqa: F401 - shared real-file fixture
)

pytestmark = pytest.mark.integration


@pytest.mark.parametrize("target", ["auto", "printer"])
async def test_order_plan_keeps_print_choices_and_auto_eject_snapshots(
    committing_client, db_session, mixed_order, printer_factory, target
):
    order_id, plates = mixed_order
    policy = {"difference_threshold": 2.0, "skip_check": False}
    response = await committing_client.patch(
        f"/api/v1/projects/{order_id}",
        json={"auto_eject_enabled": True, "auto_eject_settings": policy},
    )
    assert response.status_code == 200, response.text
    choices = (await custom_options(committing_client, order_id))["H2D"]
    choices.update(flow_cali="off", nozzle_offset_cali="auto", preheat_override="off")
    response = await committing_client.put(
        f"/api/v1/projects/{order_id}/print-options", json={"overrides": {"H2D": choices}}
    )
    assert response.status_code == 200, response.text
    printer_id = None
    if target == "printer":
        printer = await printer_factory(model="H2D")
        db_session.add(PrinterQueue(printer_id=printer.id))
        await db_session.commit()
        printer_id = printer.id
    response = await enqueue(committing_client, order_id, plates, printer_id=printer_id, models={"H2D"})
    assert response.status_code == 200, response.text
    model = AutoQueueItem if target == "auto" else PrintQueueItem
    rows = (await db_session.execute(select(model))).scalars().all()
    assert len(rows) == 2
    for row in rows:
        assert row.auto_eject and row.auto_eject_settings == policy
        assert row.queue_source_id is not None
        if target == "auto":
            assert row.order_print_options == {"H2D": choices}
        else:
            assert row.flow_cali_mode == "off"
            assert row.nozzle_offset_cali_mode == "auto"
            assert row.preheat_override == "off"
