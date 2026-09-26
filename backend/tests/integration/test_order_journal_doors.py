"""The order journal at every door that is not the order's own edit (spec workshop-order-stage, rule 17)."""

import pytest
from sqlalchemy import select

from backend.app.models.archive import PrintArchive
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer_queue import PrinterQueue
from backend.app.models.product import Product, ProductPart
from backend.app.models.project import ProjectEvent

pytestmark = pytest.mark.integration


async def _kinds(db_session, oid):
    db_session.expire_all()
    rows = (
        (await db_session.execute(select(ProjectEvent).where(ProjectEvent.project_id == oid).order_by(ProjectEvent.id)))
        .scalars()
        .all()
    )
    return [(r.kind, r.payload) for r in rows]


async def _only(db_session, oid, kind):
    return [payload for k, payload in await _kinds(db_session, oid) if k == kind]


async def _product(db_session, name="Lamp"):
    product = Product(name=name)
    db_session.add(product)
    await db_session.commit()
    return product.id


async def _order(client, name="O"):
    return (await client.post("/api/v1/projects", json={"name": name})).json()["id"]


async def _print(db_session, project_id):
    archive = PrintArchive(
        project_id=project_id, filename="p.3mf", file_path="", file_size=0, status="completed", quantity=3
    )
    db_session.add(archive)
    await db_session.commit()
    return archive.id


@pytest.mark.asyncio
async def test_lines_added_changed_and_removed(committing_client, db_session):
    pid = await _product(db_session)
    oid = await _order(committing_client)
    added = await committing_client.post(f"/api/v1/projects/{oid}/lines", json={"product_id": pid, "quantity": 3})
    lid = added.json()["lines"][0]["id"]
    assert await _only(db_session, oid, "line_added") == [
        {"line_id": lid, "product": "Lamp", "quantity": 3, "from_stock": 0}
    ]
    await committing_client.patch(f"/api/v1/projects/{oid}/lines/{lid}", json={"quantity": 5, "note": "x"})
    await committing_client.patch(f"/api/v1/projects/{oid}/lines/{lid}", json={"quantity": 5})  # nothing changed
    assert await _only(db_session, oid, "line_changed") == [
        {"line_id": lid, "product": "Lamp", "changes": {"quantity": [3, 5], "note": [None, "x"]}}
    ]
    await committing_client.delete(f"/api/v1/projects/{oid}/lines/{lid}")
    assert await _only(db_session, oid, "line_removed") == [{"product": "Lamp", "quantity": 5}]


@pytest.mark.asyncio
async def test_filing_prints_from_another_order_is_two_lines(committing_client, db_session):
    a, b = await _order(committing_client, "A"), await _order(committing_client, "B")
    aid = await _print(db_session, a)
    await committing_client.post(f"/api/v1/projects/{b}/add-archives", json={"archive_ids": [aid]})
    assert await _only(db_session, b, "prints_filed") == [{"count": 1, "archive_ids": [aid]}]
    assert await _only(db_session, a, "prints_unfiled") == [{"count": 1, "archive_ids": [aid]}]
    await committing_client.post(f"/api/v1/projects/{b}/remove-archives", json={"archive_ids": [aid]})
    assert await _only(db_session, b, "prints_unfiled") == [{"count": 1, "archive_ids": [aid]}]


@pytest.mark.asyncio
async def test_filing_a_print_already_in_the_order_writes_nothing(committing_client, db_session):
    oid = await _order(committing_client)
    aid = await _print(db_session, oid)
    await committing_client.post(f"/api/v1/projects/{oid}/add-archives", json={"archive_ids": [aid]})
    assert await _only(db_session, oid, "prints_filed") == []


