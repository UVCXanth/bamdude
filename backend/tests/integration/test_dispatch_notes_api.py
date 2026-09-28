"""Dispatch notes on the wire — one list, the document, the codes in answers (spec workshop-dispatch-notes, rules 12–18)."""

from datetime import datetime

import pytest
from sqlalchemy import update

from backend.app.models.customer import Customer, CustomerContact, DeliveryMethod
from backend.app.models.product import Product
from backend.app.models.project import Project
from backend.app.models.project_line import ProjectLine
from backend.app.models.stock_issue import StockIssue
from backend.app.services import finished_stock, line_config

pytestmark = pytest.mark.integration


@pytest.fixture
async def shop(db_session):
    """Lamp (SKU LMP-1) with 9 ready; Acme (Ivan, Nova Poshta) with two orders reserving 2 and 1; Beta."""
    lamp = Product(name="Lamp", sku="LMP-1")
    post = DeliveryMethod(name="Nova Poshta", name_key="nova poshta")
    acme, beta = Customer(name="Acme"), Customer(name="Beta")
    db_session.add_all([lamp, post, acme, beta])
    await db_session.flush()
    db_session.add(
        CustomerContact(customer_id=acme.id, name="Ivan", phone="+380", delivery_method_id=post.id, position=0)
    )
    position = await finished_stock.item_for(db_session, lamp.id, {}, create=True)
    await finished_stock.receive(db_session, position, 9)
    orders = []
    for quantity in (2, 1):
        order = Project(name=f"O{quantity}", customer_id=acme.id)
        db_session.add(order)
        await db_session.flush()
        line = ProjectLine(project_id=order.id, product_id=lamp.id, quantity=quantity)
        db_session.add(line)
        await db_session.flush()
        await line_config.seed_line(db_session, line, choices=None, counts=None)
        assert await finished_stock.reserve_for_line(db_session, line, quantity) == quantity
        orders.append((order, line))
    await db_session.commit()
    return {"lamp": lamp, "acme": acme, "beta": beta, "position": position, "orders": orders}


async def _issue_order(client, order, line, units, waybill=None):
    # The dialog sends the recipient it shows (the order's contact, prefilled from the state).
    recipient = {"name": "Ivan", "phone": "+380", "delivery_method": "Nova Poshta", "delivery_details": None}
    body = {"lines": [{"line_id": line.id, "issue": units}], "waybill": waybill, "recipient": recipient}
    r = await client.post(f"/api/v1/projects/{order.id}/fulfilment", json=body)
    assert r.status_code == 200, r.text
    assert r.json()["issue_code"] == f"DN-{r.json()['issue_id']:04d}"
    return r.json()["issue_id"]


async def _manual(client, shop, customer_id, **extra):
    body = {"kind": "issue", "item_id": shop["position"].id, "qty": 1, "customer_id": customer_id, **extra}
    r = await client.post("/api/v1/stock/moves", json=body)
    assert r.status_code == 200, r.text
    return r.json()["issue_id"]


async def _list(client, **params):
    r = await client.get("/api/v1/stock-issues/", params=params)
    assert r.status_code == 200, r.text
    return r.json()


@pytest.mark.asyncio
async def test_one_list_filters_by_customer_and_order(committing_client, db_session, shop):
    (o1, l1), (o2, l2) = shop["orders"]
    first = await _issue_order(committing_client, o1, l1, 2)
    second = await _issue_order(committing_client, o2, l2, 1)
    manual = await _manual(committing_client, shop, shop["acme"].id)
    other = await _manual(committing_client, shop, shop["beta"].id)
    page = await _list(committing_client, customer_id=shop["acme"].id, page=1, per_page=2)
    assert page["meta"]["total"] == 3
    assert [row["id"] for row in page["items"]] == [manual, second]
    row = page["items"][1]
    assert (row["code"], row["order_code"], row["order_name"], row["units"], row["lines_count"]) == (
        f"DN-{second:04d}",
        f"OR-{o2.id:04d}",
        "O1",
        1,
        1,
    )
    assert row["summary"] == [{"product_name": "Lamp", "part_name": None, "quantity": 1}]
    assert (row["recipient_name"], row["delivery_method"], row["created_by_name"]) == (
        "Ivan",
        "Nova Poshta",
        "test_admin",
    )
    assert [r["id"] for r in (await _list(committing_client, project_id=o1.id, page=1))["items"]] == [first]
    assert (await _list(committing_client, page=1))["meta"]["total"] == 4
    beta_rows = (await _list(committing_client, customer_id=shop["beta"].id, page=1))["items"]
    assert [r["id"] for r in beta_rows] == [other]


@pytest.mark.asyncio
async def test_search_reads_codes_names_and_lines(committing_client, db_session, shop):
    (o1, l1), (o2, l2) = shop["orders"]
    first = await _issue_order(committing_client, o1, l1, 2, waybill="20450000000001")
    second = await _issue_order(committing_client, o2, l2, 1)
    manual = await _manual(committing_client, shop, shop["beta"].id)

    async def ids(q):
        return [r["id"] for r in (await _list(committing_client, q=q, page=1, sort_by="code-asc"))["items"]]

    assert await ids(f"DN-{second:04d}") == [second]
    assert await ids(f"dn{second}") == [second]
    assert await ids(f"OR-{o1.id}") == [first]
    assert await ids("2045000") == [first]
    assert await ids("beta") == [manual]
    assert await ids("lmp-1") == [first, second, manual]
    assert await ids("ivan") == [first, second]
    assert await ids("nothing like it") == []


