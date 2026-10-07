"""Synthetic workshop planning through stock, rejects and both queue tiers."""

import pytest

from backend.app.models.archive import PrintArchive
from backend.app.models.archive_part import PrintArchivePart
from backend.app.models.auto_queue import AutoQueueItem
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.product import Product, ProductPart, ProductPlate
from backend.app.services import part_stock
from backend.app.services.printer_queues import ensure_printer_queue
from backend.tests.fixtures.filament_routing_cases import write_routing_3mf

pytestmark = pytest.mark.integration


@pytest.fixture
async def shop(db_session, committing_client, tmp_path, printer_factory):
    product = Product(name="Product A")
    stranger = Product(name="Product B")
    db_session.add_all([product, stranger])
    await db_session.flush()
    a = ProductPart(product_id=product.id, kind="printed", name="Part A", name_key="part a", qty_per_unit=3)
    b = ProductPart(product_id=product.id, kind="printed", name="Part B", name_key="part b", qty_per_unit=1)
    db_session.add_all([a, b])
    path = write_routing_3mf(
        tmp_path / "synthetic.gcode.3mf", {1: [{"id": 1, "type": "PETG", "color": "#000000", "used_g": "1"}]}
    )
    file = LibraryFile(
        filename="synthetic.gcode.3mf",
        file_path=str(path),
        file_type="gcode",
        file_size=1,
        file_metadata={
            "plates": [
                {
                    "index": 1,
                    "printable_objects": {"1": "Part A", "2": "Part A", "3": "Part A", "4": "Part B"},
                    "print_time_seconds": 100,
                    "filaments": [{"slot_id": 1, "type": "PETG"}],
                }
            ]
        },
    )
    db_session.add(file)
    await db_session.flush()
    plate = ProductPlate(product_id=product.id, library_file_id=file.id, plate_index=0)
    db_session.add(plate)
    await db_session.commit()
    r = await committing_client.post(
        "/api/v1/projects/",
        json={"name": "Synthetic stock plan", "lines": [{"product_id": product.id, "quantity": 10}]},
    )
    assert r.status_code in (200, 201), r.text
    order_id, line_id = r.json()["id"], r.json()["lines"][0]["id"]
    printer = await printer_factory(name="Synthetic planning printer")
    await ensure_printer_queue(db_session, printer.id)
    await db_session.commit()
    return {"a": a, "b": b, "file": file, "plate": plate, "order": order_id, "line": line_id, "printer": printer}


async def plan(client, shop):
    response = await client.get(f"/api/v1/projects/{shop['order']}/plan")
    assert response.status_code == 200, response.text
    [line] = response.json()["lines"]
    return {p["part_id"]: p["count"] for p in line["outstanding_before"]}, sum(r["count"] for r in line["rows"])


async def archive(db, shop, *, status, quantities, defects=(0, 0)):
    row = PrintArchive(
        project_id=shop["order"],
        project_line_id=shop["line"],
        library_file_id=shop["file"].id,
        plate_index=1,
        filename="synthetic",
        file_path="",
        file_size=0,
        status=status,
        quantity=1,
        filament_type="PETG",
    )
    db.add(row)
    await db.flush()
    parts = [
        PrintArchivePart(archive_id=row.id, name=part.name, name_key=part.name_key, quantity=qty, defective=bad)
        for part, qty, bad in zip((shop["a"], shop["b"]), quantities, defects, strict=True)
    ]
    db.add_all(parts)
    await db.commit()
    return row, parts


@pytest.mark.asyncio
async def test_reservations_good_parts_running_and_handed_queue_are_not_reprinted(committing_client, db_session, shop):
    a, b = shop["a"].id, shop["b"].id
    for part, count in ((a, 9), (b, 3)):
        await part_stock.move(db_session, part_id=part, delta=count, reason="manual", note="Synthetic fixture")
    await db_session.commit()
    # Free stock is not an order allocation. The existing explicit take reserves it.
    assert await plan(committing_client, shop) == ({a: 30, b: 10}, 10)
    take = await committing_client.post(f"/api/v1/projects/{shop['order']}/take-stock", json={})
    assert take.status_code == 200, take.text
    assert await plan(committing_client, shop) == ({a: 21, b: 7}, 7)
    _completed, defects = await archive(db_session, shop, status="completed", quantities=(12, 4), defects=(3, 1))
    assert await plan(committing_client, shop) == ({a: 12, b: 4}, 4)
    running, _parts = await archive(db_session, shop, status="printing", quantities=(3, 1))
    assert await plan(committing_client, shop) == ({a: 9, b: 3}, 3)
    pending = PrintQueueItem(
        queue_id=shop["printer"].id,
        library_file_id=shop["file"].id,
        plate_id=1,
        project_id=shop["order"],
        project_line_id=shop["line"],
        status="pending",
        position=1,
    )
    db_session.add(pending)
    await db_session.flush()
    handed = AutoQueueItem(
        library_file_id=shop["file"].id,
        plate_id=1,
        project_id=shop["order"],
        project_line_id=shop["line"],
        status="pending",
        assigned_to_item_id=pending.id,
    )
    db_session.add(handed)
    await db_session.commit()
    assert await plan(committing_client, shop) == ({a: 6, b: 2}, 2)
    pending.status = "cancelled"
    await db_session.commit()
    assert await plan(committing_client, shop) == ({a: 9, b: 3}, 3)
    running.status = "cancelled"
    await db_session.commit()
    assert await plan(committing_client, shop) == ({a: 12, b: 4}, 4)
    defects[1].defective = 2
    await db_session.commit()
    assert await plan(committing_client, shop) == ({a: 12, b: 5}, 5)
    # Identical repeated reads cannot accumulate work or change stock.
    for _ in range(3):
        assert await plan(committing_client, shop) == ({a: 12, b: 5}, 5)
    assert await part_stock.balances(db_session, shop["a"].product_id) == {a: 0, b: 0}


