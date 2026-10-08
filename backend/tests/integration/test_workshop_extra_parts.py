"""Synthetic extra parts stay separate from kits, queues and free stock."""

import pytest

from backend.app.models.customer import Customer
from backend.app.services import finished_stock, part_stock
from backend.tests.integration.test_workshop_stock_plan_regressions import archive, plan, shop  # noqa: F401

pytestmark = pytest.mark.integration


async def extra_order(client, db, shop, *, a=10, b=5):
    for part, percent in ((shop["a"], a), (shop["b"], b)):
        response = await client.patch(
            f"/api/v1/products/{part.product_id}/parts/{part.id}", json={"extra_percent": percent}
        )
        assert response.status_code == 200, response.text
    response = await client.post(
        "/api/v1/projects/",
        json={"name": "Product A with extras", "lines": [{"product_id": shop["a"].product_id, "quantity": 10}]},
    )
    assert response.status_code in (200, 201), response.text
    return {**shop, "order": response.json()["id"], "line": response.json()["lines"][0]["id"]}


async def state(client, s):
    response = await client.get(f"/api/v1/projects/{s['order']}/fulfilment")
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.asyncio
async def test_whole_line_rounding_and_snapshot_do_not_change_existing_orders(committing_client, db_session, shop):
    s = await extra_order(committing_client, db_session, shop, a=10, b=5)
    assert (await plan(committing_client, shop))[0] == {shop["a"].id: 30, shop["b"].id: 10}
    assert (await plan(committing_client, s))[0] == {shop["a"].id: 33, shop["b"].id: 11}
    response = await committing_client.patch(
        f"/api/v1/products/{shop['a'].product_id}/parts/{shop['a'].id}", json={"extra_percent": 15}
    )
    assert response.status_code == 200, response.text
    assert (await plan(committing_client, s))[0] == {shop["a"].id: 33, shop["b"].id: 11}
    response = await committing_client.patch(f"/api/v1/projects/{s['order']}/lines/{s['line']}", json={"quantity": 3})
    assert response.status_code == 200, response.text
    assert (await plan(committing_client, s))[0] == {shop["a"].id: 10, shop["b"].id: 4}


@pytest.mark.asyncio
@pytest.mark.parametrize("value", [-1, 1001, None, "NaN", "Infinity"])
async def test_invalid_percent_is_rejected(committing_client, db_session, shop, value):
    response = await committing_client.patch(
        f"/api/v1/products/{shop['a'].product_id}/parts/{shop['a'].id}", json={"extra_percent": value}
    )
    assert response.status_code == 422, response.text


@pytest.mark.asyncio
async def test_extra_parts_are_received_and_issued_with_kits_and_never_reprinted(committing_client, db_session, shop):
    s = await extra_order(committing_client, db_session, shop)
    customer = Customer(name="Product A synthetic customer")
    db_session.add(customer)
    await db_session.commit()
    response = await committing_client.patch(f"/api/v1/projects/{s['order']}", json={"customer_id": customer.id})
    assert response.status_code == 200, response.text
    await archive(db_session, s, status="completed", quantities=(33, 11))
    st = await state(committing_client, s)
    [line] = st["lines"]
    assert line["can_receive"] == 10
    assert {p["part_id"]: (p["wanted"], p["can_receive"]) for p in line["parts"]} == {
        s["a"].id: (3, 3),
        s["b"].id: (1, 1),
    }
    # Issuing only the kits must never quietly complete an order that owes extras.
    response = await committing_client.post(
        f"/api/v1/projects/{s['order']}/fulfilment",
        json={
            "lines": [{"line_id": s["line"], "receive": 10, "issue": 10}],
            "recipient": {"name": "Synthetic recipient"},
            "complete": True,
        },
    )
    assert response.status_code == 409, response.text
    response = await committing_client.post(
        f"/api/v1/projects/{s['order']}/fulfilment",
        json={
            "lines": [
                {
                    "line_id": s["line"],
                    "receive": 10,
                    "issue": 10,
                    "parts": [
                        {"part_id": s["a"].id, "receive": 3, "issue": 3},
                        {"part_id": s["b"].id, "receive": 1, "issue": 1},
                    ],
                }
            ],
            "recipient": {"name": "Synthetic recipient"},
        },
    )
    assert response.status_code == 200, response.text
    st = await state(committing_client, s)
    assert st["can_complete"] is True
    assert await plan(committing_client, s) == ({}, 0)
    assert (await part_stock.balances(db_session, s["a"].product_id)) == {s["a"].id: 0, s["b"].id: 0}
    response = await committing_client.patch(f"/api/v1/projects/{s['order']}/lines/{s['line']}", json={"quantity": 1})
    assert response.status_code == 409, response.text


