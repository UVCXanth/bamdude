"""A customer's issues, the waybill afterwards, a manual issue names its customer
(spec workshop-order-issue, rules 16, 21, 22)."""

import pytest
from sqlalchemy import select

from backend.app.models.customer import Customer, CustomerContact, DeliveryMethod
from backend.app.models.finished_stock import StockItemMovement
from backend.app.models.product import Product
from backend.app.models.project import Project
from backend.app.models.project_line import ProjectLine
from backend.app.models.stock_issue import StockIssue
from backend.app.services import finished_stock, line_config

pytestmark = pytest.mark.integration


@pytest.fixture
async def shop(db_session):
    """Lamp with 6 ready; Acme (main contact Ivan, Nova Poshta) with two orders; Beta."""
    lamp = Product(name="Lamp")
    post = DeliveryMethod(name="Nova Poshta", name_key="nova poshta")
    acme, beta = Customer(name="Acme"), Customer(name="Beta")
    db_session.add_all([lamp, post, acme, beta])
    await db_session.flush()
    db_session.add(
        CustomerContact(customer_id=acme.id, name="Ivan", phone="+380", delivery_method_id=post.id, position=0)
    )
    position = await finished_stock.item_for(db_session, lamp.id, {}, create=True)
    await finished_stock.receive(db_session, position, 6)
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


async def _issue_order(client, order, line, units):
    body = {"lines": [{"line_id": line.id, "issue": units}], "waybill": None}
    r = await client.post(f"/api/v1/projects/{order.id}/fulfilment", json=body)
    assert r.status_code == 200, r.text
    return r.json()["issue_id"]


async def _manual(client, shop, customer_id, **extra):
    body = {"kind": "issue", "item_id": shop["position"].id, "qty": 1, "customer_id": customer_id, **extra}
    return await client.post("/api/v1/stock/moves", json=body)


@pytest.mark.asyncio
async def test_a_customers_issues_newest_first_paged(committing_client, db_session, shop):
    (o1, l1), (o2, l2) = shop["orders"]
    first = await _issue_order(committing_client, o1, l1, 2)
    second = await _issue_order(committing_client, o2, l2, 1)
    assert (await _manual(committing_client, shop, shop["acme"].id)).status_code == 200
    assert (await _manual(committing_client, shop, shop["beta"].id)).status_code == 200
    url = f"/api/v1/customers/{shop['acme'].id}/issues"
    page = (await committing_client.get(url, params={"page": 1, "per_page": 2})).json()
    assert page["meta"]["total"] == 3
    manual, from_o2 = page["items"]
    assert (manual["project_id"], manual["project_code"], manual["units"]) == (None, None, 1)
    assert (manual["recipient_name"], manual["delivery_method"], manual["created_by_name"]) == (
        "Ivan",
        "Nova Poshta",
        "test_admin",
    )
    assert (from_o2["id"], from_o2["project_id"], from_o2["project_code"], from_o2["units"]) == (
        second,
        o2.id,
        f"OR-{o2.id:04d}",
        1,
    )
    [from_o1] = (await committing_client.get(url, params={"page": 2, "per_page": 2})).json()["items"]
    assert (from_o1["id"], from_o1["units"]) == (first, 2)
    assert (await committing_client.get("/api/v1/customers/999999/issues")).status_code == 404


@pytest.mark.asyncio
async def test_the_waybill_is_written_afterwards(committing_client, db_session, shop):
    (o1, l1), _ = shop["orders"]
    issue_id = await _issue_order(committing_client, o1, l1, 2)
    r = await committing_client.patch(f"/api/v1/stock-issues/{issue_id}", json={"waybill": "20450000000001"})
    assert r.status_code == 200, r.text
    assert (r.json()["waybill"], r.json()["units"]) == ("20450000000001", 2)
    assert (
        await committing_client.patch(f"/api/v1/stock-issues/{issue_id}", json={"waybill": "1" * 25})
    ).status_code == 422
    r = await committing_client.patch(f"/api/v1/stock-issues/{issue_id}", json={"note": "left at the door"})
    issue = await db_session.get(StockIssue, issue_id, populate_existing=True)
    assert (issue.waybill, issue.note) == ("20450000000001", "left at the door")
    assert (await committing_client.patch("/api/v1/stock-issues/999999", json={"note": "x"})).status_code == 404


@pytest.mark.asyncio
async def test_a_manual_issue_names_its_customer(committing_client, db_session, shop):
    r = await _manual(committing_client, shop, None)
    assert (r.status_code, r.json()["detail"]) == (422, "An issue names its customer")
    r = await _manual(committing_client, shop, shop["acme"].id, waybill="TTN-9")
    assert r.status_code == 200, r.text
    [issue] = (await db_session.execute(select(StockIssue))).scalars().all()
    assert (issue.customer_id, issue.project_id, issue.recipient_name, issue.recipient_phone, issue.waybill) == (
        shop["acme"].id,
        None,
        "Ivan",
        "+380",
        "TTN-9",
    )
    move = (
        await db_session.execute(select(StockItemMovement).where(StockItemMovement.stock_issue_id == issue.id))
    ).scalar_one()
    assert (move.kind, move.delta_on_hand, move.customer_id) == ("issue", -1, shop["acme"].id)


@pytest.mark.asyncio
async def test_a_manual_issue_takes_the_recipient_it_is_given(committing_client, db_session, shop):
    recipient = {"name": "Olena", "phone": "+38067", "delivery_method": "Pickup", "delivery_details": None}
    r = await _manual(committing_client, shop, shop["acme"].id, recipient=recipient)
    assert r.status_code == 200, r.text
    issue = (await db_session.execute(select(StockIssue))).scalar_one()
    assert (issue.recipient_name, issue.delivery_method) == ("Olena", "Pickup")
