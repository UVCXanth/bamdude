"""«Не рахувати» (spec workshop-order-issue-followups, rule 34): a zero is a part out of the kit
and has a shelf; the mark is what says «not a part»."""

import pytest

from backend.app.models.archive import PrintArchive
from backend.app.models.archive_part import PrintArchivePart
from backend.app.models.customer import Customer
from backend.app.models.product import Product, ProductPart
from backend.app.models.project import Project
from backend.app.models.project_line import ProjectLine
from backend.app.services import line_composition, line_config, order_fulfilment, part_stock
from backend.app.services.order_fulfilment import LineRequest
from backend.app.services.stock_issues import Recipient

pytestmark = pytest.mark.integration


@pytest.fixture
async def lamp(db_session):
    """Lamp: shade ×1 in the kit, a spare handle (zero, counted), a test cube (zero, not counted)."""
    product = Product(name="Lamp")
    db_session.add(product)
    await db_session.flush()
    shade = ProductPart(product_id=product.id, kind="printed", name="shade", name_key="shade", qty_per_unit=1)
    handle = ProductPart(product_id=product.id, kind="printed", name="handle", name_key="handle", qty_per_unit=0)
    cube = ProductPart(
        product_id=product.id, kind="printed", name="cube", name_key="cube", qty_per_unit=0, ignored=True
    )
    db_session.add_all([shade, handle, cube])
    await db_session.commit()
    return {"product": product, "shade": shade, "handle": handle, "cube": cube}


def test_a_zero_without_the_mark_has_a_shelf(lamp):
    assert line_composition.has_shelf(lamp["handle"])
    assert not line_composition.has_shelf(lamp["cube"])
    assert part_stock.is_counted(lamp["handle"])


@pytest.mark.asyncio
async def test_the_shelf_lists_out_of_kit_parts_and_not_the_ignored(db_session, lamp):
    balances = await part_stock.balances(db_session, lamp["product"].id)
    assert set(balances) == {lamp["shade"].id, lamp["handle"].id}
    many = await part_stock.balances_for_products(db_session, [lamp["product"].id])
    assert set(many[lamp["product"].id]) == {lamp["shade"].id, lamp["handle"].id}


@pytest.mark.asyncio
async def test_a_line_cannot_want_an_ignored_part(db_session, lamp):
    order = Project(name="O")
    db_session.add(order)
    await db_session.flush()
    line = ProjectLine(project_id=order.id, product_id=lamp["product"].id, quantity=1, mode="parts")
    db_session.add(line)
    await db_session.flush()
    with pytest.raises(line_config.LineConfigError) as refused:
        await line_config.seed_line(db_session, line, choices=None, counts={lamp["cube"].id: 1})
    assert (refused.value.status, str(refused.value)) == (422, "That part is not counted")


@pytest.mark.asyncio
async def test_a_parts_line_receives_and_issues_its_out_of_kit_part(db_session, lamp):
    # M6: the window and the figures count the same parts.
    acme = Customer(name="Acme")
    db_session.add(acme)
    await db_session.flush()
    order = Project(name="O", customer_id=acme.id)
    db_session.add(order)
    await db_session.flush()
    line = ProjectLine(project_id=order.id, product_id=lamp["product"].id, quantity=1, mode="parts")
    db_session.add(line)
    await db_session.flush()
    await line_config.seed_line(db_session, line, choices=None, counts={lamp["shade"].id: 3, lamp["handle"].id: 2})
    archive = PrintArchive(
        project_id=order.id,
        project_line_id=line.id,
        filename="lamp",
        file_path="",
        file_size=0,
        status="completed",
        quantity=1,
    )
    db_session.add(archive)
    await db_session.flush()
    db_session.add_all(
        [
            PrintArchivePart(archive_id=archive.id, name="shade", name_key="shade", quantity=3),
            PrintArchivePart(archive_id=archive.id, name="handle", name_key="handle", quantity=2),
        ]
    )
    await db_session.flush()
    await db_session.refresh(order, ["lines"])
    state = await order_fulfilment.state(db_session, order)
    [row] = state.lines
    assert {p.name: p.wanted for p in row.parts} == {"shade": 3, "handle": 2}
    assert row.ordered == 5
    await order_fulfilment.apply(
        db_session,
        order,
        [LineRequest(line.id, parts={lamp["shade"].id: (3, 3), lamp["handle"].id: (2, 2)})],
        recipient=Recipient(name="Ivan"),
        waybill=None,
        note=None,
        complete=True,
        actor=None,
    )
    assert order.status == "completed"