@pytest.mark.asyncio
async def test_search_takes_wildcards_literally(committing_client, db_session, shop):
    await _manual(committing_client, shop, shop["acme"].id)
    for q in ("%", "_", "\\"):
        assert (await _list(committing_client, q=q, page=1))["meta"]["total"] == 0


@pytest.mark.asyncio
async def test_sorting_by_customer_and_units(committing_client, db_session, shop):
    (o1, l1), _ = shop["orders"]
    big = await _issue_order(committing_client, o1, l1, 2)
    beta = await _manual(committing_client, shop, shop["beta"].id)
    by_units = [r["id"] for r in (await _list(committing_client, page=1, sort_by="units-desc"))["items"]]
    assert by_units == [big, beta]
    by_customer = [r["id"] for r in (await _list(committing_client, page=1, sort_by="customer-desc"))["items"]]
    assert by_customer == [beta, big]
    # An unknown key is the default, newest first.
    assert (await _list(committing_client, page=1, sort_by="nonsense-up"))["items"][0]["id"] == beta


@pytest.mark.asyncio
async def test_pages_never_overlap_on_equal_times(committing_client, db_session, shop):
    ids = [await _manual(committing_client, shop, shop["acme"].id) for _ in range(5)]
    await db_session.execute(update(StockIssue).values(created_at=datetime(2026, 9, 28, 12, 0, 0)))
    await db_session.commit()
    seen = []
    for page in (1, 2, 3):
        seen += [r["id"] for r in (await _list(committing_client, page=page, per_page=2))["items"]]
    assert sorted(seen) == sorted(ids)
    assert len(seen) == len(set(seen))


@pytest.mark.asyncio
async def test_the_document_is_the_snapshot(committing_client, db_session, shop):
    (o1, l1), _ = shop["orders"]
    r = await committing_client.patch("/api/v1/settings/", json={"document_supplier_name": "BamDude Workshop"})
    assert r.status_code == 200, r.text
    issue_id = await _issue_order(committing_client, o1, l1, 2)
    await committing_client.patch("/api/v1/settings/", json={"document_supplier_name": "Changed"})
    r = await committing_client.get(f"/api/v1/stock-issues/{issue_id}")
    assert r.status_code == 200, r.text
    note = r.json()
    assert note["code"] == f"DN-{issue_id:04d}"
    assert note["supplier"] == {"name": "BamDude Workshop", "address": "", "phone": "", "code": "", "iban": ""}
    assert note["lines"] == [
        {
            "position": 1,
            "product_id": shop["lamp"].id,
            "product_name": "Lamp",
            "sku": "LMP-1",
            "configuration": {"choices": [], "changed_parts": []},
            "part_name": None,
            "quantity": 2,
        }
    ]
    r = await committing_client.get("/api/v1/stock-issues/999999")
    assert (r.status_code, r.json()["detail"]) == (404, "Dispatch note not found")


@pytest.mark.asyncio
async def test_editing_the_waybill_leaves_the_document_alone(committing_client, db_session, shop):
    (o1, l1), _ = shop["orders"]
    issue_id = await _issue_order(committing_client, o1, l1, 2)
    before = (await committing_client.get(f"/api/v1/stock-issues/{issue_id}")).json()
    r = await committing_client.patch(f"/api/v1/stock-issues/{issue_id}", json={"waybill": "TTN-7", "note": "door"})
    assert r.status_code == 200, r.text
    assert (r.json()["waybill"], r.json()["units"], r.json()["code"]) == ("TTN-7", 2, f"DN-{issue_id:04d}")
    after = (await committing_client.get(f"/api/v1/stock-issues/{issue_id}")).json()
    unchanged = {"waybill", "note"}
    assert {k: v for k, v in after.items() if k not in unchanged} == {
        k: v for k, v in before.items() if k not in unchanged
    }
    too_long = await committing_client.patch(f"/api/v1/stock-issues/{issue_id}", json={"waybill": "1" * 25})
    assert too_long.status_code == 422
    assert (await committing_client.patch("/api/v1/stock-issues/999999", json={"note": "x"})).status_code == 404


@pytest.mark.asyncio
async def test_a_manual_issue_names_its_customer(committing_client, db_session, shop):
    body = {"kind": "issue", "item_id": shop["position"].id, "qty": 1, "customer_id": None}
    r = await committing_client.post("/api/v1/stock/moves", json=body)
    assert (r.status_code, r.json()["detail"]) == (422, "An issue names its customer")


@pytest.mark.asyncio
async def test_the_customer_issues_route_is_gone(committing_client, db_session, shop):
    r = await committing_client.get(f"/api/v1/customers/{shop['acme'].id}/issues")
    assert r.status_code in (404, 405)
