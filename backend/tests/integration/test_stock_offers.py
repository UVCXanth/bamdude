"""«Взяти зі складу» — what an order has not printed, is not printing and has not queued,
offered off the shelves and taken by adding (spec workshop-order-issue, rules 17, 20)."""

import pytest
from sqlalchemy import func, select

from backend.app.models.archive import PrintArchive
from backend.app.models.archive_part import PrintArchivePart
from backend.app.models.customer import Customer
from backend.app.models.finished_stock import StockItemMovement
from backend.app.models.part_stock import ProductPartStockMovement
from backend.app.models.product import Product, ProductPart
from backend.app.models.project import Project, ProjectEvent
from backend.app.models.project_line import ProjectLine
from backend.app.services import finished_stock, line_config, part_stock, plan_engine, stock_offers
from backend.app.services.order_metrics import LineFigures, PartFigures

pytestmark = pytest.mark.integration


def test_unplanned_units_are_what_no_print_covers_yet():
    figs = LineFigures(line_id=1, product_id=1, quantity=10, material=None)
    figs.parts = [
        PartFigures(part_id=1, name="flask", kind="printed", per=1, remaining=8, in_progress=1),
        PartFigures(part_id=2, name="screw", kind="printed", per=2, remaining=16),
        PartFigures(part_id=3, name="spare", kind="printed", per=0, remaining=0),
    ]
    # flask: 8 − 1 running − 3 queued = 4 units; screw: 16 − 6 queued = 10 parts = 5 units
    assert plan_engine.unplanned_units(figs, {1: 3, 2: 6}) == 5
    assert plan_engine.unplanned_units(figs, {1: 20, 2: 20}) == 0


@pytest.fixture
async def shop(db_session, monkeypatch):
    """Pipe (flask ×1, cap ×1): 4 of each free, 2 ready pipes; an active order with a line
    of 10, 2 printed and — by the plan's own queue reading — 3 queued."""
    pipe = Product(name="Pipe")
    acme = Customer(name="Acme")
    db_session.add_all([pipe, acme])
    await db_session.flush()
    flask = ProductPart(product_id=pipe.id, kind="printed", name="flask", name_key="flask", qty_per_unit=1)
    cap = ProductPart(product_id=pipe.id, kind="printed", name="cap", name_key="cap", qty_per_unit=1)
    db_session.add_all([flask, cap])
    await db_session.flush()
    for part in (flask, cap):
        await part_stock.move(db_session, part_id=part.id, delta=4, reason="manual", note="seed")
    position = await finished_stock.item_for(db_session, pipe.id, {}, create=True)
    await finished_stock.receive(db_session, position, 2)
    order = Project(name="O", customer_id=acme.id)
    db_session.add(order)
    await db_session.flush()
    line = ProjectLine(project_id=order.id, product_id=pipe.id, quantity=10)
    db_session.add(line)
    await db_session.flush()
    await line_config.seed_line(db_session, line, choices=None, counts=None)
    archive = PrintArchive(
        project_id=order.id,
        project_line_id=line.id,
        filename="pipe",
        file_path="",
        file_size=0,
        status="completed",
        quantity=1,
    )
    db_session.add(archive)
    await db_session.flush()
    db_session.add_all(
        [PrintArchivePart(archive_id=archive.id, name=n, name_key=n, quantity=2) for n in ("flask", "cap")]
    )
    await db_session.commit()

    async def queued(db, recipes, lines, counted):
        return {line.id: {flask.id: 3, cap.id: 3}}

    monkeypatch.setattr(plan_engine, "queued_yield_by_line", queued)
    return {"pipe": pipe, "flask": flask, "cap": cap, "order": order, "line": line, "position": position}


def _url(shop, tail):
    return f"/api/v1/projects/{shop['order'].id}/{tail}"


async def _kits(db, line):
    return await part_stock.reserved_units_for_line(db, line)


