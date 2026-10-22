"""A confirmed failed block is re-armed by one writer, never a client loop."""

import pytest
from sqlalchemy import select

from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer_queue import PrinterQueue
from backend.app.services.printer_queues import ensure_printer_queue


@pytest.fixture
async def failed_block(db_session, printer_factory):
    printer = await printer_factory()
    await ensure_printer_queue(db_session, printer.id)
    queue = await db_session.get(PrinterQueue, printer.id)
    queue.status = "paused"
    rows = [
        PrintQueueItem(queue_id=queue.id, status=status, position=i, require_previous_success=True, error_message="old")
        for i, status in enumerate(["failed", "failed", "cancelled", "printing", "failed", "pending"], 1)
    ]
    db_session.add_all(rows)
    await db_session.commit()
    return queue.id, [row.id for row in rows]


@pytest.mark.asyncio
async def test_only_confirmed_still_failed_rows_reenter_at_end_together(async_client, db_session, failed_block):
    queue_id, ids = failed_block
    response = await async_client.post(
        "/api/v1/queue/bulk-retry", json={"queue_id": queue_id, "item_ids": [*ids[:4], 999999]}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["retried"] == ids[:2]
    assert body["left_in_place"] == [
        {"id": ids[2], "reason": "not_failed"},
        {"id": ids[3], "reason": "not_failed"},
        {"id": 999999, "reason": "missing"},
    ]
    assert body["not_attempted"] == []
    db_session.expire_all()
    rows = (await db_session.scalars(select(PrintQueueItem).order_by(PrintQueueItem.id))).all()
    assert [row.status for row in rows] == ["pending", "pending", "cancelled", "printing", "failed", "pending"]
    assert [rows[0].position, rows[1].position] == [7, 8]
    assert rows[0].error_message is None and rows[0].require_previous_success
    queue = await db_session.get(PrinterQueue, queue_id)
    assert queue.pending_count == 3 and queue.status == "paused"


@pytest.mark.asyncio
async def test_counter_failure_rolls_back_the_whole_block(async_client, db_session, failed_block, monkeypatch):
    from backend.app.services import queue_counters

    queue_id, ids = failed_block

    async def fail(*args):
        raise RuntimeError("test counter failure")

    monkeypatch.setattr(queue_counters, "update_queue_counters", fail)
    # ASGI normally propagates an unhandled exception in this test transport.
    with pytest.raises(RuntimeError, match="test counter failure"):
        await async_client.post("/api/v1/queue/bulk-retry", json={"queue_id": queue_id, "item_ids": ids[:2]})
    await db_session.rollback()
    assert list(await db_session.scalars(select(PrintQueueItem.status).where(PrintQueueItem.id.in_(ids[:2])))) == [
        "failed",
        "failed",
    ]


@pytest.mark.asyncio
async def test_a_restricted_key_cannot_name_another_queue(async_client, failed_block):
    queue_id, ids = failed_block
    key = await async_client.post(
        "/api/v1/api-keys/", json={"name": "retry", "can_control_printer": True, "printer_ids": []}
    )
    response = await async_client.post(
        "/api/v1/queue/bulk-retry",
        headers={"X-API-Key": key.json()["key"]},
        json={"queue_id": queue_id, "item_ids": ids[:2]},
    )
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_unready_source_stays_failed_while_its_sibling_retries(async_client, db_session, failed_block):
    from backend.app.models.queue_source import QueueSource

    queue_id, ids = failed_block
    blob = QueueSource(sha256="a" * 64, size_bytes=2, relative_path="aa/source.3mf", format="3mf", state="broken")
    db_session.add(blob)
    await db_session.flush()
    row = await db_session.get(PrintQueueItem, ids[1])
    row.queue_source_id = blob.id
    await db_session.commit()
    response = await async_client.post("/api/v1/queue/bulk-retry", json={"queue_id": queue_id, "item_ids": ids[:2]})
    assert response.status_code == 200, response.text
    assert response.json() == {
        "retried": ids[:1],
        "left_in_place": [{"id": ids[1], "reason": "source_unavailable"}],
        "not_attempted": [],
    }
