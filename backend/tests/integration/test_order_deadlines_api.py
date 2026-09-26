"""The deadlines board endpoint (spec workshop-order-views, rules 14–16)."""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from backend.app.api.routes import projects as projects_routes
from backend.app.models.project import Project
from backend.app.services import order_deadlines

pytestmark = pytest.mark.integration

# Three weeks ahead of the real today: «overdue» is read off the server's clock,
# so a fixed calendar date would turn these orders overdue once it has passed.
START = (datetime.now() + timedelta(days=21)).replace(hour=0, minute=0, second=0, microsecond=0)
START_PARAM = START.date().isoformat()


def _forecasts(etas):
    async def fake(db, ids, now):
        return None, {
            pid: SimpleNamespace(now_eta=etas.get(pid), eta_complete=etas.get(pid) is not None) for pid in ids
        }

    return fake


@pytest.mark.asyncio
async def test_the_window_holds_due_orders_with_eta_marks_and_attention(async_client, db_session, monkeypatch):
    on_time = Project(name="D-on-time", due_date=START + timedelta(days=2))
    late = Project(name="D-late", due_date=START + timedelta(days=3))
    done = Project(name="D-done", due_date=START + timedelta(days=1), status="completed")
    cancelled = Project(name="D-cancelled", due_date=START + timedelta(days=1), status="cancelled")
    elsewhere = Project(name="D-elsewhere", due_date=START + timedelta(days=30))
    open_ended = Project(name="D-open")
    db_session.add_all([on_time, late, done, cancelled, elsewhere, open_ended])
    await db_session.commit()
    monkeypatch.setattr(
        projects_routes.farm_forecast,
        "forecast_projects",
        _forecasts(
            {
                on_time.id: START + timedelta(days=1, hours=10),
                late.id: START + timedelta(days=5),
                elsewhere.id: START + timedelta(days=6),
            }
        ),
    )
    body = (
        await async_client.get("/api/v1/projects/deadlines", params={"start": START_PARAM, "days": 14, "q": "D-"})
    ).json()
    due = {d["order"]["name"]: d for d in body["due"]}
    assert set(due) == {"D-on-time", "D-late", "D-done"}  # in the window, cancelled left out
    assert due["D-late"]["late"] is True and due["D-on-time"]["late"] is False
    assert due["D-done"]["eta"] is None and due["D-done"]["late"] is False  # completed: nothing is planned
    assert [m["name"] for m in body["eta_marks"]] == ["D-elsewhere"]  # ETA in the window, deadline outside
    reasons = {a["order"]["name"]: a["reason"] for a in body["attention"]}
    assert reasons["D-late"] == "late_eta" and reasons["D-open"] == "no_due"
    assert "D-on-time" not in reasons and "D-done" not in reasons


@pytest.mark.asyncio
async def test_an_incomplete_forecast_is_no_eta_and_never_late(async_client, db_session, monkeypatch):
    p = Project(name="E-unknown", due_date=START + timedelta(days=1))
    db_session.add(p)
    await db_session.commit()

    async def incomplete(db, ids, now):
        return None, {pid: SimpleNamespace(now_eta=START + timedelta(days=9), eta_complete=False) for pid in ids}

    monkeypatch.setattr(projects_routes.farm_forecast, "forecast_projects", incomplete)
    body = (await async_client.get("/api/v1/projects/deadlines", params={"start": START_PARAM, "q": "E-"})).json()
    assert body["due"][0]["eta"] is None and body["due"][0]["late"] is False and body["eta_marks"] == []


@pytest.mark.asyncio
async def test_the_window_and_late_are_the_servers_calendar_days(async_client, db_session, monkeypatch):
    # The forecast is naive UTC; the window and the deadline day are the server's
    # own calendar (Kyiv here). 22:30 UTC on the deadline day is 01:30 the day after.
    monkeypatch.setattr(order_deadlines, "server_tz", lambda: timezone(timedelta(hours=3)))
    end = START + timedelta(days=14)
    late = Project(name="K-late", due_date=START + timedelta(days=2))
    early_monday = Project(name="K-early")
    past_the_end = Project(name="K-past")
    db_session.add_all([late, early_monday, past_the_end])
    await db_session.commit()
    monkeypatch.setattr(
        projects_routes.farm_forecast,
        "forecast_projects",
        _forecasts(
            {
                late.id: START + timedelta(days=2, hours=22, minutes=30),
                early_monday.id: START - timedelta(hours=2),  # 01:00 on the window's Monday
                past_the_end.id: end - timedelta(hours=1),  # 02:00 on the day after the window
            }
        ),
    )
    body = (
        await async_client.get("/api/v1/projects/deadlines", params={"start": START_PARAM, "days": 14, "q": "K-"})
    ).json()
    assert body["due"][0]["late"] is True
    assert [m["name"] for m in body["eta_marks"]] == ["K-early"]
    assert {a["order"]["name"]: a["reason"] for a in body["attention"]}["K-late"] == "late_eta"


@pytest.mark.asyncio
async def test_the_window_is_bounded(async_client):
    too_long = await async_client.get("/api/v1/projects/deadlines", params={"start": START_PARAM, "days": 43})
    assert too_long.status_code == 422
    assert (await async_client.get("/api/v1/projects/deadlines", params={"start": "not-a-date"})).status_code == 422
    # A window that would run past the calendar is refused, never a 500.
    assert (await async_client.get("/api/v1/projects/deadlines", params={"start": "9999-12-31"})).status_code == 422
