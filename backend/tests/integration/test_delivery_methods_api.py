import pytest

from backend.app.models.customer import Customer, CustomerContact

pytestmark = pytest.mark.integration
URL = "/api/v1/delivery-methods"


@pytest.mark.asyncio
async def test_add_rename_reorder_and_delete_an_unused_method(committing_client):
    # Names no seed uses: the test database may hold the seeded reference already.
    a = (await committing_client.post(URL, json={"name": "  Kurier X "})).json()
    b = (await committing_client.post(URL, json={"name": "Post X"})).json()
    assert a["name"] == "Kurier X" and b["position"] > a["position"]
    renamed = await committing_client.patch(f"{URL}/{a['id']}", json={"name": "Courier X"})
    assert renamed.json()["name"] == "Courier X"
    everything = [m["id"] for m in (await committing_client.get(URL)).json()]
    wanted = [m for m in everything if m not in (a["id"], b["id"])] + [b["id"], a["id"]]
    ordered = (await committing_client.put(f"{URL}/order", json={"ids": wanted})).json()
    assert [m["id"] for m in ordered if m["id"] in (a["id"], b["id"])] == [b["id"], a["id"]]
    assert (await committing_client.delete(f"{URL}/{a['id']}")).status_code == 200
    assert a["id"] not in [m["id"] for m in (await committing_client.get(URL)).json()]


@pytest.mark.asyncio
async def test_a_name_is_unique_whatever_its_case(committing_client):
    await committing_client.post(URL, json={"name": "Нова пошта test"})
    assert (await committing_client.post(URL, json={"name": "НОВА ПОШТА TEST"})).status_code == 409
    other = (await committing_client.post(URL, json={"name": "Meest test"})).json()
    assert (await committing_client.patch(f"{URL}/{other['id']}", json={"name": "нова пошта test"})).status_code == 409
    assert (await committing_client.post(URL, json={"name": "   "})).status_code == 422


@pytest.mark.asyncio
async def test_a_method_in_use_counts_its_contacts_keeps_its_rename_and_refuses_deletion(committing_client, db_session):
    method = (await committing_client.post(URL, json={"name": "Nova Poshta"})).json()
    acme = Customer(name="ACME")
    db_session.add(acme)
    await db_session.flush()
    db_session.add(CustomerContact(customer_id=acme.id, position=0, name="Olena", delivery_method_id=method["id"]))
    await db_session.commit()
    listed = next(m for m in (await committing_client.get(URL)).json() if m["id"] == method["id"])
    assert listed["contacts_count"] == 1
    await committing_client.patch(f"{URL}/{method['id']}", json={"name": "Nova Poshta — branch"})
    contact = (await committing_client.get(f"/api/v1/customers/{acme.id}")).json()["contacts"][0]
    assert contact["delivery_method_name"] == "Nova Poshta — branch"  # read through the join
    r = await committing_client.delete(f"{URL}/{method['id']}")
    assert r.status_code == 409 and "1" in r.text


@pytest.mark.asyncio
async def test_the_order_must_name_every_method_once(committing_client):
    first = (await committing_client.post(URL, json={"name": "Order A"})).json()["id"]
    await committing_client.post(URL, json={"name": "Order B"})
    ids = [m["id"] for m in (await committing_client.get(URL)).json()]
    assert (await committing_client.put(f"{URL}/order", json={"ids": [first]})).status_code == 422  # one missing
    assert (await committing_client.put(f"{URL}/order", json={"ids": [*ids, first]})).status_code == 422  # twice
    assert (await committing_client.patch(f"{URL}/999999", json={"name": "Y"})).status_code == 404
