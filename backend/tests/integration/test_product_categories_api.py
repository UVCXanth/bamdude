"""The product category directory (spec workshop-product-catalog, rules 2 and 16)."""

import pytest

from backend.app.models.product import Product

pytestmark = pytest.mark.integration


@pytest.mark.asyncio
async def test_create_rename_list_and_refuse_a_duplicate(committing_client):
    made = (await committing_client.post("/api/v1/product-categories", json={"name": " Лампи "})).json()
    assert made["name"] == "Лампи" and made["products_count"] == 0
    dup = await committing_client.post("/api/v1/product-categories", json={"name": " ЛАМПИ "})
    assert dup.status_code == 409
    renamed = await committing_client.patch(f"/api/v1/product-categories/{made['id']}", json={"name": "Світильники"})
    assert renamed.json()["name"] == "Світильники"
    # Renaming to its own name in another case is not a clash with itself.
    same = await committing_client.patch(f"/api/v1/product-categories/{made['id']}", json={"name": "світильники"})
    assert same.status_code == 200
    names = [c["name"] for c in (await committing_client.get("/api/v1/product-categories")).json()]
    assert names == ["світильники"]


@pytest.mark.asyncio
async def test_a_blank_name_is_refused(committing_client):
    assert (await committing_client.post("/api/v1/product-categories", json={"name": "   "})).status_code == 422


@pytest.mark.asyncio
async def test_the_list_counts_products_and_sorts_by_name(committing_client, db_session):
    b = (await committing_client.post("/api/v1/product-categories", json={"name": "b"})).json()
    await committing_client.post("/api/v1/product-categories", json={"name": "A"})
    db_session.add_all([Product(name="One", category_id=b["id"]), Product(name="Two", category_id=b["id"])])
    await db_session.commit()
    listing = (await committing_client.get("/api/v1/product-categories")).json()
    assert [(c["name"], c["products_count"]) for c in listing] == [("A", 0), ("b", 2)]


@pytest.mark.asyncio
async def test_deleting_a_category_leaves_its_products_uncategorized(committing_client, db_session):
    cat = (await committing_client.post("/api/v1/product-categories", json={"name": "Temp"})).json()
    p = Product(name="Kept", category_id=cat["id"])
    db_session.add(p)
    await db_session.commit()
    gone = await committing_client.delete(f"/api/v1/product-categories/{cat['id']}")
    assert gone.status_code == 200 and gone.json()["uncategorized"] == 1
    await db_session.refresh(p)
    assert p.category_id is None
    assert (await committing_client.delete(f"/api/v1/product-categories/{cat['id']}")).status_code == 404


@pytest.mark.asyncio
async def test_a_name_that_lost_a_race_is_409_not_500(committing_client, monkeypatch):
    from backend.app.api.routes import product_categories

    async def no_duplicate(db, name, own_id=None):
        return None

    monkeypatch.setattr(product_categories, "_refuse_duplicate", no_duplicate)
    assert (await committing_client.post("/api/v1/product-categories", json={"name": "Race"})).status_code == 200
    assert (await committing_client.post("/api/v1/product-categories", json={"name": "RACE"})).status_code == 409
    other = (await committing_client.post("/api/v1/product-categories", json={"name": "Other"})).json()
    renamed = await committing_client.patch(f"/api/v1/product-categories/{other['id']}", json={"name": "race"})
    assert renamed.status_code == 409