@pytest.mark.asyncio
async def test_ready_units_still_need_extra_parts_from_the_shelf(committing_client, db_session, shop):
    s = await extra_order(committing_client, db_session, shop)
    item = await finished_stock.item_for(db_session, s["a"].product_id, {}, create=True)
    await finished_stock.receive(db_session, item, 10)
    await part_stock.move(db_session, part_id=s["a"].id, delta=3, reason="manual", note="Synthetic extras")
    await part_stock.move(db_session, part_id=s["b"].id, delta=1, reason="manual", note="Synthetic extras")
    await db_session.commit()
    response = await committing_client.post(f"/api/v1/projects/{s['order']}/take-stock", json={})
    assert response.status_code == 200, response.text
    assert await plan(committing_client, s) == ({}, 0)
    st = await state(committing_client, s)
    assert st["can_complete"] is False
    [line] = st["lines"]
    assert line["can_receive"] == line["can_assemble"] == 0
    assert {p["part_id"]: p["stock_qty"] for p in line["parts"]} == {s["a"].id: 3, s["b"].id: 1}
    response = await committing_client.post(
        f"/api/v1/projects/{s['order']}/fulfilment",
        json={
            "lines": [
                {
                    "line_id": s["line"],
                    "parts": [{"part_id": s["a"].id, "receive": 3}, {"part_id": s["b"].id, "receive": 1}],
                }
            ]
        },
    )
    assert response.status_code == 200, response.text
    assert (await state(committing_client, s))["can_complete"] is True
    assert await plan(committing_client, s) == ({}, 0)
    assert (await part_stock.balances(db_session, s["a"].product_id)) == {s["a"].id: 0, s["b"].id: 0}


@pytest.mark.asyncio
async def test_single_part_full_shelf_extras_never_become_extra_kits(committing_client, db_session, shop):
    s = await extra_order(committing_client, db_session, shop, a=10, b=0)
    response = await committing_client.put(
        f"/api/v1/projects/{s['order']}/lines/{s['line']}/configuration",
        json={"part_counts": {str(s["b"].id): 0}, "choices": {}},
    )
    assert response.status_code == 200, response.text
    await part_stock.move(db_session, part_id=s["a"].id, delta=33, reason="manual", note="Synthetic full shelf")
    await db_session.commit()
    response = await committing_client.post(f"/api/v1/projects/{s['order']}/take-stock", json={})
    assert response.status_code == 200, response.text
    [line] = (await state(committing_client, s))["lines"]
    assert line["can_assemble"] == 10
    assert line["parts"][0]["stock_qty"] == 3
    response = await committing_client.post(
        f"/api/v1/projects/{s['order']}/fulfilment",
        json={"lines": [{"line_id": s["line"], "assemble": 10, "parts": [{"part_id": s["a"].id, "receive": 3}]}]},
    )
    assert response.status_code == 200, response.text
    assert (await state(committing_client, s))["can_complete"] is True
    assert await plan(committing_client, s) == ({}, 0)
    assert (await part_stock.balances(db_session, s["a"].product_id))[s["a"].id] == 0


@pytest.mark.asyncio
async def test_mixed_warehouse_and_printed_receipts_include_extras_without_double_credit(
    committing_client, db_session, shop
):
    s = await extra_order(committing_client, db_session, shop)
    await part_stock.move(db_session, part_id=s["a"].id, delta=33, reason="manual", note="Synthetic partial stock")
    await db_session.commit()
    response = await committing_client.post(f"/api/v1/projects/{s['order']}/take-stock", json={})
    assert response.status_code == 200, response.text
    assert (await plan(committing_client, s))[0] == {s["b"].id: 11}
    await archive(db_session, s, status="completed", quantities=(0, 11))
    [line] = (await state(committing_client, s))["lines"]
    assert line["can_receive"] == 10
    assert {p["part_id"]: p["can_receive"] for p in line["parts"]} == {s["a"].id: 3, s["b"].id: 1}
    response = await committing_client.post(
        f"/api/v1/projects/{s['order']}/fulfilment",
        json={
            "lines": [
                {
                    "line_id": s["line"],
                    "receive": 10,
                    "parts": [{"part_id": s["a"].id, "receive": 3}, {"part_id": s["b"].id, "receive": 1}],
                }
            ]
        },
    )
    assert response.status_code == 200, response.text
    assert await plan(committing_client, s) == ({}, 0)
    assert (await state(committing_client, s))["can_complete"]
    assert await part_stock.balances(db_session, s["a"].product_id) == {s["a"].id: 0, s["b"].id: 0}
    # Returning borrowed extras releases a hold, not a second credit of printed parts.
    response = await committing_client.patch(f"/api/v1/projects/{s['order']}", json={"status": "cancelled"})
    assert response.status_code == 200, response.text
    assert await part_stock.balances(db_session, s["a"].product_id) == {s["a"].id: 3, s["b"].id: 1}
    response = await committing_client.patch(f"/api/v1/projects/{s['order']}", json={"status": "cancelled"})
    assert response.status_code == 200, response.text
    assert await part_stock.balances(db_session, s["a"].product_id) == {s["a"].id: 3, s["b"].id: 1}


