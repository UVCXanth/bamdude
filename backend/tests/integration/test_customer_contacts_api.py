import pytest
from sqlalchemy import select

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


@pytest.mark.asyncio
async def test_saving_syncs_contacts_by_id_in_the_order_given(committing_client, db_session):
    acme, first, second = await _acme(db_session)
    first_id = first.id  # read now: after expire_all() a lazy refresh would need the event loop
    payload = {
        "contacts": [
            {"id": second.id, "name": "Serhii K.", "role": "Warehouse"},  # now the main one
            {"name": "  New  ", "phone": " "},  # created; blanks become null
            {"name": "", "email": "   "},  # every field empty: dropped
        ]
    }
    r = await committing_client.patch(f"/api/v1/customers/{acme.id}", json=payload)
    assert r.status_code == 200, r.text
    contacts = r.json()["contacts"]
    assert [c["name"] for c in contacts] == ["Serhii K.", "New"]
    assert contacts[0]["id"] == second.id and contacts[1]["phone"] is None
    # ``first`` was left out: removed, and the order that named it lost its contact.
    db_session.expire_all()
    order = (await db_session.execute(select(Project).where(Project.name == "A"))).scalar_one()
    assert order.contact_id is None
    assert await db_session.get(CustomerContact, first_id) is None


@pytest.mark.asyncio
async def test_a_patch_without_contacts_leaves_them_alone(committing_client, db_session):
    acme, first, second = await _acme(db_session)
    r = await committing_client.patch(f"/api/v1/customers/{acme.id}", json={"notes": "x"})
    assert [c["id"] for c in r.json()["contacts"]] == [first.id, second.id]
    assert (await committing_client.patch(f"/api/v1/customers/{acme.id}", json={"contacts": None})).status_code == 422


@pytest.mark.asyncio
async def test_a_foreign_or_repeated_contact_or_an_unknown_method_is_refused(committing_client, db_session):
    acme, first, _ = await _acme(db_session)
    other = Customer(name="Beta")
    db_session.add(other)
    await db_session.flush()
    stranger = CustomerContact(customer_id=other.id, position=0, name="Stranger")
    db_session.add(stranger)
    await db_session.commit()
    url = f"/api/v1/customers/{acme.id}"
    for contacts in (
        [{"id": stranger.id, "name": "x"}],
        [{"id": first.id, "name": "a"}, {"id": first.id, "name": "b"}],
        [{"name": "x", "delivery_method_id": 999999}],
    ):
        r = await committing_client.patch(url, json={"contacts": contacts})
        assert r.status_code == 422, (contacts, r.text)
    # Nothing moved on a refusal.
    assert [c["id"] for c in (await committing_client.get(url)).json()["contacts"]][0] == first.id


@pytest.mark.asyncio
async def test_create_takes_contacts_and_delete_takes_them_away(committing_client, db_session):
    r = await committing_client.post(
        "/api/v1/customers", json={"name": "Gamma", "contacts": [{"name": "Ira", "email": "ira@g.ua"}]}
    )
    assert r.status_code == 200, r.text
    cid, contact_id = r.json()["id"], r.json()["contacts"][0]["id"]
    db_session.add(Project(name="G", customer_id=cid, contact_id=contact_id))
    await db_session.commit()
    assert (await committing_client.delete(f"/api/v1/customers/{cid}")).status_code == 200
    db_session.expire_all()
    order = (await db_session.execute(select(Project).where(Project.name == "G"))).scalar_one()
    assert order.customer_id is None and order.contact_id is None
    assert await db_session.get(CustomerContact, contact_id) is None
