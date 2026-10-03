"""Catalog fields of a product (spec workshop-product-catalog, rules 13–15, 17)."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.api.routes import products as product_routes
from backend.app.models.library import LibraryFile
from backend.app.models.product import Product
from backend.app.models.product_category import ProductCategory, category_key

pytestmark = pytest.mark.integration

SLICED = {
    "sliced_for_model": "Bambu Lab X1 Carbon",
    "plates": [
        {
            "index": 1,
            "printable_objects": {"1": "hook.stl"},
            "filaments": [{"type": "PLA", "color": "#00ff00"}],
        }
    ],
}


@pytest.fixture
async def sliced_file(db_session):
    f = LibraryFile(filename="h.gcode.3mf", file_path="h", file_size=1, file_type="gcode", file_metadata=SLICED)
    db_session.add(f)
    await db_session.commit()
    await db_session.refresh(f)
    return f


@pytest.mark.asyncio
async def test_sku_is_unique_without_case_and_blank_is_none(committing_client):
    a = (await committing_client.post("/api/v1/products/", json={"name": "A", "sku": " LMP-01 "})).json()
    assert a["sku"] == "LMP-01" and a["status"] == "draft"
    dup = await committing_client.post("/api/v1/products/", json={"name": "B", "sku": "lmp-01"})
    assert dup.status_code == 409
    # Saving a product with its own SKU is not a clash with itself.
    assert (await committing_client.patch(f"/api/v1/products/{a['id']}", json={"sku": "lmp-01"})).status_code == 200
    cleared = (await committing_client.patch(f"/api/v1/products/{a['id']}", json={"sku": "  "})).json()
    assert cleared["sku"] is None
    # Two products without a SKU do not clash.
    assert (await committing_client.post("/api/v1/products/", json={"name": "C", "sku": ""})).status_code == 200


@pytest.mark.asyncio
async def test_ready_needs_parts_and_a_plate_and_draft_saves_anyway(committing_client):
    p = (await committing_client.post("/api/v1/products/", json={"name": "Bare"})).json()
    refused = await committing_client.patch(f"/api/v1/products/{p['id']}", json={"status": "ready", "version": "2"})
    assert refused.status_code == 409
    fresh = (await committing_client.get(f"/api/v1/products/{p['id']}")).json()
    assert fresh["version"] is None and fresh["status"] == "draft"  # the refused PATCH wrote nothing
    ok = await committing_client.patch(f"/api/v1/products/{p['id']}", json={"status": "draft", "version": "2"})
    assert ok.status_code == 200 and ok.json()["version"] == "2"
    assert (await committing_client.patch(f"/api/v1/products/{p['id']}", json={"status": None})).status_code == 422


@pytest.mark.asyncio
async def test_a_product_from_a_sliced_file_may_be_ready(committing_client, sliced_file):
    p = (await committing_client.post(f"/api/v1/products/from-file/{sliced_file.id}")).json()["product"]
    assert p["status"] == "draft"
    ready = await committing_client.patch(f"/api/v1/products/{p['id']}", json={"status": "ready"})
    assert ready.status_code == 200 and ready.json()["status"] == "ready"


@pytest.mark.asyncio
async def test_a_category_is_named_and_an_unknown_one_refused(committing_client):
    cat = (await committing_client.post("/api/v1/product-categories", json={"name": "Hooks"})).json()
    p = (await committing_client.post("/api/v1/products/", json={"name": "Hook", "category_id": cat["id"]})).json()
    assert p["category"] == {"id": cat["id"], "name": "Hooks"}
    listed = (await committing_client.get("/api/v1/products/")).json()
    assert next(r for r in listed if r["id"] == p["id"])["category"] == {"id": cat["id"], "name": "Hooks"}
    bad = await committing_client.patch(f"/api/v1/products/{p['id']}", json={"category_id": 999999})
    assert bad.status_code == 422
    uncategorized = await committing_client.patch(f"/api/v1/products/{p['id']}", json={"category_id": None})
    assert uncategorized.json()["category"] is None


@pytest.mark.asyncio
async def test_a_copy_keeps_version_and_category_but_not_the_sku(committing_client):
    cat = (await committing_client.post("/api/v1/product-categories", json={"name": "Copies"})).json()
    src = (
        await committing_client.post(
            "/api/v1/products/", json={"name": "Src", "sku": "SRC-1", "version": "3", "category_id": cat["id"]}
        )
    ).json()
    copy = (await committing_client.post(f"/api/v1/products/{src['id']}/duplicate", json={})).json()
    assert copy["sku"] is None and copy["version"] == "3" and copy["category"]["id"] == cat["id"]
    assert copy["status"] == "draft"


@pytest.mark.asyncio
async def test_a_plate_names_its_printer_model(committing_client, sliced_file):
    p = (await committing_client.post(f"/api/v1/products/from-file/{sliced_file.id}")).json()["product"]
    plates = (await committing_client.get(f"/api/v1/products/{p['id']}/plates")).json()
    assert [pl["printer_model"] for pl in plates] == ["X1C"]


@pytest.mark.asyncio
async def test_ready_counts_only_plates_outside_the_trash(committing_client, db_session, sliced_file):
    # What the row, the card and the dialog show: a plate of a trashed file is no plate.
    p = (await committing_client.post(f"/api/v1/products/from-file/{sliced_file.id}")).json()["product"]
    await db_session.execute(
        update(LibraryFile).where(LibraryFile.id == sliced_file.id).values(deleted_at=datetime.now(UTC))
    )
    await db_session.commit()
    refused = await committing_client.patch(f"/api/v1/products/{p['id']}", json={"status": "ready"})
    assert refused.status_code == 409


@pytest.mark.asyncio
async def test_a_sku_that_lost_a_race_is_409_not_500(committing_client, monkeypatch):
    # Two saves pass the check at once; the unique index decides — and says so as a 409.
    async def no_clash(db, key, product_id):
        return None

    monkeypatch.setattr(product_routes, "_sku_clash", no_clash)
    assert (await committing_client.post("/api/v1/products/", json={"name": "A", "sku": "RACE"})).status_code == 200
    second = await committing_client.post("/api/v1/products/", json={"name": "B", "sku": "race"})
    assert second.status_code == 409, second.text
    b = (await committing_client.post("/api/v1/products/", json={"name": "C"})).json()
    patched = await committing_client.patch(f"/api/v1/products/{b['id']}", json={"sku": "RACE"})
    assert patched.status_code == 409, patched.text


def test_the_folded_keys_fit_their_columns():
    # casefold() may lengthen a string up to three times ("ß" → "ss", "ΐ" → three
    # characters); PostgreSQL refuses a value longer than the column.
    assert Product.__table__.c.sku_key.type.length >= 3 * 64
    assert ProductCategory.__table__.c.name_key.type.length >= 3 * 128


@pytest.mark.asyncio
async def test_a_response_loads_a_category_the_session_never_saw(test_engine):
    maker = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    async with maker() as db:
        cat = ProductCategory(name="Fresh", name_key=category_key("Fresh"))
        db.add(cat)
        await db.commit()
        cid = cat.id
    async with maker() as db:
        p = Product(name="New row", category_id=cid)
        db.add(p)
        await db.flush()
        out = await product_routes._response(db, p)
    assert out.category is not None and out.category.name == "Fresh"
