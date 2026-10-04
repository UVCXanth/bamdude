"""GET /projects paged mode (spec projects-lists-parity, rules 1–7).

``page`` is the compat switch: without it the flat array every existing
consumer reads is untouched; with it the archive's envelope plus tab totals.
"""

from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

from backend.app.models.customer import Customer
from backend.app.models.project import Project

pytestmark = pytest.mark.integration


async def _customer(db_session, name):
    c = Customer(name=name)
    db_session.add(c)
    await db_session.commit()
    await db_session.refresh(c)
    return c


async def _order(db_session, name, *, status="active", customer=None, priority="normal"):
    p = Project(name=name, status=status, priority=priority, customer_id=customer.id if customer else None)
    db_session.add(p)
    await db_session.commit()
    await db_session.refresh(p)
    return p


@pytest.mark.asyncio
async def test_without_page_the_flat_shape_is_unchanged(async_client, db_session):
    await _order(db_session, "A")
    flat = await async_client.get("/api/v1/projects/")
    assert flat.status_code == 200
    assert isinstance(flat.json(), list)
    assert set(flat.json()[0]) >= {"id", "name", "status", "progress", "prints_queued"}


@pytest.mark.asyncio
async def test_page_gives_the_envelope_with_tab_totals_under_the_filters(async_client, db_session):
    acme = await _customer(db_session, "ACME")
    other = await _customer(db_session, "Other")
    await _order(db_session, "a1", customer=acme)
    await _order(db_session, "a2", customer=acme, status="completed")
    await _order(db_session, "o1", customer=other)

    r = await async_client.get(f"/api/v1/projects/?page=1&per_page=24&customer_id={acme.id}&status=active")
    body = r.json()
    assert r.status_code == 200
    assert [o["name"] for o in body["items"]] == ["a1"]
    assert body["meta"] == {"total": 1, "current_page": 1, "per_page": 24, "last_page": 1}
    # Tabs count under the customer filter, ignoring the status filter.
    # The stage counts follow the same filters, active orders only (spec workshop-order-stage, rule 27).
    assert body["totals"] == {
        "active": 1,
        "completed": 1,
        "cancelled": 0,
        "all": 2,
        "stages": {"prep": 1, "printing": 0, "qc": 0},
    }


@pytest.mark.asyncio
async def test_q_matches_order_name_or_customer_name(async_client, db_session):
    acme = await _customer(db_session, "ACME Robotics")
    await _order(db_session, "Gearbox", customer=acme)
    await _order(db_session, "Lamp")
    by_customer = (await async_client.get("/api/v1/projects/?page=1&q=robot")).json()
    by_name = (await async_client.get("/api/v1/projects/?page=1&q=LAMP")).json()
    assert [o["name"] for o in by_customer["items"]] == ["Gearbox"]
    assert [o["name"] for o in by_name["items"]] == ["Lamp"]
    # The tabs follow the search too.
    assert by_customer["totals"]["all"] == 1


@pytest.mark.asyncio
async def test_priority_sorts_by_rank_not_alphabet(async_client, db_session):
    for name, priority in (("n", "normal"), ("u", "urgent"), ("l", "low"), ("h", "high")):
        await _order(db_session, name, priority=priority)
    body = (await async_client.get("/api/v1/projects/?page=1&sort_by=priority-desc")).json()
    assert [o["priority"] for o in body["items"]] == ["urgent", "high", "normal", "low"]


@pytest.mark.asyncio
async def test_a_computed_key_sorts_by_its_figure(async_client, db_session, monkeypatch):
    """``queued`` is not a column — the route computes every row's figures, sorts
    by the one asked for, then cuts the page."""
    from backend.app.api.routes import projects as route_module

    orders = [await _order(db_session, f"o{i}") for i in range(4)]
    queued = {orders[0].id: 2, orders[1].id: 9, orders[2].id: 0, orders[3].id: 5}

    async def figures(db, *, project_ids):
        return [
            SimpleNamespace(
                project_id=pid,
                ordered=0,
                printed=0,
                covered_units=0,
                remaining=0,
                from_stock_units=0,
                prints_in_progress=0,
                prints_queued=queued[pid],
                bankable_surplus=0,
                progress=0.0,
            )
            for pid in project_ids
        ]

    monkeypatch.setattr(route_module, "grouped_figures", figures)

    body = (await async_client.get("/api/v1/projects/?page=1&per_page=2&sort_by=queued-desc")).json()
    assert [o["prints_queued"] for o in body["items"]] == [9, 5]
    assert body["meta"]["total"] == 4 and body["meta"]["last_page"] == 2


