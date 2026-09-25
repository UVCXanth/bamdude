"""``GET /stock`` and ``GET /stock/movements`` — the farm-wide shelf.

``committing_client``, not ``async_client``: the handlers never commit;
production's ``get_db`` does it after the response (see the conftest fixture
docstrings). The lamp fixture is the products API's own — five lids and three
bases are three kits, the screw is procurement and never appears.
"""

import pytest

from backend.app.models.project import Project
from backend.app.models.project_line import ProjectLine
from backend.app.services.part_stock import move, release_for_line, reserve_for_line
from backend.tests.integration.test_products_api import _lamp_with_stock


async def _order_with_line(db, product_id: int, *, name: str, status: str = "active") -> ProjectLine:
    project = Project(name=name, status=status)
    db.add(project)
    await db.flush()
    line = ProjectLine(project_id=project.id, product_id=product_id, quantity=5)
    db.add(line)
    await db.flush()
    return line


@pytest.mark.asyncio
async def test_summary_lists_counted_products_with_balances_and_kits(committing_client, db_session):
    pid, ids = await _lamp_with_stock(committing_client, db_session)
    # A product with nothing to count has no shelf and is not a row.
    bare = (await committing_client.post("/api/v1/products/", json={"name": "Bare"})).json()["id"]

    body = (await committing_client.get("/api/v1/stock")).json()
    rows = {p["id"]: p for p in body["products"]}
    assert pid in rows and bare not in rows
    lamp = rows[pid]
    assert lamp["name"] == "Lamp" and lamp["kits_available"] == 3
    assert {(b["name"], b["balance"]) for b in lamp["parts"]} == {("lid", 5), ("base", 3)}
    assert lamp["reservations"] == []


@pytest.mark.asyncio
async def test_with_stock_hides_an_empty_shelf_by_default(committing_client, db_session):
    stocked, _ = await _lamp_with_stock(committing_client, db_session, name="Stocked")
    empty, _ = await _lamp_with_stock(committing_client, db_session, name="Empty", lids=0, bases=0)

    default = {p["id"] for p in (await committing_client.get("/api/v1/stock")).json()["products"]}
    assert stocked in default and empty not in default

    everything = {p["id"] for p in (await committing_client.get("/api/v1/stock?with_stock=false")).json()["products"]}
    assert {stocked, empty} <= everything


@pytest.mark.asyncio
async def test_reservations_come_from_active_orders_only(committing_client, db_session):
    pid, _ = await _lamp_with_stock(committing_client, db_session)
    active = await _order_with_line(db_session, pid, name="Active order")
    done = await _order_with_line(db_session, pid, name="Shipped order", status="completed")
    await reserve_for_line(db_session, active, 2)
    await reserve_for_line(db_session, done, 1)
    await db_session.commit()

    lamp = next(p for p in (await committing_client.get("/api/v1/stock")).json()["products"] if p["id"] == pid)
    assert lamp["reservations"] == [
        {"line_id": active.id, "order_id": active.project_id, "order_name": "Active order", "kits": 2}
    ]
    # The shelf nets both reservations regardless: 5 lids − 3 reserved, 3 bases − 3.
    assert lamp["kits_available"] == 0
    assert {(b["name"], b["balance"]) for b in lamp["parts"]} == {("lid", 2), ("base", 0)}


@pytest.mark.asyncio
async def test_a_reservation_alone_keeps_a_product_on_the_tab(committing_client, db_session):
    """Kits out on loan are still the shelf's business: a product whose whole
    stock is reserved has zero balances and must not vanish with ``with_stock``."""
    pid, _ = await _lamp_with_stock(committing_client, db_session, lids=1, bases=1)
    line = await _order_with_line(db_session, pid, name="Takes it all")
    await reserve_for_line(db_session, line, 1)
    await db_session.commit()

    rows = {p["id"]: p for p in (await committing_client.get("/api/v1/stock")).json()["products"]}
    assert pid in rows and rows[pid]["kits_available"] == 0 and rows[pid]["reservations"][0]["kits"] == 1


@pytest.mark.asyncio
async def test_search_and_order(committing_client, db_session):
    await _lamp_with_stock(committing_client, db_session, name="Zebra lamp", lids=1, bases=1)
    await _lamp_with_stock(committing_client, db_session, name="Apple lamp", lids=1, bases=1)
    await _lamp_with_stock(committing_client, db_session, name="Big lamp", lids=9, bases=9)

    names = [p["name"] for p in (await committing_client.get("/api/v1/stock")).json()["products"]]
    assert names == ["Big lamp", "Apple lamp", "Zebra lamp"], "kits desc, then name asc"

    found = [p["name"] for p in (await committing_client.get("/api/v1/stock?q=ZEB")).json()["products"]]
    assert found == ["Zebra lamp"]