async def take_loose_a(client, db, shop, qty=30):
    await part_stock.move(db, part_id=shop["a"].id, delta=qty, reason="manual", note="Synthetic A-only shelf")
    await db.commit()
    response = await client.post(f"/api/v1/projects/{shop['order']}/take-stock", json={})
    assert response.status_code == 200, response.text


@pytest.mark.asyncio
async def test_repeated_take_does_not_reserve_again_and_quantity_reduction_returns_only_excess(
    committing_client, db_session, shop
):
    await take_loose_a(committing_client, db_session, shop)
    assert (await committing_client.get(f"/api/v1/projects/{shop['order']}/stock-offers")).json() == []
    response = await committing_client.post(f"/api/v1/projects/{shop['order']}/take-stock", json={})
    assert response.status_code == 200 and response.json()["results"] == []
    response = await committing_client.patch(
        f"/api/v1/projects/{shop['order']}/lines/{shop['line']}", json={"quantity": 4}
    )
    assert response.status_code == 200, response.text
    assert await part_stock.balances(db_session, shop["a"].product_id) == {shop["a"].id: 18, shop["b"].id: 0}
    assert (await plan(committing_client, shop))[0] == {shop["b"].id: 4}


@pytest.mark.asyncio
async def test_cancellation_returns_a_partial_reservation_exactly_once(committing_client, db_session, shop):
    await take_loose_a(committing_client, db_session, shop)
    response = await committing_client.patch(f"/api/v1/projects/{shop['order']}", json={"status": "cancelled"})
    assert response.status_code == 200, response.text
    assert await part_stock.balances(db_session, shop["a"].product_id) == {shop["a"].id: 30, shop["b"].id: 0}
    response = await committing_client.patch(f"/api/v1/projects/{shop['order']}", json={"status": "cancelled"})
    assert response.status_code == 200, response.text
    assert await part_stock.balances(db_session, shop["a"].product_id) == {shop["a"].id: 30, shop["b"].id: 0}


@pytest.mark.asyncio
async def test_configuration_change_releases_parts_that_no_longer_belong_to_the_line(
    committing_client, db_session, shop
):
    await take_loose_a(committing_client, db_session, shop)
    response = await committing_client.put(
        f"/api/v1/projects/{shop['order']}/lines/{shop['line']}/configuration",
        json={"part_counts": {str(shop["a"].id): 0}, "choices": {}},
    )
    assert response.status_code == 200, response.text
    assert await part_stock.balances(db_session, shop["a"].product_id) == {shop["a"].id: 30, shop["b"].id: 0}
    assert (await plan(committing_client, shop))[0] == {shop["b"].id: 10}


@pytest.mark.asyncio
async def test_two_lines_share_the_loose_shelf_and_another_order_cannot_spend_it_twice(
    committing_client, db_session, shop
):
    response = await committing_client.post(
        f"/api/v1/projects/{shop['order']}/lines", json={"product_id": shop["a"].product_id, "quantity": 10}
    )
    assert response.status_code in (200, 201), response.text
    await part_stock.move(db_session, part_id=shop["a"].id, delta=36, reason="manual", note="Synthetic shared shelf")
    await db_session.commit()
    offers = (await committing_client.get(f"/api/v1/projects/{shop['order']}/stock-offers")).json()
    assert [o["parts"].get(str(shop["a"].id), 0) for o in offers] == [30, 6]
    response = await committing_client.post(f"/api/v1/projects/{shop['order']}/take-stock", json={"lines": offers})
    assert response.status_code == 200, response.text
    assert sum(r["got_parts"].get(str(shop["a"].id), 0) for r in response.json()["results"]) == 36
    another = await committing_client.post(
        "/api/v1/projects/",
        json={"name": "Product B competing order", "lines": [{"product_id": shop["a"].product_id, "quantity": 10}]},
    )
    assert another.status_code in (200, 201), another.text
    assert (await committing_client.get(f"/api/v1/projects/{another.json()['id']}/stock-offers")).json() == []


@pytest.mark.asyncio
async def test_partial_free_stock_is_reserved_and_mixed_receipts_do_not_reprint_it(committing_client, db_session, shop):
    a, b = shop["a"].id, shop["b"].id
    await part_stock.move(db_session, part_id=a, delta=30, reason="manual", note="Synthetic A-only shelf")
    await db_session.commit()
    response = await committing_client.get(f"/api/v1/projects/{shop['order']}/stock-offers")
    assert response.status_code == 200, response.text
    assert response.json()[0]["parts"] == {str(a): 30}
    assert await plan(committing_client, shop) == ({a: 30, b: 10}, 10)
    take = await committing_client.post(f"/api/v1/projects/{shop['order']}/take-stock", json={"lines": response.json()})
    assert take.status_code == 200, take.text
    outstanding, _prints = await plan(committing_client, shop)
    assert outstanding == {b: 10}
    await archive(db_session, shop, status="completed", quantities=(0, 10))
    state = (await committing_client.get(f"/api/v1/projects/{shop['order']}/fulfilment")).json()
    assert state["lines"][0]["can_receive"] == 10
    received = await committing_client.post(
        f"/api/v1/projects/{shop['order']}/fulfilment", json={"lines": [{"line_id": shop["line"], "receive": 10}]}
    )
    assert received.status_code == 200, received.text
    assert await plan(committing_client, shop) == ({}, 0)
    assert await part_stock.balances(db_session, shop["a"].product_id) == {a: 0, b: 0}
