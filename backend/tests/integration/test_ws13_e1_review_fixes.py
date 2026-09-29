"""The final review of WS-13 E1 (2026-09-29): refusals the lock protocol promises as 409
reached the operator as 500, a door read its order before the gates it then relied on,
the job-order wizard seeded parts into other products, and an estimate with nothing to
plan answered known zeros."""

from __future__ import annotations

import pytest
from sqlalchemy import delete, insert, select, update

from backend.app.api.routes import projects as project_routes
from backend.app.models.library import LibraryFile
from backend.app.models.product import Product, ProductPart
from backend.app.models.project import Project
from backend.app.models.project_line import ProjectLine
from backend.app.services import finished_stock, line_intake, order_fulfilment, product_delete, product_gate

pytestmark = pytest.mark.integration

_ORDER_CHANGED = order_fulfilment.ORDER_CHANGED


@pytest.fixture
async def shop(db_session):
    """An active order with one line of «Lamp» (one printed part), and «Stool» — another
    product with a part, on no line yet."""
    lamp, stool = Product(name="Lamp"), Product(name="Stool")
    db_session.add_all([lamp, stool])
    await db_session.flush()
    db_session.add_all(
        [
            ProductPart(product_id=lamp.id, kind="printed", name="shade", name_key="shade", qty_per_unit=1),
            ProductPart(product_id=stool.id, kind="printed", name="leg", name_key="leg", qty_per_unit=4),
        ]
    )
    order = Project(name="Order", status="active")
    db_session.add(order)
    await db_session.commit()
    return {"lamp": lamp.id, "stool": stool.id, "order": order.id}


async def _add_line(client, order_id, product_id, quantity=1):
    r = await client.post(f"/api/v1/projects/{order_id}/lines", json={"product_id": product_id, "quantity": quantity})
    assert r.status_code in (200, 201), r.text
    return r.json()


async def _raw_line(db, order_id, product_id):
    """A line another request committed meanwhile — written past this session's ORM."""
    await db.execute(
        insert(ProjectLine.__table__).values(
            project_id=order_id, product_id=product_id, quantity=1, mode="product", sort_order=9
        )
    )


def _is_busy(r):
    return r.status_code == 409 and r.json().get("detail", {}).get("error") == "product_busy"


# ---------- Important 1: a one-off product's cascade answers 409 product_busy ----------


@pytest.mark.asyncio
async def test_deleting_a_line_whose_product_is_busy_answers_product_busy(committing_client, shop, monkeypatch):
    body = await _add_line(committing_client, shop["order"], shop["lamp"])
    line_id = body["lines"][0]["id"]

    async def busy(db, product_ids):
        raise product_gate.ProductBusy("product_parts")

    monkeypatch.setattr(product_delete, "delete_orphaned_adhoc_products", busy)
    r = await committing_client.delete(f"/api/v1/projects/{shop['order']}/lines/{line_id}")
    assert _is_busy(r), (r.status_code, r.text)


@pytest.mark.asyncio
async def test_deleting_an_order_whose_product_is_busy_answers_product_busy(committing_client, shop, monkeypatch):
    await _add_line(committing_client, shop["order"], shop["lamp"])

    async def busy(db, product_ids):
        raise product_gate.ProductBusy("product_parts")

    monkeypatch.setattr(product_delete, "delete_orphaned_adhoc_products", busy)
    r = await committing_client.delete(f"/api/v1/projects/{shop['order']}")
    assert _is_busy(r), (r.status_code, r.text)


# ---------- Important 2: a cancel that finds the stock changed answers 409 ----------


@pytest.mark.asyncio
async def test_a_cancel_that_finds_the_stock_changed_answers_409(committing_client, shop, monkeypatch):
    await _add_line(committing_client, shop["order"], shop["lamp"])

    async def changed(db, lines):
        raise finished_stock.FinishedStockError(finished_stock.STOCK_CHANGED, 409)

    monkeypatch.setattr(finished_stock, "lock_lines_with_parts", changed)
    r = await committing_client.patch(f"/api/v1/projects/{shop['order']}", json={"status": "cancelled"})
    assert r.status_code == 409, (r.status_code, r.text)


# ---------- Minor 5: a door reads its order again after the gates ----------


@pytest.mark.asyncio
async def test_completion_refuses_an_order_that_gained_a_product_behind_its_gates(
    committing_client, db_session, shop, monkeypatch
):
    await _add_line(committing_client, shop["order"], shop["lamp"])
    real = order_fulfilment.lock_order

    async def meanwhile(db, project_id):
        await _raw_line(db, project_id, shop["stool"])
        return await real(db, project_id)

    monkeypatch.setattr(order_fulfilment, "lock_order", meanwhile)
    r = await committing_client.patch(f"/api/v1/projects/{shop['order']}", json={"status": "completed"})
    assert (r.status_code, r.json()["detail"]) == (409, _ORDER_CHANGED)