@pytest.mark.asyncio
async def test_the_offer_covers_what_is_neither_printed_nor_queued(db_session, shop):
    [offer] = await stock_offers.offers(db_session, shop["order"])
    assert (offer.line_id, offer.product_name, offer.from_finished, offer.kits) == (shop["line"].id, "Pipe", 2, 3)


@pytest.mark.asyncio
async def test_taking_adds_and_never_releases(committing_client, db_session, shop):
    r = await committing_client.get(_url(shop, "stock-offers"))
    assert r.json() == [
        {"line_id": shop["line"].id, "product_name": "Pipe", "from_finished": 2, "kits": 3, "parts": {}}
    ]
    r = await committing_client.post(_url(shop, "take-stock"), json={"lines": r.json()})
    assert r.status_code == 200, r.text
    assert r.json()["results"] == [
        {
            "line_id": shop["line"].id,
            "asked_finished": 2,
            "got_finished": 2,
            "asked_kits": 3,
            "got_kits": 3,
            "asked_parts": {},
            "got_parts": {},
        }
    ]
    [line] = r.json()["order"]["lines"]
    assert (line["from_finished"], line["from_kit_units"]) == (2, 3)
    releases = await db_session.scalar(
        select(func.count()).select_from(StockItemMovement).where(StockItemMovement.kind == "release")
    )
    parts_back = await db_session.scalar(
        select(func.count())
        .select_from(ProductPartStockMovement)
        .where(ProductPartStockMovement.reason == "reservation_released")
    )
    assert (releases, parts_back) == (0, 0)
    [event] = (await db_session.execute(select(ProjectEvent).where(ProjectEvent.kind == "stock_taken"))).scalars().all()
    assert event.payload == {"line_id": shop["line"].id, "product": "Pipe", "from_finished": 2, "kits": 3}
    assert (await committing_client.get(_url(shop, "stock-offers"))).json() == []  # nothing left to take


@pytest.mark.asyncio
async def test_taking_on_a_moved_line_keeps_its_configuration_and_counters(committing_client, db_session, shop):
    body = {"lines": [{"line_id": shop["line"].id, "receive": 2}]}
    assert (await committing_client.post(_url(shop, "fulfilment"), json=body)).status_code == 200
    key_before = shop["line"].config_key
    r = await committing_client.post(_url(shop, "take-stock"), json={})
    assert r.status_code == 200, r.text
    line = await db_session.get(ProjectLine, shop["line"].id, populate_existing=True)
    assert (line.config_key, line.received, line.from_finished) == (key_before, 2, 2)
    assert await _kits(db_session, line) == 3


@pytest.mark.asyncio
async def test_a_closed_order_is_offered_nothing(committing_client, db_session, shop):
    shop["order"].status = "cancelled"
    await db_session.commit()
    assert (await committing_client.get(_url(shop, "stock-offers"))).json() == []
    r = await committing_client.post(_url(shop, "take-stock"), json={})
    assert (r.status_code, r.json()["detail"]) == (409, "Only an active order takes finished goods from stock")


@pytest.mark.asyncio
async def test_the_shelf_moving_between_the_offer_and_the_take_clamps(committing_client, db_session, shop):
    shown = (await committing_client.get(_url(shop, "stock-offers"))).json()
    other = Project(name="Other")
    db_session.add(other)
    await db_session.flush()
    rival = ProjectLine(project_id=other.id, product_id=shop["pipe"].id, quantity=1)
    db_session.add(rival)
    await db_session.flush()
    await line_config.seed_line(db_session, rival, choices=None, counts=None)
    assert await finished_stock.reserve_for_line(db_session, rival, 1) == 1
    await db_session.commit()
    r = await committing_client.post(_url(shop, "take-stock"), json={"lines": shown})
    assert r.status_code == 200, r.text
    [taken] = r.json()["results"]
    assert (taken["asked_finished"], taken["got_finished"], taken["asked_kits"], taken["got_kits"]) == (2, 1, 3, 3)
