"""The catalog list: word search, filters, category counts, facets, the draft badge
(spec workshop-product-catalog, rules 8–12 and 18)."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import select, update

from backend.app.models.library import LibraryFile
from backend.app.models.product import Product, ProductPart, sku_key
from backend.app.models.product_category import ProductCategory, category_key
from backend.app.services import part_stock
from backend.app.services.product_sync import sync_product_for_file

pytestmark = pytest.mark.integration


def _meta(obj: str, material: str, model: str) -> dict:
    return {
        "sliced_for_model": model,
        "plates": [
            {"index": 1, "printable_objects": {"1": obj}, "filaments": [{"type": material, "color": "#123456"}]}
        ],
    }


@pytest.fixture
async def seeded_catalog(db_session):
    """«Lamp» — part «shade», file lamp.gcode.3mf, PETG on a P1S, uncategorized,
    ready, one free kit. «Hook» — PLA on an X1C, SKU HK-1, category «Hooks», draft."""
    hooks = ProductCategory(name="Hooks", name_key=category_key("Hooks"))
    db_session.add(hooks)
    await db_session.flush()
    lamp = Product(name="Lamp", status="ready")
    hook = Product(name="Hook", sku="HK-1", sku_key=sku_key("HK-1"), category_id=hooks.id)
    db_session.add_all([lamp, hook])
    await db_session.flush()
    files = {}
    for product, name, obj, material, model in (
        (lamp, "lamp.gcode.3mf", "shade.stl", "PETG", "P1S"),
        (hook, "hook.gcode.3mf", "peg.stl", "PLA", "X1C"),
    ):
        f = LibraryFile(
            filename=name, file_path=name, file_size=1, file_type="gcode", file_metadata=_meta(obj, material, model)
        )
        db_session.add(f)
        await db_session.flush()
        await sync_product_for_file(db_session, library_file_id=f.id, product_ids=[product.id])
        files[product.name] = f.id
    for part_id in (
        await db_session.execute(select(ProductPart.id).where(ProductPart.product_id == lamp.id))
    ).scalars():
        await part_stock.move(db_session, part_id=part_id, delta=1, reason="manual", note="counted")
    await db_session.commit()
    return {"lamp": lamp.id, "hook": hook.id, "hooks": hooks.id, "lamp_file": files["Lamp"]}


async def _names(client, **params) -> list[str]:
    r = await client.get("/api/v1/products", params={"page": 1, **params})
    assert r.status_code == 200, r.text
    return [i["name"] for i in r.json()["items"]]


@pytest.mark.asyncio
async def test_every_word_must_hit_some_field(committing_client, seeded_catalog):
    assert await _names(committing_client, q="lamp petg") == ["Lamp"]
    assert await _names(committing_client, q="SHADE") == ["Lamp"]  # a part name, any case
    assert await _names(committing_client, q="lamp.gcode") == ["Lamp"]  # a linked file
    assert await _names(committing_client, q="hk-1") == ["Hook"]  # the SKU
    assert await _names(committing_client, q="hooks") == ["Hook"]  # the category
    assert await _names(committing_client, q="#123456", sort_by="name-asc") == ["Hook", "Lamp"]  # a colour
    assert await _names(committing_client, q=f"PR-{seeded_catalog['hook']:04d}") == ["Hook"]  # the code
    assert await _names(committing_client, q="lamp nothing") == []


@pytest.mark.asyncio
async def test_filters_compose_and_the_panel_counts_without_its_own_filter(committing_client, seeded_catalog):
    r = (await committing_client.get("/api/v1/products", params={"page": 1, "material": "pla"})).json()
    assert [i["name"] for i in r["items"]] == ["Hook"]
    assert r["categories"] == [{"id": seeded_catalog["hooks"], "name": "Hooks", "count": 1}]
    assert r["uncategorized"] == 0
    # The category filter narrows the rows, not the panel's counts.
    r = (await committing_client.get("/api/v1/products", params={"page": 1, "category": "none"})).json()
    assert [i["name"] for i in r["items"]] == ["Lamp"]
    assert r["uncategorized"] == 1 and r["categories"][0]["count"] == 1
    assert await _names(committing_client, category=str(seeded_catalog["hooks"])) == ["Hook"]
    assert await _names(committing_client, status="draft") == ["Hook"]
    assert await _names(committing_client, model="P1S") == ["Lamp"]
    assert await _names(committing_client, color="#123456", material="PETG") == ["Lamp"]


@pytest.mark.asyncio
async def test_in_stock_narrows_the_counts_too(committing_client, seeded_catalog):
    r = (await committing_client.get("/api/v1/products", params={"page": 1, "in_stock": "true"})).json()
    assert [i["name"] for i in r["items"]] == ["Lamp"]
    assert r["uncategorized"] == 1 and r["categories"] == []


@pytest.mark.asyncio
async def test_the_new_sort_keys(committing_client, seeded_catalog):
    assert await _names(committing_client, sort_by="status-asc") == ["Hook", "Lamp"]
    assert await _names(committing_client, sort_by="status-desc") == ["Lamp", "Hook"]
    # A product without a SKU or a category sorts last either way.
    assert await _names(committing_client, sort_by="sku-asc") == ["Hook", "Lamp"]
    assert await _names(committing_client, sort_by="sku-desc") == ["Hook", "Lamp"]
    assert (await _names(committing_client, sort_by="category-desc"))[0] == "Hook"


@pytest.mark.asyncio
async def test_facets_and_the_draft_badge(committing_client, seeded_catalog):
    f = (await committing_client.get("/api/v1/products/facets")).json()
    assert f == {"materials": ["PETG", "PLA"], "colors": ["#123456"], "models": ["P1S", "X1C"]}
    badges = (await committing_client.get("/api/v1/projects/nav-badges")).json()
    assert badges["draft_products"] == 1


async def _set_trashed(db, file_id: int, trashed: bool) -> None:
    await db.execute(
        update(LibraryFile).where(LibraryFile.id == file_id).values(deleted_at=datetime.now(UTC) if trashed else None)
    )
    await db.commit()


@pytest.mark.asyncio
async def test_a_trashed_file_leaves_the_filters_the_search_and_the_choices(
    committing_client, db_session, seeded_catalog
):
    # Owner, 2026-09-27: the trash does not count — and it needs no refresh: a
    # restore brings the file's facets straight back.
    await _set_trashed(db_session, seeded_catalog["lamp_file"], True)
    assert await _names(committing_client, material="PETG") == []
    assert await _names(committing_client, q="petg") == []
    assert await _names(committing_client, q="lamp.gcode") == []
    facets = (await committing_client.get("/api/v1/products/facets")).json()
    assert facets["materials"] == ["PLA"] and facets["models"] == ["X1C"]
    await _set_trashed(db_session, seeded_catalog["lamp_file"], False)
    assert await _names(committing_client, material="PETG") == ["Lamp"]


@pytest.mark.asyncio
async def test_the_model_filter_takes_any_spelling_of_the_model(committing_client, seeded_catalog):
    assert await _names(committing_client, model="x1c") == ["Hook"]
    assert await _names(committing_client, model="Bambu Lab X1 Carbon") == ["Hook"]


@pytest.mark.asyncio
async def test_like_wildcards_in_a_search_word_are_literal(committing_client, db_session, seeded_catalog):
    db_session.add_all(
        [
            Product(name="Underscore", sku="LMP_01", sku_key=sku_key("LMP_01")),
            Product(name="Letter", sku="LMPX01", sku_key=sku_key("LMPX01")),
            Product(name="Percent 100%"),
            Product(name="Percent 1000"),
        ]
    )
    await db_session.commit()
    assert await _names(committing_client, q="lmp_01") == ["Underscore"]
    assert await _names(committing_client, q="100%") == ["Percent 100%"]


@pytest.mark.asyncio
async def test_in_stock_reads_its_candidates_in_chunks(committing_client, seeded_catalog, monkeypatch):
    from backend.app.services import product_facets

    monkeypatch.setattr(product_facets, "SQL_CHUNK", 1)
    r = (await committing_client.get("/api/v1/products", params={"page": 1, "in_stock": "true"})).json()
    assert [i["name"] for i in r["items"]] == ["Lamp"]