@pytest.mark.asyncio
async def test_search_and_customer_sort_together(async_client, db_session):
    """Both need the customer join — it must be made once."""
    acme = await _customer(db_session, "ACME")
    await _order(db_session, "Gearbox", customer=acme)
    await _order(db_session, "Gear shelf")
    r = await async_client.get("/api/v1/projects/?page=1&q=gear&sort_by=customer-asc")
    assert r.status_code == 200, r.text
    assert [o["name"] for o in r.json()["items"]] == ["Gearbox", "Gear shelf"]  # NULL customer last


@pytest.mark.asyncio
async def test_pages_never_overlap_or_skip_on_ties(async_client, db_session):
    for _ in range(7):
        await _order(db_session, "same")  # identical name → id decides
    seen = []
    for page in (1, 2, 3):
        body = (await async_client.get(f"/api/v1/projects/?page={page}&per_page=3&sort_by=name-asc")).json()
        seen += [o["id"] for o in body["items"]]
    assert len(seen) == 7 and len(set(seen)) == 7
    assert body["meta"]["last_page"] == 3


@pytest.mark.asyncio
async def test_unknown_sort_is_the_default_not_a_400(async_client, db_session):
    await _order(db_session, "x")
    r = await async_client.get("/api/v1/projects/?page=1&sort_by=bogus")
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_all_gives_everything_with_an_honest_meta(async_client, db_session):
    for i in range(5):
        await _order(db_session, f"o{i}")
    body = (await async_client.get("/api/v1/projects/?page=3&per_page=2&all=true")).json()
    assert len(body["items"]) == 5
    assert body["meta"] == {"total": 5, "current_page": 1, "per_page": 5, "last_page": 1}


# ---- final-review fix pass: pin the flat shape, prove every sort flips ----

T0 = datetime(2026, 1, 1, 12, 0, 0)


async def _dated_order(db_session, name, *, i, customer=None, priority="normal"):
    p = Project(
        name=name,
        status="active",
        priority=priority,
        customer_id=customer.id if customer else None,
        created_at=T0 + timedelta(days=i),
        updated_at=T0 + timedelta(days=10 - i),
        due_date=T0 + timedelta(days=20 + i),
    )
    db_session.add(p)
    await db_session.commit()
    await db_session.refresh(p)
    return p


@pytest.mark.asyncio
async def test_the_flat_answer_is_pinned_and_ignores_the_paged_params(async_client, db_session):
    """Rule 1 byte for byte: the order (updated_at desc), the key set, and that
    `q` / `sort_by` mean nothing without `page` — twenty flat readers rely on it."""
    from backend.app.schemas.project import ProjectListResponse

    rows = [await _dated_order(db_session, n, i=i) for i, n in enumerate(("b-first", "a-second", "c-third"))]
    flat = (await async_client.get("/api/v1/projects/")).json()
    assert [o["id"] for o in flat] == [r.id for r in rows]  # updated_at desc: i=0 is the newest
    assert set(flat[0]) == set(ProjectListResponse.model_fields)
    same = (await async_client.get("/api/v1/projects/?q=zzz&sort_by=name-asc&per_page=1")).json()
    assert same == flat