@pytest.mark.asyncio
async def test_search_folds_cyrillic_case(committing_client, db_session):
    # SQLite's built-in lower() is ASCII-only; the app shadows it on every
    # connection (core/case_folding.py). Before that, ?q=ЛАМПА found nothing.
    await _lamp_with_stock(committing_client, db_session, name="Лампа настільна", lids=1, bases=1)
    found = [p["name"] for p in (await committing_client.get("/api/v1/stock?q=ЛАМПА")).json()["products"]]
    assert found == ["Лампа настільна"]


@pytest.mark.asyncio
async def test_journal_is_newest_first_with_product_names_and_pages_by_id(committing_client, db_session):
    pid, ids = await _lamp_with_stock(committing_client, db_session, lids=0, bases=0)
    for delta in (1, 2, 3):
        await move(db_session, part_id=ids["lid"], delta=delta, reason="unfiled_print")
    await db_session.commit()

    first = (await committing_client.get("/api/v1/stock/movements?limit=2")).json()
    assert [r["delta"] for r in first["items"]] == [3, 2]
    assert first["items"][0]["product_id"] == pid and first["items"][0]["product_name"] == "Lamp"
    assert first["items"][0]["part_name"] == "lid"
    assert first["next_before_id"] == first["items"][-1]["id"]

    rest = (await committing_client.get(f"/api/v1/stock/movements?limit=2&before_id={first['next_before_id']}")).json()
    assert [r["delta"] for r in rest["items"]] == [1]
    assert rest["next_before_id"] is None


@pytest.mark.asyncio
async def test_journal_filters_and_resolves_the_order(committing_client, db_session):
    lamp, lamp_ids = await _lamp_with_stock(committing_client, db_session, name="Lamp", lids=4, bases=4)
    vase, _ = await _lamp_with_stock(committing_client, db_session, name="Vase", lids=1, bases=1)
    line = await _order_with_line(db_session, lamp, name="Order 7")
    await reserve_for_line(db_session, line, 1)
    await db_session.commit()

    by_product = (await committing_client.get(f"/api/v1/stock/movements?product_id={lamp}")).json()["items"]
    assert {r["product_id"] for r in by_product} == {lamp}
    by_part = (await committing_client.get(f"/api/v1/stock/movements?part_id={lamp_ids['base']}")).json()["items"]
    assert {r["part_name"] for r in by_part} == {"base"}
    reserved = (await committing_client.get("/api/v1/stock/movements?reason=reserved_for_order")).json()["items"]
    assert reserved and all(r["reason"] == "reserved_for_order" for r in reserved)
    assert reserved[0]["order_id"] == line.project_id and reserved[0]["order_name"] == "Order 7"
    assert vase not in {r["product_id"] for r in reserved}


@pytest.mark.asyncio
async def test_journal_refuses_an_unknown_reason(committing_client):
    r = await committing_client.get("/api/v1/stock/movements?reason=teleported")
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_a_cancelled_orders_released_reservation_is_not_listed(committing_client, db_session):
    pid, _ids = await _lamp_with_stock(committing_client, db_session)
    line = await _order_with_line(db_session, pid, name="Cancel me")
    await reserve_for_line(db_session, line, 2)
    await db_session.commit()

    project = await db_session.get(Project, line.project_id)
    project.status = "cancelled"
    await release_for_line(db_session, line, note="order_cancelled")
    await db_session.commit()

    lamp = next(p for p in (await committing_client.get("/api/v1/stock")).json()["products"] if p["id"] == pid)
    assert lamp["reservations"] == []
    assert lamp["kits_available"] == 3
    assert {(b["name"], b["balance"]) for b in lamp["parts"]} == {("lid", 5), ("base", 3)}


@pytest.mark.asyncio
async def test_kits_are_the_scarcest_part_divided_by_its_per_unit(committing_client, db_session):
    pid = (await committing_client.post("/api/v1/products/", json={"name": "Gadget"})).json()["id"]
    lid = (
        await committing_client.post(
            f"/api/v1/products/{pid}/parts", json={"kind": "printed", "name": "lid", "qty_per_unit": 2}
        )
    ).json()["id"]
    base = (
        await committing_client.post(
            f"/api/v1/products/{pid}/parts", json={"kind": "printed", "name": "base", "qty_per_unit": 1}
        )
    ).json()["id"]
    await move(db_session, part_id=lid, delta=5, reason="unfiled_print")
    await move(db_session, part_id=base, delta=3, reason="unfiled_print")
    await db_session.commit()

    lamp = next(p for p in (await committing_client.get("/api/v1/stock")).json()["products"] if p["id"] == pid)
    assert lamp["kits_available"] == 2


