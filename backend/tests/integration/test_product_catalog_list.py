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


# ---------- WS-13 E1 PC1–PC7, K1, K2: stock modes, sliced, row counts, catalog total ----------


async def _position(db, product_id: int, *, on_hand: int = 0, min_qty: int = 0):
    """One ready-goods position of the product's standard configuration, in its own
    transaction — the product gate takes one product per clean transaction."""
    from backend.app.services import finished_stock

    item = await finished_stock.item_for(db, product_id, {}, create=True)
    if on_hand:
        await finished_stock.receive(db, item, on_hand)
    if min_qty:
        await finished_stock.set_params(db, item, {"min_qty": min_qty})
    await db.commit()
    return item


@pytest.mark.asyncio
async def test_three_stock_modes_and_the_old_switch(committing_client, db_session, seeded_catalog):
    """PC1: ready units, free kits, below the minimum; ``in_stock`` is ``stock=kits``."""
    await _position(db_session, seeded_catalog["lamp"], min_qty=3)
    await _position(db_session, seeded_catalog["hook"], on_hand=2)
    assert await _names(committing_client, stock="finished") == ["Hook"]
    assert await _names(committing_client, stock="kits") == ["Lamp"]
    assert await _names(committing_client, in_stock="true") == ["Lamp"]
    assert await _names(committing_client, stock="below_min") == ["Lamp"]
    both = await committing_client.get("/api/v1/products", params={"page": 1, "stock": "kits", "in_stock": "true"})
    assert both.status_code == 422, both.text


@pytest.mark.asyncio
async def test_only_a_printable_file_makes_a_product_sliced_and_names_its_model(
    committing_client, db_session, seeded_catalog
):
    """PC2 / K2: a product whose only file is an unsliced 3MF project is not sliced,
    shows no model, is not found by that model and does not offer it as a filter; a
    sliced file that names no model is sliced without a chip."""
    for name, filename, file_type, meta in (
        ("Raw", "raw.3mf", "3mf", {**_meta("raw.stl", "PETG", "A1"), "has_sliced_gcode": False}),
        ("Bare", "bare.gcode.3mf", "gcode", {"plates": [{"index": 1, "printable_objects": {"1": "bare.stl"}}]}),
    ):
        product = Product(name=name)
        f = LibraryFile(filename=filename, file_path=filename, file_size=1, file_type=file_type, file_metadata=meta)
        db_session.add_all([product, f])
        await db_session.flush()
        await sync_product_for_file(db_session, library_file_id=f.id, product_ids=[product.id])
    await db_session.commit()

    r = (await committing_client.get("/api/v1/products", params={"page": 1})).json()
    rows = {i["name"]: i for i in r["items"]}
    assert (rows["Raw"]["sliced"], rows["Raw"]["models"]) == (False, [])
    assert (rows["Bare"]["sliced"], rows["Bare"]["models"]) == (True, [])
    assert (rows["Lamp"]["sliced"], rows["Lamp"]["models"]) == (True, ["P1S"])
    assert await _names(committing_client, model="A1") == []
    assert "A1" not in (await committing_client.get("/api/v1/products/facets")).json()["models"]
    assert await _names(committing_client, sliced="false") == ["Raw"]
    assert await _names(committing_client, sliced="true", sort_by="name-asc") == ["Bare", "Hook", "Lamp"]


@pytest.mark.asyncio
async def test_the_row_counts_its_parts_groups_orders_and_positions(committing_client, db_session, seeded_catalog):
    """PC3: printed parts (a zero in the kit still counts, «not counted» does not),
    purchased parts, group names in their order, DISTINCT active orders and the
    positions — tracked and below the minimum."""
    from backend.app.models.project import Project
    from backend.app.models.project_line import ProjectLine

    lamp = seeded_catalog["lamp"]
    db_session.add_all(
        [
            ProductPart(product_id=lamp, kind="printed", name="base", name_key="base", qty_per_unit=0),
            ProductPart(product_id=lamp, kind="printed", name="sprue", name_key="sprue", qty_per_unit=0, ignored=True),
            ProductPart(product_id=lamp, kind="purchased", name="M3", name_key="purchased:m3", qty_per_unit=4),
        ]
    )
    await db_session.commit()
    for group, options in (("Colour", ["Red", "Blue"]), ("Size", ["S"])):
        r = await committing_client.post(
            f"/api/v1/products/{lamp}/variant-groups", json={"name": group, "options": options}
        )
        assert r.status_code == 200, r.text
    orders = []
    for status in ("active", "active", "completed"):
        order = Project(name=f"O-{status}", status=status)
        db_session.add(order)
        await db_session.flush()
        orders.append(order.id)
    db_session.add_all(
        [
            ProjectLine(project_id=orders[0], product_id=lamp, quantity=1),
            ProjectLine(project_id=orders[0], product_id=lamp, quantity=2, sort_order=1),
            ProjectLine(project_id=orders[1], product_id=lamp, quantity=1),
            ProjectLine(project_id=orders[2], product_id=lamp, quantity=1),
        ]
    )
    await db_session.commit()
    await _position(db_session, lamp, on_hand=1, min_qty=3)

    row = next(
        i
        for i in (await committing_client.get("/api/v1/products", params={"page": 1})).json()["items"]
        if i["id"] == lamp
    )
    assert (row["printed_parts_count"], row["purchased_parts_count"]) == (2, 1)
    assert row["variant_group_names"] == ["Colour", "Size"]
    assert (row["active_orders_count"], row["lines_count"]) == (2, 4)
    assert (row["finished_positions"], row["finished_below_min"], row["finished_available"]) == (1, 1, 1)


@pytest.mark.asyncio
async def test_the_catalog_total_ignores_every_filter(committing_client, db_session, seeded_catalog):
    """PC6: the heading's «of N» — every catalogue product, active or not, whatever the
    filters say; a one-off product is not the catalogue's."""
    db_session.add_all([Product(name="Retired", is_active=False), Product(name="Once", origin="adhoc_job")])
    await db_session.commit()
    body = (await committing_client.get("/api/v1/products", params={"page": 1, "q": "lamp", "active": "true"})).json()
    assert [i["name"] for i in body["items"]] == ["Lamp"]
    assert body["catalog_total"] == 3


@pytest.mark.asyncio
async def test_the_search_reads_the_version_too(committing_client, db_session, seeded_catalog):
    """PC7."""
    lamp = await db_session.get(Product, seeded_catalog["lamp"])
    lamp.version = "v2.1-beta"
    await db_session.commit()
    assert await _names(committing_client, q="2.1-BETA") == ["Lamp"]


@pytest.mark.asyncio
async def test_the_detail_is_the_catalog_row(committing_client, db_session, seeded_catalog):
    """K1: what the row says, the detail says — materials, colours, models, ready units
    and the new counts, off the same helpers."""
    await _position(db_session, seeded_catalog["lamp"], on_hand=2)
    items = (await committing_client.get("/api/v1/products", params={"page": 1})).json()["items"]
    for row in items:
        detail = (await committing_client.get(f"/api/v1/products/{row['id']}")).json()
        assert {key: detail[key] for key in row} == row
    lamp = next(i for i in items if i["id"] == seeded_catalog["lamp"])
    assert (lamp["materials"], lamp["models"], lamp["finished_available"]) == (["PETG"], ["P1S"], 2)