@pytest.mark.asyncio
async def test_the_archive_editor_moving_a_print_is_two_lines(committing_client, db_session):
    a, b = await _order(committing_client, "A"), await _order(committing_client, "B")
    aid = await _print(db_session, a)
    r = await committing_client.patch(f"/api/v1/archives/{aid}", json={"project_id": b})
    assert r.status_code == 200, r.text
    assert await _only(db_session, a, "prints_unfiled") == [{"count": 1, "archive_ids": [aid]}]
    assert await _only(db_session, b, "prints_filed") == [{"count": 1, "archive_ids": [aid]}]
    await committing_client.patch(f"/api/v1/archives/{aid}", json={"project_id": None})
    assert await _only(db_session, b, "prints_unfiled") == [{"count": 1, "archive_ids": [aid]}]


@pytest.mark.asyncio
async def test_defects_on_a_filed_print_are_journaled_once_per_change(committing_client, db_session):
    oid = await _order(committing_client)
    aid = await _print(db_session, oid)
    url = f"/api/v1/projects/{oid}/archives/{aid}/defects"
    assert (await committing_client.post(url, json={"defective_count": 2})).status_code == 200
    await committing_client.post(url, json={"defective_count": 2})  # the same count again: nothing
    assert await _only(db_session, oid, "defects_recorded") == [{"archive_id": aid, "defective": 2}]


@pytest.mark.asyncio
async def test_queue_items_filed(committing_client, db_session):
    oid = await _order(committing_client)
    db_session.add(PrinterQueue(id=1, printer_id=1))
    await db_session.flush()
    item = PrintQueueItem(queue_id=1, status="pending")
    db_session.add(item)
    await db_session.commit()
    await committing_client.post(f"/api/v1/projects/{oid}/add-queue", json={"queue_item_ids": [item.id]})
    assert await _only(db_session, oid, "queue_items_filed") == [{"count": 1}]


@pytest.mark.asyncio
async def test_procurement_updated(committing_client, db_session):
    pid = await _product(db_session)
    screw = ProductPart(product_id=pid, kind="purchased", name="Screw", name_key="purchased:screw", qty_per_unit=4)
    db_session.add(screw)
    await db_session.commit()
    oid = await _order(committing_client)
    await committing_client.post(f"/api/v1/projects/{oid}/lines", json={"product_id": pid, "quantity": 1})
    url = f"/api/v1/projects/{oid}/procurement/{screw.id}"
    assert (await committing_client.patch(url, json={"quantity_acquired": 4})).status_code == 200
    await committing_client.patch(url, json={"quantity_acquired": 4})  # unchanged: nothing
    assert await _only(db_session, oid, "procurement_updated") == [{"part": "Screw", "from": 0, "to": 4}]


@pytest.mark.asyncio
async def test_attachments_and_the_cover(committing_client, db_session):
    oid = await _order(committing_client)
    up = await committing_client.post(
        f"/api/v1/projects/{oid}/attachments", files={"file": ("notes.txt", b"hello", "text/plain")}
    )
    assert up.status_code == 200, up.text
    assert await _only(db_session, oid, "attachment_added") == [{"filename": "notes.txt"}]
    await committing_client.delete(f"/api/v1/projects/{oid}/attachments/{up.json()['filename']}")
    assert await _only(db_session, oid, "attachment_removed") == [{"filename": "notes.txt"}]
    cover = await committing_client.post(
        f"/api/v1/projects/{oid}/cover-image", files={"file": ("cover.png", b"\x89PNG\r\n\x1a\n", "image/png")}
    )
    assert cover.status_code == 200, cover.text
    await committing_client.delete(f"/api/v1/projects/{oid}/cover-image")
    assert await _only(db_session, oid, "cover_changed") == [{"action": "set"}, {"action": "removed"}]


@pytest.mark.asyncio
async def test_banking_nothing_writes_nothing(committing_client, db_session):
    oid = await _order(committing_client)
    r = await committing_client.post(f"/api/v1/projects/{oid}/bank-surplus")
    assert r.json()["nothing_to_bank"] is True
    assert await _only(db_session, oid, "surplus_banked") == []
