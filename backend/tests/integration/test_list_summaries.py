"""The Workshop tiles (spec workshop-lists, rules 1–4): one parameterless
summary per list, over the whole farm — the list's filters never reach them."""

from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

from backend.app.models.customer import Customer
from backend.app.models.project import Project

pytestmark = pytest.mark.integration


async def _order(db_session, name, *, status="active", due=None, priority="normal", customer_id=None):
    p = Project(name=name, status=status, due_date=due, priority=priority, customer_id=customer_id)
    db_session.add(p)
    await db_session.commit()
    await db_session.refresh(p)
    return p


def _start_of_today() -> datetime:
    return datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)


@pytest.mark.asyncio
async def test_orders_summary_counts_the_active_orders(async_client, db_session, monkeypatch):
    from backend.app.api.routes import projects as route_module

    today = _start_of_today()
    late = await _order(db_session, "late", due=today - timedelta(days=1))
    due_today = await _order(db_session, "today", due=today)  # due today is NOT overdue (rule 11)
    urgent = await _order(db_session, "urgent", priority="urgent")
    await _order(db_session, "done", status="completed", due=today - timedelta(days=3), priority="urgent")
    await _order(db_session, "gone", status="cancelled", priority="urgent")
    # (printing, queued, remaining, all_printed) per ACTIVE order
    figs = {late.id: (1, 2, 3, False), due_today.id: (0, 1, 0, True), urgent.id: (2, 0, 5, False)}

    async def fake(db, *, project_ids):
        assert sorted(project_ids) == sorted(figs), "only active orders are asked about"
        return [
            SimpleNamespace(
                project_id=pid,
                prints_in_progress=figs[pid][0],
                prints_queued=figs[pid][1],
                remaining=figs[pid][2],
                all_printed=figs[pid][3],
            )
            for pid in project_ids
        ]

    monkeypatch.setattr(route_module, "grouped_figures", fake)
    r = await async_client.get("/api/v1/projects/summary")
    assert r.status_code == 200, r.text  # not swallowed by /{project_id}
    assert r.json() == {
        "active": 3,
        "overdue": 1,
        "urgent": 1,
        "printing": 3,
        "queued": 3,
        "remaining": 8,
        "all_covered": 1,
    }


@pytest.mark.asyncio
async def test_orders_summary_ignores_list_filters(async_client, db_session):
    await _order(db_session, "a")
    await _order(db_session, "b", status="completed")
    plain = (await async_client.get("/api/v1/projects/summary")).json()
    filtered = (await async_client.get("/api/v1/projects/summary?customer_id=999&status=completed&q=zzz")).json()
    assert plain == filtered
    assert plain["active"] == 1


@pytest.mark.asyncio
async def test_orders_summary_of_an_empty_farm_is_zeros(async_client):
    body = (await async_client.get("/api/v1/projects/summary")).json()
    assert body == {
        "active": 0,
        "overdue": 0,
        "urgent": 0,
        "printing": 0,
        "queued": 0,
        "remaining": 0,
        "all_covered": 0,
    }


@pytest.mark.asyncio
async def test_customers_summary(async_client, db_session):
    acme, beta, idle = Customer(name="ACME"), Customer(name="Beta"), Customer(name="Idle")
    db_session.add_all([acme, beta, idle])
    await db_session.flush()
    db_session.add_all(
        [
            Project(name="a1", customer_id=acme.id, status="active", price=50.0),
            Project(name="a2", customer_id=acme.id, status="active", price=None),
            Project(name="a3", customer_id=acme.id, status="cancelled", price=25.5),
            Project(name="b1", customer_id=beta.id, status="completed", price=10.0),
            Project(name="orphan", status="active", price=99.0),  # no customer: not the customers' tile
        ]
    )
    await db_session.commit()
    r = await async_client.get("/api/v1/customers/summary")
    assert r.status_code == 200, r.text  # not swallowed by /{customer_id}
    assert r.json() == {"customers": 3, "with_active": 1, "active_orders": 2, "total_price": 60.0}


@pytest.mark.asyncio
async def test_nav_badges_count_active_orders_only(async_client, db_session):
    await _order(db_session, "a")
    await _order(db_session, "b")
    await _order(db_session, "done", status="completed")
    await _order(db_session, "gone", status="cancelled")
    r = await async_client.get("/api/v1/projects/nav-badges")
    assert r.status_code == 200, r.text  # not swallowed by /{project_id}
    assert r.json() == {"active_orders": 2}


@pytest.mark.asyncio
async def test_nav_badges_of_an_empty_farm(async_client):
    assert (await async_client.get("/api/v1/projects/nav-badges")).json() == {"active_orders": 0}
