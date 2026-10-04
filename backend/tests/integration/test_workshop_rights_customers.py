"""Customers as the other domains need them, and the customer delete's consequence (WS-13 E13 T15).

An order form, an orders filter and a stock issue need a customer's NAME, and a form its
contacts' names and roles — not the directory's phones, addresses and money. Those reads have
narrow doors of their own. The shipping right sees a recipient's address. Deleting a customer
who still has active orders detaches them and changes how they close, so it asks
``orders:update`` too (O24); without such orders ``customers:delete`` is enough.
"""

import pytest
from httpx import AsyncClient

from backend.tests.integration.test_workshop_library_rights import _jwt, _user

pytestmark = pytest.mark.integration


@pytest.fixture
async def acme(committing_client: AsyncClient):
    created = await committing_client.post(
        "/api/v1/customers/",
        json={
            "name": "Acme Rights",
            "contacts": [{"name": "Ann", "role": "buyer", "phone": "+380501112233", "delivery_details": "Kyiv, 1"}],
        },
    )
    assert created.status_code in (200, 201), created.text
    return created.json()


@pytest.mark.asyncio
async def test_the_customer_picker_names_customers_for_whoever_needs_one(committing_client, db_session, acme):
    await _user(db_session, "cu_orders", ["orders:read"])
    await _user(db_session, "cu_none", ["inventory:read"])
    rows = await committing_client.get("/api/v1/customers/options", params={"q": "Acme"}, headers=_jwt("cu_orders"))
    assert rows.status_code == 200, rows.text
    [row] = [r for r in rows.json() if r["id"] == acme["id"]]
    assert row == {"id": acme["id"], "code": acme["code"], "name": "Acme Rights"}
    assert (await committing_client.get("/api/v1/customers/options", headers=_jwt("cu_none"))).status_code == 403
    assert (await committing_client.get("/api/v1/customers/", headers=_jwt("cu_orders"))).status_code == 403


@pytest.mark.asyncio
async def test_an_order_form_lists_a_customers_contacts_by_name_and_role(committing_client, db_session, acme):
    await _user(db_session, "cu_creator", ["orders:read", "orders:create"])
    rows = await committing_client.get(f"/api/v1/customers/{acme['id']}/contact-options", headers=_jwt("cu_creator"))
    assert rows.status_code == 200, rows.text
    [contact] = rows.json()
    assert set(contact) == {"id", "code", "name", "role"}
    assert contact["name"] == "Ann"
    assert (await committing_client.get("/api/v1/customers/999999/contact-options")).status_code == 404


@pytest.mark.asyncio
async def test_the_shipping_right_sees_the_recipients_address(committing_client, db_session, acme):
    await _user(db_session, "cu_shipper", ["stock:read", "stock:move"])
    await _user(db_session, "cu_reader", ["orders:read", "stock:read"])
    shipped = await committing_client.get(f"/api/v1/customers/{acme['id']}/recipient", headers=_jwt("cu_shipper"))
    assert shipped.status_code == 200, shipped.text
    assert shipped.json()["phone"] == "+380501112233"
    assert shipped.json()["delivery_details"] == "Kyiv, 1"
    assert (
        await committing_client.get(f"/api/v1/customers/{acme['id']}/recipient", headers=_jwt("cu_reader"))
    ).status_code == 403


@pytest.mark.asyncio
async def test_the_delivery_methods_are_listed_for_their_writers_too(committing_client, db_session):
    await _user(db_session, "cu_maker", ["customers:create"])
    await _user(db_session, "cu_nobody", ["inventory:read"])
    assert (await committing_client.get("/api/v1/delivery-methods/", headers=_jwt("cu_maker"))).status_code == 200
    assert (await committing_client.get("/api/v1/delivery-methods/", headers=_jwt("cu_nobody"))).status_code == 403


@pytest.mark.asyncio
async def test_deleting_a_customer_with_active_orders_asks_the_orders_right(committing_client, db_session, acme):
    order = await committing_client.post("/api/v1/projects/", json={"name": "Acme order", "customer_id": acme["id"]})
    assert order.status_code in (200, 201), order.text
    await _user(db_session, "cu_deleter", ["customers:read", "customers:delete"])
    await _user(db_session, "cu_deleter_orders", ["customers:read", "customers:delete", "orders:update"])

    refused = await committing_client.delete(f"/api/v1/customers/{acme['id']}", headers=_jwt("cu_deleter"))
    assert refused.status_code == 403
    assert refused.json()["detail"]["error"] == "consequence_right_required"
    assert refused.json()["detail"]["right"] == "orders:update"
    kept = (await committing_client.get(f"/api/v1/projects/{order.json()['id']}")).json()
    assert kept["customer_id"] == acme["id"]

    done = await committing_client.delete(f"/api/v1/customers/{acme['id']}", headers=_jwt("cu_deleter_orders"))
    assert done.status_code == 200, done.text


@pytest.mark.asyncio
async def test_a_customer_without_active_orders_needs_only_the_delete(committing_client, db_session, acme):
    await _user(db_session, "cu_plain_deleter", ["customers:read", "customers:delete"])
    done = await committing_client.delete(f"/api/v1/customers/{acme['id']}", headers=_jwt("cu_plain_deleter"))
    assert done.status_code == 200, done.text
