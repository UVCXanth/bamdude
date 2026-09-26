"""Variant groups and options of a product over the API (spec workshop-product-variants, rules 18–21)."""

import pytest
from sqlalchemy import select

from backend.app.models.line_config import ProjectLineChoice
from backend.app.models.product import Product, ProductPart

pytestmark = pytest.mark.integration


@pytest.fixture
async def pipe(db_session):
    product = Product(name="Pipe")
    db_session.add(product)
    await db_session.flush()
    parts = [
        ProductPart(product_id=product.id, kind="printed", name=n, name_key=n, qty_per_unit=1, sort_order=i)
        for i, n in enumerate(("flask", "straight", "angled"))
    ]
    db_session.add_all(parts)
    await db_session.commit()
    return {"product": product, "parts": {p.name: p for p in parts}}


def _base(pipe):
    return f"/api/v1/products/{pipe['product'].id}"


async def _tail(client, pipe):
    r = await client.post(f"{_base(pipe)}/variant-groups", json={"name": "Хвіст", "options": ["прямий", "кутовий"]})
    assert r.status_code == 200, r.text
    group = r.json()["variant_groups"][0]
    return group, {o["name"]: o for o in group["options"]}


@pytest.mark.asyncio
async def test_a_group_with_two_options_the_first_standard(committing_client, pipe):
    group, options = await _tail(committing_client, pipe)
    assert group["name"] == "Хвіст" and group["default_option_id"] == options["прямий"]["id"]
    assert [o["name"] for o in group["options"]] == ["прямий", "кутовий"]
    assert options["прямий"]["lines_count"] == 0 and options["прямий"]["parts_count"] == 0


@pytest.mark.asyncio
async def test_names_are_unique_without_case(committing_client, pipe):
    group, _ = await _tail(committing_client, pipe)
    dup = await committing_client.post(f"{_base(pipe)}/variant-groups", json={"name": " хвіст ", "options": ["x"]})
    assert dup.status_code == 409
    empty = await committing_client.post(f"{_base(pipe)}/variant-groups", json={"name": "Колір", "options": []})
    assert empty.status_code == 422
    opt = await committing_client.post(f"{_base(pipe)}/variant-groups/{group['id']}/options", json={"name": "ПРЯМИЙ"})
    assert opt.status_code == 409
    added = await committing_client.post(f"{_base(pipe)}/variant-groups/{group['id']}/options", json={"name": "Т"})
    assert [o["name"] for o in added.json()["variant_groups"][0]["options"]] == ["прямий", "кутовий", "Т"]


@pytest.mark.asyncio
async def test_rename_and_change_the_standard(committing_client, pipe):
    group, options = await _tail(committing_client, pipe)
    r = await committing_client.patch(
        f"{_base(pipe)}/variant-groups/{group['id']}",
        json={"name": "Tail", "default_option_id": options["кутовий"]["id"]},
    )
    assert r.status_code == 200, r.text
    g = r.json()["variant_groups"][0]
    assert g["name"] == "Tail" and g["default_option_id"] == options["кутовий"]["id"]
    foreign = await committing_client.patch(
        f"{_base(pipe)}/variant-groups/{group['id']}", json={"default_option_id": 999999}
    )
    assert foreign.status_code == 422
    renamed = await committing_client.patch(
        f"{_base(pipe)}/variant-groups/{group['id']}/options/{options['прямий']['id']}", json={"name": "straight"}
    )
    assert renamed.json()["variant_groups"][0]["options"][0]["name"] == "straight"


@pytest.mark.asyncio
async def test_a_part_binds_to_an_option_of_its_own_product_only(committing_client, db_session, pipe):
    _group, options = await _tail(committing_client, pipe)
    straight = pipe["parts"]["straight"]
    r = await committing_client.patch(
        f"{_base(pipe)}/parts/{straight.id}", json={"variant_option_id": options["прямий"]["id"]}
    )
    assert r.status_code == 200 and r.json()["variant_option_id"] == options["прямий"]["id"]
    other = Product(name="Other")
    db_session.add(other)
    await db_session.commit()
    og = await committing_client.post(
        f"/api/v1/products/{other.id}/variant-groups", json={"name": "X", "options": ["x"]}
    )
    foreign_option = og.json()["variant_groups"][0]["options"][0]["id"]
    bad = await committing_client.patch(
        f"{_base(pipe)}/parts/{straight.id}", json={"variant_option_id": foreign_option}
    )
    assert bad.status_code == 422
    unbound = await committing_client.patch(f"{_base(pipe)}/parts/{straight.id}", json={"variant_option_id": None})
    assert unbound.json()["variant_option_id"] is None