@pytest.mark.asyncio
async def test_deleting_an_order_that_gained_a_product_behind_its_gates_is_refused(
    committing_client, db_session, shop, monkeypatch
):
    await _add_line(committing_client, shop["order"], shop["lamp"])
    real = project_routes.product_gate

    async def meanwhile(db, product_ids):
        await real(db, product_ids)
        await _raw_line(db, shop["order"], shop["stool"])

    monkeypatch.setattr(project_routes, "product_gate", meanwhile)
    r = await committing_client.delete(f"/api/v1/projects/{shop['order']}")
    assert (r.status_code, r.json()["detail"]) == (409, _ORDER_CHANGED)
    assert await db_session.get(Project, shop["order"]) is not None


@pytest.mark.asyncio
async def test_a_copy_refuses_a_source_that_gained_a_product_behind_its_gates(
    committing_client, db_session, shop, monkeypatch
):
    await _add_line(committing_client, shop["order"], shop["lamp"])
    real = project_routes.product_gate

    async def meanwhile(db, product_ids):
        await real(db, product_ids)
        await _raw_line(db, shop["order"], shop["stool"])

    monkeypatch.setattr(project_routes, "product_gate", meanwhile)
    r = await committing_client.post(f"/api/v1/projects/{shop['order']}/duplicate", json={})
    assert (r.status_code, r.json()["detail"]) == (409, _ORDER_CHANGED)


@pytest.mark.asyncio
async def test_lines_are_not_added_to_an_order_deleted_behind_the_gates(
    committing_client, db_session, shop, monkeypatch
):
    real = line_intake.product_gate

    async def meanwhile(db, product_ids):
        await real(db, product_ids)
        await db.execute(delete(Project.__table__).where(Project.id == shop["order"]))

    monkeypatch.setattr(line_intake, "product_gate", meanwhile)
    r = await committing_client.post(
        f"/api/v1/projects/{shop['order']}/lines", json={"product_id": shop["lamp"], "quantity": 1}
    )
    assert r.status_code == 404, (r.status_code, r.text)
    orphans = (await db_session.execute(select(ProjectLine.id).where(ProjectLine.project_id == shop["order"]))).all()
    assert orphans == []


@pytest.mark.asyncio
async def test_lines_added_to_an_order_cancelled_behind_the_gates_take_no_stock(
    committing_client, db_session, shop, monkeypatch
):
    real = line_intake.product_gate
    asked = []

    async def meanwhile(db, product_ids):
        await real(db, product_ids)
        await db.execute(update(Project.__table__).where(Project.id == shop["order"]).values(status="cancelled"))

    async def spy(db, line, spec):
        asked.append(line.id)
        return 0, 0

    monkeypatch.setattr(line_intake, "product_gate", meanwhile)
    monkeypatch.setattr(line_intake, "_asked", spy)
    await committing_client.post(
        f"/api/v1/projects/{shop['order']}/lines", json={"product_id": shop["lamp"], "quantity": 1}
    )
    assert asked == [], "a line of an order no longer active reserves nothing"


# ---------- Important 3: the job-order wizard seeds its own product only ----------


@pytest.mark.asyncio
async def test_a_job_order_seeds_its_own_parts_not_the_catalogue_products(committing_client, db_session):
    """The file already belongs to a catalogue product that lacks one of its objects:
    the wizard's one-off product must not seed it back (WS-13 E1 BL8 б)."""
    from backend.app.services.product_sync import sync_product_for_file

    f = LibraryFile(
        filename="job.gcode.3mf",
        file_path="job.gcode.3mf",
        file_size=1,
        file_type="gcode",
        file_metadata={"plates": [{"index": 1, "printable_objects": {"1": "flask", "2": "cap"}}]},
    )
    catalogue = Product(name="Catalogue flask")
    db_session.add_all([f, catalogue])
    await db_session.flush()
    await sync_product_for_file(db_session, library_file_id=f.id, product_ids=[catalogue.id])
    await db_session.flush()
    await db_session.execute(
        delete(ProductPart.__table__).where(ProductPart.product_id == catalogue.id, ProductPart.name_key == "cap")
    )
    await db_session.commit()

    r = await committing_client.post(
        "/api/v1/projects/from-files",
        json={"kind": "job", "name": "Job", "file_ids": [f.id], "targets": {"flask": 2}},
    )
    assert r.status_code in (200, 201), r.text
    kept = set(await db_session.scalars(select(ProductPart.name_key).where(ProductPart.product_id == catalogue.id)))
    assert kept == {"flask"}, "the catalogue product got a part seeded behind its back"