# ---- WS-01: the paged list and the shelf tiles ----


@pytest.mark.asyncio
async def test_without_page_the_flat_answer_is_unchanged(committing_client, db_session):
    await _lamp_with_stock(committing_client, db_session)
    flat = (await committing_client.get("/api/v1/stock")).json()
    assert set(flat) == {"products"}
    assert "reserved_kits" not in flat["products"][0]
    # The paged params mean nothing without `page`.
    same = (await committing_client.get("/api/v1/stock?sort_by=name-asc&per_page=1")).json()
    assert same == flat


@pytest.mark.asyncio
async def test_page_gives_the_envelope_with_reserved_kits(committing_client, db_session):
    pid, _ = await _lamp_with_stock(committing_client, db_session, name="Lamp", lids=5, bases=5)
    line = await _order_with_line(db_session, pid, name="Holds two")
    await reserve_for_line(db_session, line, 2)
    await db_session.commit()
    await _lamp_with_stock(committing_client, db_session, name="Vase", lids=1, bases=1)

    body = (await committing_client.get("/api/v1/stock?page=1&per_page=1")).json()
    assert body["meta"] == {"total": 2, "current_page": 1, "per_page": 1, "last_page": 2}
    assert [(p["name"], p["reserved_kits"]) for p in body["items"]] == [("Lamp", 2)]  # kits-desc: 3 before 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("key", "ascending"),
    [
        ("kits", ["Charlie", "Alpha", "Bravo"]),
        ("name", ["Alpha", "Bravo", "Charlie"]),
        ("reserved", ["Bravo", "Charlie", "Alpha"]),
    ],
)
async def test_every_stock_key_orders_both_ways_and_keeps_the_set(committing_client, db_session, key, ascending):
    # Charlie 1/1 reserves 1 (kits 0), Alpha 3/3 reserves 2 (kits 1), Bravo 5/5
    # reserves nothing (kits 5): each key orders the three differently, so a key
    # wired to the wrong figure cannot pass.
    names = []
    for i, name in enumerate(("Charlie", "Alpha", "Bravo")):
        pid, _ = await _lamp_with_stock(committing_client, db_session, name=name, lids=1 + i * 2, bases=1 + i * 2)
        if i < 2:
            line = await _order_with_line(db_session, pid, name=f"order-{name}")
            await reserve_for_line(db_session, line, i + 1)
            # Commit now: the next product is created through the client, whose
            # request session shares the test connection and rolls back on close.
            await db_session.commit()
        names.append(name)
    asc = [p["name"] for p in (await committing_client.get(f"/api/v1/stock?page=1&sort_by={key}-asc")).json()["items"]]
    desc = [
        p["name"] for p in (await committing_client.get(f"/api/v1/stock?page=1&sort_by={key}-desc")).json()["items"]
    ]
    assert sorted(asc) == sorted(names)
    assert asc == ascending
    assert desc == list(reversed(ascending))


@pytest.mark.asyncio
async def test_unknown_stock_sort_is_kits_desc_and_all_gives_everything(committing_client, db_session):
    await _lamp_with_stock(committing_client, db_session, name="Small", lids=1, bases=1)
    await _lamp_with_stock(committing_client, db_session, name="Big", lids=9, bases=9)
    body = (await committing_client.get("/api/v1/stock?page=4&per_page=1&all=true&sort_by=bogus")).json()
    assert [p["name"] for p in body["items"]] == ["Big", "Small"]
    assert body["meta"] == {"total": 2, "current_page": 1, "per_page": 2, "last_page": 1}


@pytest.mark.asyncio
async def test_stock_figures_summarise_the_whole_shelf(committing_client, db_session):
    lamp, _ = await _lamp_with_stock(committing_client, db_session, name="Lamp", lids=5, bases=3)  # 3 kits
    line = await _order_with_line(db_session, lamp, name="Holds one")
    await reserve_for_line(db_session, line, 1)  # shelf: 4 lids, 2 bases → 2 kits
    await db_session.commit()
    await _lamp_with_stock(committing_client, db_session, name="Half", lids=2, bases=0)  # parts, no kit
    await _lamp_with_stock(committing_client, db_session, name="Empty", lids=0, bases=0)

    r = await committing_client.get("/api/v1/stock/figures?q=Lamp&with_stock=true")
    assert r.status_code == 200
    assert r.json() == {"kits": 2, "kit_products": 1, "parts": 8, "reserved_kits": 1, "incomplete": 1}