@pytest.mark.asyncio
async def test_deletes_refused_while_lines_or_parts_use_them(committing_client, db_session, pipe):
    group, options = await _tail(committing_client, pipe)
    angled = options["кутовий"]["id"]
    await committing_client.patch(
        f"{_base(pipe)}/parts/{pipe['parts']['angled'].id}", json={"variant_option_id": angled}
    )
    bound = await committing_client.delete(f"{_base(pipe)}/variant-groups/{group['id']}/options/{angled}")
    assert bound.status_code == 409
    standard = await committing_client.delete(
        f"{_base(pipe)}/variant-groups/{group['id']}/options/{options['прямий']['id']}"
    )
    assert standard.status_code == 409
    await committing_client.patch(f"{_base(pipe)}/parts/{pipe['parts']['angled'].id}", json={"variant_option_id": None})
    order = (
        await committing_client.post(
            "/api/v1/projects/",
            json={
                "name": "O",
                "lines": [{"product_id": pipe["product"].id, "quantity": 1, "choices": {str(group["id"]): angled}}],
            },
        )
    ).json()
    chosen = await committing_client.delete(f"{_base(pipe)}/variant-groups/{group['id']}/options/{angled}")
    assert chosen.status_code == 409 and "1" in chosen.json()["detail"]
    whole = await committing_client.delete(f"{_base(pipe)}/variant-groups/{group['id']}")
    assert whole.status_code == 409
    await committing_client.delete(f"/api/v1/projects/{order['id']}")
    assert (await committing_client.delete(f"{_base(pipe)}/variant-groups/{group['id']}")).status_code == 200


@pytest.mark.asyncio
async def test_a_new_group_on_a_product_on_orders_reaches_its_lines(committing_client, db_session, pipe):
    order = (
        await committing_client.post(
            "/api/v1/projects/", json={"name": "O", "lines": [{"product_id": pipe["product"].id, "quantity": 1}]}
        )
    ).json()
    group, options = await _tail(committing_client, pipe)
    rows = (await db_session.execute(select(ProjectLineChoice.group_id, ProjectLineChoice.option_id))).all()
    assert rows == [(group["id"], options["прямий"]["id"])]
    assert order["lines"][0]["id"]
    # A later change of the standard leaves the saved choice alone.
    await committing_client.patch(
        f"{_base(pipe)}/variant-groups/{group['id']}", json={"default_option_id": options["кутовий"]["id"]}
    )
    rows = (await db_session.execute(select(ProjectLineChoice.option_id))).scalars().all()
    assert rows == [options["прямий"]["id"]]


@pytest.mark.asyncio
async def test_a_copy_of_the_product_carries_its_variants(committing_client, pipe):
    group, options = await _tail(committing_client, pipe)
    await committing_client.patch(
        f"{_base(pipe)}/parts/{pipe['parts']['angled'].id}", json={"variant_option_id": options["кутовий"]["id"]}
    )
    copy = (await committing_client.post(f"{_base(pipe)}/duplicate", json={})).json()
    g = copy["variant_groups"][0]
    assert g["name"] == "Хвіст" and [o["name"] for o in g["options"]] == ["прямий", "кутовий"]
    assert g["id"] != group["id"]
    standard = next(o for o in g["options"] if o["id"] == g["default_option_id"])
    assert standard["name"] == "прямий"
    angled_copy = next(p for p in copy["parts"] if p["name"] == "angled")
    assert angled_copy["variant_option_id"] == next(o["id"] for o in g["options"] if o["name"] == "кутовий")


@pytest.mark.asyncio
async def test_export_and_import_keep_the_variants(committing_client, pipe):
    _group, options = await _tail(committing_client, pipe)
    await committing_client.patch(
        f"{_base(pipe)}/parts/{pipe['parts']['angled'].id}", json={"variant_option_id": options["кутовий"]["id"]}
    )
    exported = await committing_client.get(f"{_base(pipe)}/export")
    assert exported.status_code == 200
    imported = await committing_client.post(
        "/api/v1/products/import", files={"file": ("pipe.zip", exported.content, "application/zip")}
    )
    assert imported.status_code == 200, imported.text
    product = imported.json()["product"]
    g = product["variant_groups"][0]
    assert [o["name"] for o in g["options"]] == ["прямий", "кутовий"]
    angled = next(p for p in product["parts"] if p["name"] == "angled")
    assert angled["variant_option_id"] == next(o["id"] for o in g["options"] if o["name"] == "кутовий")


@pytest.mark.asyncio
async def test_a_deleted_product_takes_its_variants(committing_client, db_session, pipe):
    from backend.app.models.product_variant import ProductVariantGroup, ProductVariantOption

    await _tail(committing_client, pipe)
    r = await committing_client.delete(_base(pipe))
    assert r.status_code == 200, r.text
    assert (await db_session.execute(select(ProductVariantGroup.id))).scalars().all() == []
    assert (await db_session.execute(select(ProductVariantOption.id))).scalars().all() == []
