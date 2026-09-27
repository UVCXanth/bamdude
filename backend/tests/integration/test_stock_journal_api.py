"""One journal for both stock ledgers (spec workshop-finished-goods, rule 21)."""

from datetime import datetime

import pytest
from sqlalchemy import text, update

from backend.app.models.customer import Customer
from backend.app.models.finished_stock import StockItemMovement
from backend.app.models.part_stock import ProductPartStockMovement
from backend.app.models.product import Product, ProductPart
from backend.app.models.user import User
from backend.app.services import finished_stock, part_stock

pytestmark = pytest.mark.integration


@pytest.fixture
async def lamp(db_session):
    product = Product(name="Lamp")
    db_session.add(product)
    await db_session.flush()
    shade = ProductPart(product_id=product.id, kind="printed", name="shade", name_key="shade", qty_per_unit=1)
    db_session.add(shade)
    await db_session.commit()
    return {"product": product, "shade": shade}


async def _page(client, **params):
    r = await client.get("/api/v1/stock/journal", params=params)
    assert r.status_code == 200, r.text
    return r.json()


@pytest.mark.asyncio
async def test_both_ledgers_newest_first(committing_client, db_session, lamp):
    person = User(username="clerk", password_hash="x", role="user")
    customer = Customer(name="Acme")
    db_session.add_all([person, customer])
    await db_session.flush()
    await part_stock.move(
        db_session, part_id=lamp["shade"].id, delta=3, reason="manual", note="seed", created_by=person.id
    )
    item = await finished_stock.item_for(db_session, lamp["product"].id, {}, create=True)
    await finished_stock.assemble(db_session, item, 2, actor=person)
    await finished_stock.issue(db_session, item, 1, customer_id=customer.id, actor=person)
    await db_session.commit()
    rows = (await _page(committing_client))["items"]
    # Deterministic even when two rows share an instant: the finished row ranks
    # above the parts row, and ids descend within a book.
    assert [(r["book"], r["kind"]) for r in rows] == [
        ("finished", "issue"),
        ("finished", "assembled"),
        ("parts", "assembled"),
        ("parts", "manual"),
    ]
    issue = rows[0]
    assert issue["customer"] == {"id": customer.id, "name": "Acme"}
    assert issue["user"]["username"] == "clerk"
    assert issue["item"]["code"] == f"SK-{item.id:04d}"
    assert issue["delta_on_hand"] == -1
    assembled_parts = next(r for r in rows if r["book"] == "parts" and r["kind"] == "assembled")
    assert assembled_parts["part_name"] == "shade" and assembled_parts["delta"] == -2
    assert assembled_parts["item"]["id"] == item.id
    finished_only = (await _page(committing_client, book="finished"))["items"]
    assert {r["book"] for r in finished_only} == {"finished"}
    parts_only = (await _page(committing_client, book="parts"))["items"]
    assert {r["book"] for r in parts_only} == {"parts"}
    of_item = (await _page(committing_client, item_id=item.id))["items"]
    assert sorted((r["book"], r["kind"]) for r in of_item) == [
        ("finished", "assembled"),
        ("finished", "issue"),
        ("parts", "assembled"),
    ]


@pytest.mark.asyncio
async def test_the_cursor_never_loses_or_repeats_a_row(committing_client, db_session, lamp):
    item = await finished_stock.item_for(db_session, lamp["product"].id, {}, create=True)
    for _ in range(7):
        await finished_stock.receive(db_session, item, 1)
        await part_stock.move(db_session, part_id=lamp["shade"].id, delta=1, reason="manual", note="x")
    same = datetime(2026, 9, 27, 10, 0, 0, 123456)
    await db_session.execute(update(StockItemMovement).values(created_at=same))
    await db_session.execute(update(ProductPartStockMovement).values(created_at=same))
    await db_session.commit()
    seen, cursor = [], None
    while True:
        params = {"limit": 5}
        if cursor:
            params["cursor"] = cursor
        body = await _page(committing_client, **params)
        seen += [(r["book"], r["id"]) for r in body["items"]]
        cursor = body["next_cursor"]
        if not cursor:
            break
    assert len(seen) == 14 and len(set(seen)) == 14
    # Finished rows sort above parts rows at the same instant; ids descend within a book.
    assert seen[:7] == sorted([s for s in seen if s[0] == "finished"], key=lambda s: -s[1])


async def _walk(client, limit):
    seen, cursor = [], None
    while True:
        params = {"limit": limit}
        if cursor:
            params["cursor"] = cursor
        body = await _page(client, **params)
        seen += [(r["book"], r["id"]) for r in body["items"]]
        cursor = body["next_cursor"]
        if not cursor:
            return seen


@pytest.mark.asyncio
async def test_the_cursor_keeps_rows_whose_millisecond_would_round_up(committing_client, db_session, lamp):
    """⚠️ SQLite's ``strftime('%f')`` ROUNDS to the millisecond while Python truncates:
    a page ending on ``.123900`` handed back a ``.123`` cursor that ``.123789`` (``.124``
    in SQL) was neither older than nor equal to — the row was lost. Found by the
    final review (Critical 1)."""
    item = await finished_stock.item_for(db_session, lamp["product"].id, {}, create=True)
    first = await finished_stock.receive(db_session, item, 1)
    second = await finished_stock.receive(db_session, item, 1)
    third = await finished_stock.receive(db_session, item, 1)
    stamps = {
        first.id: datetime(2026, 9, 27, 10, 0, 0, 123789),
        second.id: datetime(2026, 9, 27, 10, 0, 0, 123900),
        third.id: datetime(2026, 9, 27, 10, 0, 0, 0),
    }
    for move_id, stamp in stamps.items():
        await db_session.execute(
            update(StockItemMovement).where(StockItemMovement.id == move_id).values(created_at=stamp)
        )
    legacy = await part_stock.move(db_session, part_id=lamp["shade"].id, delta=1, reason="manual", note="x")
    await db_session.commit()
    # A parts row written before the ledger stamped its own time: the SQLite server
    # default, no fractional part — the same instant as the finished row at .000000.
    await db_session.execute(
        text("UPDATE product_part_stock_movements SET created_at = '2026-09-27 10:00:00' WHERE id = :id"),
        {"id": legacy.id},
    )
    await db_session.commit()
    seen = await _walk(committing_client, 1)
    assert seen == [
        ("finished", second.id),
        ("finished", first.id),
        ("finished", third.id),
        ("parts", legacy.id),
    ]
