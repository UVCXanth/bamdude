import pytest

from backend.app.models.customer import Customer, CustomerContact, DeliveryMethod
from backend.app.models.project import Project

pytestmark = pytest.mark.integration


async def _acme(db_session):
    post = DeliveryMethod(name="Nova Poshta", name_key="nova poshta", position=0)
    acme = Customer(name="ACME")
    db_session.add_all([post, acme])
    await db_session.flush()
    second = CustomerContact(customer_id=acme.id, position=1, name="Serhii", role="Warehouse", phone="+380 50 1")
    first = CustomerContact(
        customer_id=acme.id,
        position=0,
        name="Olena",
        email="olena@acme.ua",
        city="Kyiv",
        delivery_method_id=post.id,
        delivery_details="branch 12",
        note="call first",
    )
    db_session.add_all([second, first])
    await db_session.flush()
    db_session.add(Project(name="A", customer_id=acme.id, contact_id=first.id))
    await db_session.commit()
    return acme, first, second


@pytest.mark.asyncio
async def test_a_customer_carries_code_kind_and_its_contacts_main_first(async_client, db_session):
    acme, first, second = await _acme(db_session)
    body = (await async_client.get(f"/api/v1/customers/{acme.id}")).json()
    assert body["code"] == f"CU-{acme.id:04d}" and body["kind"] == "company" and "contact" not in body
    assert [c["id"] for c in body["contacts"]] == [first.id, second.id]
    main = body["contacts"][0]
    assert main["code"] == f"CT-{first.id:04d}"
    assert main["delivery_method_name"] == "Nova Poshta" and main["delivery_details"] == "branch 12"
    assert main["note"] == "call first" and main["orders_count"] == 1
    assert body["contacts"][1]["orders_count"] == 0


@pytest.mark.asyncio
async def test_the_flat_list_and_the_page_carry_the_contacts_too(async_client, db_session):
    acme, first, _ = await _acme(db_session)
    flat = (await async_client.get("/api/v1/customers/")).json()
    paged = (await async_client.get("/api/v1/customers/?page=1")).json()["items"]
    for rows in (flat, paged):
        assert rows[0]["contacts"][0]["id"] == first.id and rows[0]["contacts"][0]["orders_count"] == 1


@pytest.mark.asyncio
async def test_search_reaches_every_contact_field_and_folds_cyrillic_case(async_client, db_session):
    await _acme(db_session)
    other = Customer(name="Beta")
    db_session.add(other)
    await db_session.flush()
    db_session.add(CustomerContact(customer_id=other.id, position=0, name="Олена Коваль", note="склад"))
    await db_session.commit()
    for q, expected in (("СКЛАД", ["Beta"]), ("acme.ua", ["ACME"]), ("+380 50", ["ACME"]), ("call first", ["ACME"])):
        # ``params``, never an f-string URL: a literal "+" in a query string is a space.
        items = (await async_client.get("/api/v1/customers/", params={"page": 1, "q": q})).json()["items"]
        assert [c["name"] for c in items] == expected, q


@pytest.mark.asyncio
async def test_kind_is_set_on_create_and_never_cleared_by_null(committing_client):
    r = await committing_client.post("/api/v1/customers", json={"name": "Solo", "kind": "private"})
    assert r.status_code == 200 and r.json()["kind"] == "private" and r.json()["contacts"] == []
    cid = r.json()["id"]
    assert (await committing_client.patch(f"/api/v1/customers/{cid}", json={"kind": None})).status_code == 422
    assert (await committing_client.patch(f"/api/v1/customers/{cid}", json={"kind": "wholesale"})).status_code == 422
    patched = await committing_client.patch(f"/api/v1/customers/{cid}", json={"kind": "regular"})
    assert patched.json()["kind"] == "regular"