def test_every_computed_key_has_exactly_one_source():
    from backend.app.api.routes.projects import _ORDER_COMPUTED, _ORDER_FORECAST, _ORDER_SORT

    assert set(_ORDER_COMPUTED) | set(_ORDER_FORECAST) == _ORDER_SORT.computed
    assert not set(_ORDER_COMPUTED) & set(_ORDER_FORECAST)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "key", ["updated", "created", "name", "due", "priority", "customer", "progress", "remaining", "printing", "queued"]
)
async def test_every_sort_key_really_orders_both_ways(async_client, db_session, monkeypatch, key):
    """Distinct values for every key, so ascending must be descending reversed —
    a key that silently fell back to the default would answer the same list twice."""
    from backend.app.api.routes import projects as route_module

    customers = [await _customer(db_session, f"cust-{c}") for c in "dbac"]
    orders = [
        await _dated_order(db_session, f"o{i}", i=i, customer=customers[i], priority=p)
        for i, p in enumerate(("low", "urgent", "normal", "high"))
    ]
    figure = {o.id: i for i, o in enumerate(orders)}

    async def figures(db, *, project_ids):
        return [
            SimpleNamespace(
                project_id=pid,
                ordered=10,
                printed=0,
                covered_units=0,
                remaining=figure[pid] * 3,
                from_stock_units=0,
                prints_in_progress=figure[pid] + 1,
                prints_queued=10 - figure[pid],
                bankable_surplus=0,
                progress=figure[pid] / 10,
            )
            for pid in project_ids
        ]

    monkeypatch.setattr(route_module, "grouped_figures", figures)
    asc = [o["id"] for o in (await async_client.get(f"/api/v1/projects/?page=1&sort_by={key}-asc")).json()["items"]]
    desc = [o["id"] for o in (await async_client.get(f"/api/v1/projects/?page=1&sort_by={key}-desc")).json()["items"]]
    assert len(asc) == 4
    assert asc == list(reversed(desc))


@pytest.mark.asyncio
async def test_names_sort_without_regard_to_case(async_client, db_session):
    acme = await _customer(db_session, "acme")
    zulu = await _customer(db_session, "Zulu")
    for name, customer in (("apple", zulu), ("Zebra", acme), ("banana", None)):
        await _order(db_session, name, customer=customer)
    by_name = (await async_client.get("/api/v1/projects/?page=1&sort_by=name-asc")).json()["items"]
    assert [o["name"] for o in by_name] == ["apple", "banana", "Zebra"]
    by_customer = (await async_client.get("/api/v1/projects/?page=1&sort_by=customer-asc")).json()["items"]
    assert [o["customer_name"] for o in by_customer] == ["acme", "Zulu", None]


@pytest.mark.asyncio
async def test_search_folds_cyrillic_case(async_client, db_session):
    shop = await _customer(db_session, "Ламповий цех")
    await _order(db_session, "Абажур", customer=shop)
    await _order(db_session, "лампа настільна")
    by_customer = (await async_client.get("/api/v1/projects/?page=1&q=ЛАМПОВИЙ")).json()["items"]
    by_name = (await async_client.get("/api/v1/projects/?page=1&q=ЛАМПА")).json()["items"]
    assert [o["name"] for o in by_customer] == ["Абажур"]
    assert [o["name"] for o in by_name] == ["лампа настільна"]


# ---- WS-01: sort by the farm forecast, search the tags ----


async def _forecast_fake(monkeypatch, values: dict[int, SimpleNamespace]):
    """Replace the simulation; record every set of ids it is asked about."""
    from backend.app.services import farm_forecast

    asked: list[list[int]] = []

    async def fake(db, project_ids, now):
        asked.append(sorted(project_ids))
        return None, {pid: values[pid] for pid in project_ids if pid in values}

    monkeypatch.setattr(farm_forecast, "forecast_projects", fake)
    return asked


@pytest.mark.asyncio
async def test_ready_sorts_the_whole_filtered_set_not_the_page(async_client, db_session, monkeypatch):
    orders = [await _dated_order(db_session, f"o{i}", i=i) for i in range(4)]  # due: o0 soonest
    closed = await _order(db_session, "closed", status="completed")
    eta = {
        orders[0].id: T0 + timedelta(days=9),
        orders[1].id: None,  # the simulation could place nothing
        orders[2].id: T0 + timedelta(days=1),
        orders[3].id: T0 + timedelta(days=5),
    }
    asked = await _forecast_fake(
        monkeypatch,
        {pid: SimpleNamespace(now_eta=when, eta_complete=True, machine_seconds=None) for pid, when in eta.items()},
    )
    pages = [
        [
            o["id"]
            for o in (await async_client.get(f"/api/v1/projects/?page={p}&per_page=2&sort_by=ready-asc")).json()[
                "items"
            ]
        ]
        for p in (1, 2, 3)
    ]
    # Soonest ETA first across pages; no value (None ETA, closed order) last, by id.
    assert pages == [[orders[2].id, orders[3].id], [orders[0].id, orders[1].id], [closed.id]]
    assert asked[0] == sorted(o.id for o in orders), "one walk, active orders only"

    desc = [o["id"] for o in (await async_client.get("/api/v1/projects/?page=1&sort_by=ready-desc")).json()["items"]]
    assert desc == [orders[0].id, orders[3].id, orders[2].id, orders[1].id, closed.id]  # no value last both ways