@pytest.mark.asyncio
async def test_extra_write_off_requires_only_one_replacement_not_a_new_kit(committing_client, db_session, shop):
    s = await extra_order(committing_client, db_session, shop)
    await archive(db_session, s, status="completed", quantities=(33, 11))
    response = await committing_client.post(
        f"/api/v1/projects/{s['order']}/fulfilment",
        json={
            "lines": [
                {
                    "line_id": s["line"],
                    "receive": 10,
                    "parts": [
                        {"part_id": s["a"].id, "receive": 3, "write_off": 1},
                        {"part_id": s["b"].id, "receive": 1},
                    ],
                }
            ],
            "write_off_note": "Synthetic broken spare",
        },
    )
    assert response.status_code == 200, response.text
    assert (await plan(committing_client, s))[0] == {s["a"].id: 1}
    assert not (await state(committing_client, s))["can_complete"]
    await archive(db_session, s, status="completed", quantities=(1, 0))
    [line] = (await state(committing_client, s))["lines"]
    assert line["can_receive"] == 0
    assert {p["part_id"]: p["can_receive"] for p in line["parts"]} == {s["a"].id: 1, s["b"].id: 0}


@pytest.mark.asyncio
async def test_reduction_releases_only_reservation_above_base_plus_rounded_extras(committing_client, db_session, shop):
    s = await extra_order(committing_client, db_session, shop)
    await part_stock.move(db_session, part_id=s["a"].id, delta=33, reason="manual", note="Synthetic stock")
    await db_session.commit()
    response = await committing_client.post(f"/api/v1/projects/{s['order']}/take-stock", json={})
    assert response.status_code == 200, response.text
    response = await committing_client.patch(f"/api/v1/projects/{s['order']}/lines/{s['line']}", json={"quantity": 3})
    assert response.status_code == 200, response.text
    assert (await part_stock.balances(db_session, s["a"].product_id))[s["a"].id] == 23
    assert (await plan(committing_client, s))[0] == {s["b"].id: 4}


@pytest.mark.asyncio
async def test_no_implicit_extras_in_parts_mode_or_a_zeroed_composition(committing_client, db_session, shop):
    s = await extra_order(committing_client, db_session, shop, a=12.5, b=0)
    response = await committing_client.post(
        "/api/v1/projects/",
        json={
            "name": "Product B exact parts",
            "lines": [
                {"product_id": s["a"].product_id, "mode": "parts", "quantity": 1, "part_counts": {str(s["a"].id): 5}}
            ],
        },
    )
    assert response.status_code in (200, 201), response.text
    p = {**s, "order": response.json()["id"], "line": response.json()["lines"][0]["id"]}
    assert (await plan(committing_client, p))[0] == {s["a"].id: 5}
    response = await committing_client.put(
        f"/api/v1/projects/{s['order']}/lines/{s['line']}/configuration",
        json={"part_counts": {str(s["a"].id): 0}, "choices": {}},
    )
    assert response.status_code == 200, response.text
    assert (await plan(committing_client, s))[0] == {s["b"].id: 10}


@pytest.mark.asyncio
async def test_deleting_or_merging_an_extra_obligation_is_refused(committing_client, db_session, shop):
    s = await extra_order(committing_client, db_session, shop)
    response = await committing_client.delete(f"/api/v1/products/{s['a'].product_id}/parts/{s['a'].id}")
    assert response.status_code == 409, response.text
    response = await committing_client.post(
        f"/api/v1/products/{s['a'].product_id}/parts/{s['b'].id}/merge", json={"source_part_id": s["a"].id}
    )
    assert response.status_code == 409, response.text
    assert (await plan(committing_client, s))[0] == {s["a"].id: 33, s["b"].id: 11}


@pytest.mark.asyncio
async def test_catalog_duplicate_and_export_import_keep_entered_percentage(committing_client, db_session, shop):
    import io
    import json
    import zipfile

    from backend.tests.integration.test_product_export_import import _import

    await extra_order(committing_client, db_session, shop, a=12.5, b=5.25)
    response = await committing_client.post(
        f"/api/v1/products/{shop['a'].product_id}/duplicate", json={"name": "Product B extra copy"}
    )
    assert response.status_code in (200, 201), response.text
    assert {p["name"]: p["extra_percent"] for p in response.json()["parts"]} == {"Part A": 12.5, "Part B": 5.25}
    response = await committing_client.get(f"/api/v1/products/{shop['a'].product_id}/export")
    assert response.status_code == 200, response.text
    with zipfile.ZipFile(io.BytesIO(response.content)) as z:
        manifest = json.loads(z.read("product.json"))
        assert {p["name"]: p["extra_percent"] for p in manifest["parts"]} == {"Part A": 12.5, "Part B": 5.25}
    imported = await _import(committing_client, response.content)
    assert imported.status_code == 200, imported.text
    new_id = imported.json()["product"]["id"]
    product = (await committing_client.get(f"/api/v1/products/{new_id}")).json()
    assert {p["name"]: p["extra_percent"] for p in product["parts"]} == {"Part A": 12.5, "Part B": 5.25}