@pytest.mark.asyncio
async def test_marking_is_refused_while_the_part_holds_stock_or_is_wanted(committing_client, db_session, lamp):
    handle = lamp["handle"]
    url = f"/api/v1/products/{lamp['product'].id}/parts/{handle.id}"
    await part_stock.move(db_session, part_id=handle.id, delta=2, reason="manual", note="counted")
    await db_session.commit()
    r = await committing_client.patch(url, json={"ignored": True})
    assert (r.status_code, r.json()["detail"]) == (
        409,
        "This part holds stock or is ordered; it cannot be marked as not counted",
    )
    await part_stock.move(db_session, part_id=handle.id, delta=-2, reason="manual", note="gone")
    await db_session.commit()
    order = Project(name="O")
    db_session.add(order)
    await db_session.flush()
    line = ProjectLine(project_id=order.id, product_id=lamp["product"].id, quantity=1, mode="parts")
    db_session.add(line)
    await db_session.flush()
    await line_config.seed_line(db_session, line, choices=None, counts={handle.id: 1})
    await db_session.commit()
    r = await committing_client.patch(url, json={"ignored": True})
    assert r.status_code == 409
    await line_config.forget_line(db_session, line.id)
    await db_session.commit()
    r = await committing_client.patch(url, json={"ignored": True})
    assert r.status_code == 200, r.text
    assert r.json()["ignored"] is True
    r = await committing_client.patch(url, json={"ignored": False})
    assert (r.status_code, r.json()["ignored"]) == (200, False)


@pytest.mark.asyncio
async def test_a_part_in_the_kit_cannot_be_marked(committing_client, lamp):
    base = f"/api/v1/products/{lamp['product'].id}/parts"
    r = await committing_client.patch(f"{base}/{lamp['shade'].id}", json={"ignored": True})
    assert (r.status_code, r.json()["detail"]) == (422, "A part that is not counted cannot be in the kit")
    r = await committing_client.patch(f"{base}/{lamp['cube'].id}", json={"qty_per_unit": 2})
    assert (r.status_code, r.json()["detail"]) == (422, "A part that is not counted cannot be in the kit")
    r = await committing_client.patch(f"{base}/{lamp['cube'].id}", json={"qty_per_unit": 2, "ignored": False})
    assert r.status_code == 200, r.text
    r = await committing_client.post(base, json={"kind": "printed", "name": "jig", "qty_per_unit": 1, "ignored": True})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_the_add_to_order_parts_list_leaves_ignored_parts_out(committing_client, lamp):
    r = await committing_client.get("/api/v1/products/parts", params={"per_page": 200})
    assert r.status_code == 200, r.text
    names = {row["name"] for row in r.json()["items"]}
    assert {"shade", "handle"} <= names and "cube" not in names


@pytest.mark.asyncio
async def test_the_product_page_shows_what_orders_hold(committing_client, db_session, lamp):
    # spec workshop-order-issue-followups, rule 49.
    order = Project(name="O")
    db_session.add(order)
    await db_session.flush()
    line = ProjectLine(project_id=order.id, product_id=lamp["product"].id, quantity=1, mode="parts")
    db_session.add(line)
    await db_session.flush()
    await line_config.seed_line(db_session, line, choices=None, counts={lamp["handle"].id: 2})
    await part_stock.receive_parts_for_line(db_session, line, {lamp["handle"].id: 2}, created_by=None)
    await db_session.commit()
    r = await committing_client.get(f"/api/v1/products/{lamp['product'].id}/stock")
    assert r.status_code == 200, r.text
    rows = {row["name"]: (row["qty_per_unit"], row["balance"], row["held_for_orders"]) for row in r.json()["balances"]}
    assert rows == {"shade": (1, 0, 0), "handle": (0, 0, 2)}
