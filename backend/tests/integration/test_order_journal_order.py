import pytest
from sqlalchemy import select

from backend.app.models.product import Product
from backend.app.models.project import Project, ProjectEvent

pytestmark = pytest.mark.integration


async def _kinds(db_session, oid):
    db_session.expire_all()
    rows = (
        (await db_session.execute(select(ProjectEvent).where(ProjectEvent.project_id == oid).order_by(ProjectEvent.id)))
        .scalars()
        .all()
    )
    return [(r.kind, r.payload) for r in rows]


@pytest.mark.asyncio
async def test_an_order_created_with_lines_writes_one_created_and_one_line_each(committing_client, db_session):
    lamp, vase = Product(name="Lamp"), Product(name="Vase")
    db_session.add_all([lamp, vase])
    await db_session.commit()
    r = await committing_client.post(
        "/api/v1/projects",
        json={"name": "O", "lines": [{"product_id": lamp.id, "quantity": 2}, {"product_id": vase.id, "quantity": 5}]},
    )
    kinds = await _kinds(db_session, r.json()["id"])
    assert [k for k, _ in kinds] == ["order_created", "line_added", "line_added"]
    assert kinds[0][1] == {"source": "manual"}
    assert kinds[1][1]["product"] == "Lamp" and kinds[1][1]["quantity"] == 2 and kinds[1][1]["from_stock"] == 0
    assert kinds[2][1]["product"] == "Vase" and kinds[2][1]["quantity"] == 5


@pytest.mark.asyncio
async def test_status_and_fields_are_journaled_by_what_actually_changed(committing_client, db_session):
    oid = (await committing_client.post("/api/v1/projects", json={"name": "O", "priority": "normal"})).json()["id"]
    await committing_client.patch(
        f"/api/v1/projects/{oid}", json={"name": "O2", "priority": "normal", "notes": "<p>x</p>", "status": "completed"}
    )
    kinds = await _kinds(db_session, oid)
    assert ("status_changed", {"from": "active", "to": "completed"}) in kinds
    assert ("fields_changed", {"fields": ["name", "notes"]}) in kinds  # priority was sent unchanged


@pytest.mark.asyncio
async def test_a_copy_says_what_it_was_copied_from(committing_client, db_session):
    oid = (await committing_client.post("/api/v1/projects", json={"name": "O"})).json()["id"]
    copy = (await committing_client.post(f"/api/v1/projects/{oid}/duplicate", json={})).json()["id"]
    assert (await _kinds(db_session, copy))[0] == ("order_created", {"source": "copy", "from_code": f"OR-{oid:04d}"})


@pytest.mark.asyncio
async def test_the_timeline_carries_the_journal_with_its_author(committing_client, db_session):
    oid = (await committing_client.post("/api/v1/projects", json={"name": "O"})).json()["id"]
    await committing_client.put(f"/api/v1/projects/{oid}/stage", json={"stage": "qc"})
    events = (await committing_client.get(f"/api/v1/projects/{oid}/timeline")).json()
    types = [e["event_type"] for e in events]
    assert types[0] == "stage_changed" and "order_created" in types and "project_created" not in types
    assert events[0]["metadata"]["to"] == "qc" and events[0]["metadata"]["user_name"] == "test_admin"


@pytest.mark.asyncio
async def test_an_order_from_before_the_journal_still_shows_it_was_created(committing_client, db_session):
    old = Project(name="Legacy")
    db_session.add(old)
    await db_session.commit()
    events = (await committing_client.get(f"/api/v1/projects/{old.id}/timeline")).json()
    assert [e["event_type"] for e in events] == ["project_created"]


@pytest.mark.asyncio
async def test_deleting_an_order_takes_its_journal(committing_client, db_session):
    oid = (await committing_client.post("/api/v1/projects", json={"name": "O"})).json()["id"]
    await committing_client.delete(f"/api/v1/projects/{oid}")
    assert await _kinds(db_session, oid) == []