@pytest.mark.asyncio
async def test_an_incomplete_eta_has_no_value_and_hours_sorts_machine_time(async_client, db_session, monkeypatch):
    a, b, c = [await _order(db_session, n) for n in "abc"]
    await _forecast_fake(
        monkeypatch,
        {
            a.id: SimpleNamespace(now_eta=T0, eta_complete=False, machine_seconds=50),
            b.id: SimpleNamespace(now_eta=T0 + timedelta(days=1), eta_complete=True, machine_seconds=900),
            c.id: SimpleNamespace(now_eta=T0 + timedelta(days=2), eta_complete=True, machine_seconds=None),
        },
    )
    ready = [o["id"] for o in (await async_client.get("/api/v1/projects/?page=1&sort_by=ready-asc")).json()["items"]]
    assert ready == [b.id, c.id, a.id]
    hours = [o["id"] for o in (await async_client.get("/api/v1/projects/?page=1&sort_by=hours-desc")).json()["items"]]
    assert hours == [b.id, a.id, c.id]


@pytest.mark.asyncio
async def test_no_active_order_means_no_simulation(async_client, db_session, monkeypatch):
    done = [await _order(db_session, n, status="completed") for n in ("x", "y")]
    asked = await _forecast_fake(monkeypatch, {})
    r = await async_client.get("/api/v1/projects/?page=1&status=completed&sort_by=ready-asc")
    assert r.status_code == 200
    assert [o["id"] for o in r.json()["items"]] == [d.id for d in done]
    assert asked == []


@pytest.mark.asyncio
async def test_other_keys_never_run_the_simulation(async_client, db_session, monkeypatch):
    await _order(db_session, "a")
    asked = await _forecast_fake(monkeypatch, {})
    for key in ("name-asc", "progress-desc", "due-asc"):
        assert (await async_client.get(f"/api/v1/projects/?page=1&sort_by={key}")).status_code == 200
    assert asked == []


@pytest.mark.asyncio
async def test_q_matches_tags_too(async_client, db_session):
    tagged = Project(name="Plain", status="active", tags="batch-7, Промо")
    db_session.add(tagged)
    await db_session.commit()
    await _order(db_session, "Other")
    body = (await async_client.get("/api/v1/projects/?page=1&q=ПРОМО")).json()
    assert [o["name"] for o in body["items"]] == ["Plain"]
    assert body["totals"]["all"] == 1  # the tabs follow the same search


@pytest.mark.asyncio
async def test_the_list_asks_as_many_statements_for_thirty_orders_as_for_three(async_client, db_session, test_engine):
    """WS-13 E1 Z2: the card's new chips (``materials``, ``products``) ride the page's
    batch — the number of statements does not grow with the rows."""
    from backend.app.models.product import Product
    from backend.app.models.project import ProjectLine
    from backend.tests.unit.services.test_product_composition import counting_statements

    products = [Product(name=f"P{i}") for i in range(3)]
    db_session.add_all(products)
    await db_session.commit()

    async def add_orders(n):
        for i in range(n):
            order = await _order(db_session, f"Order {i}")
            db_session.add_all(
                [
                    ProjectLine(project_id=order.id, product_id=products[i % 3].id, quantity=1, material="PETG"),
                    ProjectLine(project_id=order.id, product_id=products[(i + 1) % 3].id, quantity=2, sort_order=1),
                ]
            )
        await db_session.commit()

    async def statements():
        await async_client.get("/api/v1/projects/?page=1&page_size=100")  # warm any per-process cache
        with counting_statements(test_engine) as seen:
            body = (await async_client.get("/api/v1/projects/?page=1&page_size=100")).json()
        assert all(row["products"] and row["materials"] == ["PETG"] for row in body["items"])
        return len(seen)

    await add_orders(3)
    few = await statements()
    await add_orders(27)
    assert await statements() == few
