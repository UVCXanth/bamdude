import pytest

from backend.app.models.customer import Customer, CustomerContact
from backend.app.models.product import Product

pytestmark = pytest.mark.integration


async def _two_customers(db_session):
    acme, beta = Customer(name="ACME"), Customer(name="Beta")
    db_session.add_all([acme, beta])
    await db_session.flush()
    olena = CustomerContact(customer_id=acme.id, position=0, name="Olena", phone="+380 1")
    ira = CustomerContact(customer_id=beta.id, position=0, name="Ira")
    db_session.add_all([olena, ira])
    await db_session.commit()
    return acme.id, beta.id, olena.id, ira.id


@pytest.mark.asyncio
async def test_an_order_names_a_contact_of_its_own_customer(committing_client, db_session):
    acme, beta, olena, ira = await _two_customers(db_session)
    r = await committing_client.post("/api/v1/projects", json={"name": "O1", "customer_id": acme, "contact_id": olena})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["code"] == f"OR-{body['id']:04d}"
    assert body["contact"] == {
        "id": olena,
        "code": f"CT-{olena:04d}",
        "name": "Olena",
        "role": None,
        "phone": "+380 1",
        "email": None,
    }
    foreign = await committing_client.post(
        "/api/v1/projects", json={"name": "O2", "customer_id": acme, "contact_id": ira}
    )
    assert foreign.status_code == 422
    lonely = await committing_client.post("/api/v1/projects", json={"name": "O3", "contact_id": olena})
    assert lonely.status_code == 422


@pytest.mark.asyncio
async def test_moving_the_order_to_another_customer_clears_its_contact(committing_client, db_session):
    acme, beta, olena, ira = await _two_customers(db_session)
    oid = (
        await committing_client.post("/api/v1/projects", json={"name": "O", "customer_id": acme, "contact_id": olena})
    ).json()["id"]
    moved = (await committing_client.patch(f"/api/v1/projects/{oid}", json={"customer_id": beta})).json()
    assert moved["customer_id"] == beta and moved["contact_id"] is None and moved["contact"] is None
    picked = await committing_client.patch(f"/api/v1/projects/{oid}", json={"contact_id": ira})
    assert picked.status_code == 200 and picked.json()["contact_id"] == ira
    assert (await committing_client.patch(f"/api/v1/projects/{oid}", json={"contact_id": olena})).status_code == 422
    same = (await committing_client.patch(f"/api/v1/projects/{oid}", json={"customer_id": beta, "name": "O!"})).json()
    assert same["contact_id"] == ira  # re-sending the same customer is not a move


@pytest.mark.asyncio
async def test_a_duplicate_keeps_the_contact(committing_client, db_session):
    acme, _, olena, _ = await _two_customers(db_session)
    oid = (
        await committing_client.post("/api/v1/projects", json={"name": "O", "customer_id": acme, "contact_id": olena})
    ).json()["id"]
    copy = (await committing_client.post(f"/api/v1/projects/{oid}/duplicate", json={})).json()
    assert copy["contact_id"] == olena


@pytest.mark.asyncio
async def test_orders_and_products_carry_codes_and_are_found_by_them(committing_client, db_session):
    first = (await committing_client.post("/api/v1/projects", json={"name": "Lamp run"})).json()
    await committing_client.post("/api/v1/projects", json={"name": "Vase run"})
    page = (await committing_client.get("/api/v1/projects/", params={"page": 1, "q": f"OR-{first['id']:04d}"})).json()
    assert [o["name"] for o in page["items"]] == ["Lamp run"]
    assert page["items"][0]["code"] == f"OR-{first['id']:04d}"
    product = Product(name="Lamp")
    db_session.add_all([product, Product(name="Vase")])
    await db_session.commit()
    product_id = product.id
    items = (await committing_client.get("/api/v1/products/", params={"page": 1, "q": f"pr{product_id}"})).json()[
        "items"
    ]
    assert [p["name"] for p in items] == ["Lamp"] and items[0]["code"] == f"PR-{product_id:04d}"
    detail = (await committing_client.get(f"/api/v1/products/{product_id}")).json()
    assert detail["code"] == f"PR-{product_id:04d}"
