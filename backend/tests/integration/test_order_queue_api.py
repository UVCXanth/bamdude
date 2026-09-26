"""The order's queue section reads both tiers from the server (spec workshop-order-queue)."""

from datetime import datetime

import pytest

from backend.app.models.archive import PrintArchive
from backend.app.models.auto_queue import AutoQueueItem
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.project import Project
from backend.app.services.printer_queues import ensure_printer_queue

pytestmark = pytest.mark.integration


def _archive(**kw):
    base = {"filename": "x.3mf", "file_path": "", "file_size": 0, "quantity": 1, "status": "printing"}
    return PrintArchive(**{**base, **kw})


@pytest.fixture
async def seeded(db_session, printer_factory):
    """Two printers, the order and a stranger; every live and dead row the tiers must tell apart."""
    a = await printer_factory(name="A")
    b = await printer_factory(name="B")
    await ensure_printer_queue(db_session, a.id)
    await ensure_printer_queue(db_session, b.id)
    order, other = Project(name="Q-order"), Project(name="Q-other")
    db_session.add_all([order, other])
    await db_session.commit()
    handed = PrintQueueItem(queue_id=b.id, project_id=order.id, status="pending", position=1)
    db_session.add(handed)
    await db_session.flush()
    db_session.add_all(
        [
            PrintQueueItem(queue_id=a.id, project_id=order.id, status="pending", position=2),
            PrintQueueItem(queue_id=a.id, project_id=order.id, status="completed", position=1),
            PrintQueueItem(queue_id=a.id, project_id=order.id, status="cancelled", position=4),
            PrintQueueItem(queue_id=a.id, project_id=other.id, status="pending", position=3),
            AutoQueueItem(
                project_id=order.id, status="pending", position=2, target_model="P1S", waiting_reason="No idle P1S"
            ),
            AutoQueueItem(project_id=order.id, status="pending", position=1),
            # handed to `handed` — it is that printer-queue row now, never a second one
            AutoQueueItem(project_id=order.id, status="assigned", assigned_to_item_id=handed.id),
            AutoQueueItem(project_id=order.id, status="pending", assigned_to_item_id=handed.id),
            AutoQueueItem(project_id=order.id, status="cancelled"),
            AutoQueueItem(project_id=other.id, status="pending"),
            # started from the printer's screen and filed to the order: no queue row at all
            _archive(project_id=order.id, printer_id=a.id, print_name="Body"),
            _archive(project_id=order.id, printer_id=b.id, status="completed"),
            _archive(project_id=order.id, printer_id=b.id, deleted_at=datetime.now()),
            _archive(project_id=order.id, printer_id=b.id, extra_data={"dispatch_aborted": True}),
            _archive(project_id=other.id, printer_id=b.id),
        ]
    )
    await db_session.commit()
    return a, b, order


@pytest.mark.asyncio
async def test_the_three_tiers_hold_only_this_orders_live_work(async_client, seeded):
    _a, _b, order = seeded
    body = (await async_client.get(f"/api/v1/projects/{order.id}/queue")).json()
    assert [(p["printer_name"], p["name"]) for p in body["printing"]] == [("A", "Body")]
    assert [(r["printer_name"], r["position"]) for r in body["pending"]] == [("A", 2), ("B", 1)]
    assert [r["position"] for r in body["awaiting"]] == [1, 2]  # the distributor's order
    assert body["awaiting"][1]["target_model"] == "P1S" and body["awaiting"][1]["waiting_reason"] == "No idle P1S"


@pytest.mark.asyncio
async def test_the_section_counts_what_the_tiles_count(async_client, seeded):
    _a, _b, order = seeded
    figures = (await async_client.get(f"/api/v1/projects/{order.id}")).json()["figures"]
    body = (await async_client.get(f"/api/v1/projects/{order.id}/queue")).json()
    assert len(body["pending"]) + len(body["awaiting"]) == figures["prints_queued"] == 4
    assert len(body["printing"]) == figures["prints_in_progress"] == 1


@pytest.mark.asyncio
async def test_a_key_limited_to_printers_sees_only_theirs_and_no_auto_queue(async_client, seeded):
    a, _b, order = seeded
    created = await async_client.post(
        "/api/v1/api-keys/", json={"name": "only-a", "can_read_status": True, "printer_ids": [a.id]}
    )
    assert created.status_code == 200, created.text
    headers = {"X-API-Key": created.json()["key"]}
    body = (await async_client.get(f"/api/v1/projects/{order.id}/queue", headers=headers)).json()
    assert {r["printer_name"] for r in body["pending"]} == {"A"}
    assert {p["printer_name"] for p in body["printing"]} == {"A"}
    assert body["awaiting"] == []


@pytest.mark.asyncio
async def test_a_key_limited_to_no_printers_sees_nothing(async_client, seeded):
    _a, _b, order = seeded
    created = await async_client.post(
        "/api/v1/api-keys/", json={"name": "none", "can_read_status": True, "printer_ids": []}
    )
    headers = {"X-API-Key": created.json()["key"]}
    body = (await async_client.get(f"/api/v1/projects/{order.id}/queue", headers=headers)).json()
    assert body == {"printing": [], "pending": [], "awaiting": []}


@pytest.mark.asyncio
async def test_a_print_whose_printer_is_gone_still_shows_unnamed(async_client, db_session):
    order = Project(name="Q-orphan")
    db_session.add(order)
    await db_session.commit()
    db_session.add(_archive(project_id=order.id, printer_id=None, print_name="Lid"))
    await db_session.commit()
    body = (await async_client.get(f"/api/v1/projects/{order.id}/queue")).json()
    assert [(p["name"], p["printer_id"], p["printer_name"]) for p in body["printing"]] == [("Lid", None, None)]


@pytest.mark.asyncio
async def test_an_unknown_order_is_a_404(async_client):
    assert (await async_client.get("/api/v1/projects/999999/queue")).status_code == 404
