import pytest
from sqlalchemy import select

from backend.app.models.project import Project, ProjectEvent
from backend.app.models.user import User

pytestmark = pytest.mark.integration


async def _events(db_session, project_id):
    db_session.expire_all()
    rows = (
        (
            await db_session.execute(
                select(ProjectEvent).where(ProjectEvent.project_id == project_id).order_by(ProjectEvent.id)
            )
        )
        .scalars()
        .all()
    )
    return [(r.kind, r.payload, r.user_name) for r in rows]


async def _user(db_session, username, active=True):
    user = User(username=username, role="user", is_active=active)
    db_session.add(user)
    await db_session.commit()
    return user.id


@pytest.mark.asyncio
async def test_a_new_order_starts_in_preparation_owned_by_its_author(committing_client, db_session):
    r = await committing_client.post("/api/v1/projects", json={"name": "O1"})
    body = r.json()
    assert body["stage"] == "prep" and body["responsible_name"] == "test_admin"
    none = (await committing_client.post("/api/v1/projects", json={"name": "O2", "responsible_id": None})).json()
    assert none["responsible_id"] is None and none["responsible_name"] is None


@pytest.mark.asyncio
async def test_setting_the_stage_is_journaled_and_idempotent(committing_client, db_session):
    oid = (await committing_client.post("/api/v1/projects", json={"name": "O"})).json()["id"]
    r = await committing_client.put(f"/api/v1/projects/{oid}/stage", json={"stage": "qc"})
    assert r.status_code == 200 and r.json()["stage"] == "qc"
    await committing_client.put(f"/api/v1/projects/{oid}/stage", json={"stage": "qc"})  # same: nothing
    assert [e for e in await _events(db_session, oid) if e[0] == "stage_changed"] == [
        ("stage_changed", {"from": "prep", "to": "qc"}, "test_admin")
    ]
    assert (await committing_client.put(f"/api/v1/projects/{oid}/stage", json={"stage": "done"})).status_code == 422


@pytest.mark.asyncio
async def test_a_stage_survives_complete_and_reopen_and_a_closed_order_refuses_one(committing_client, db_session):
    oid = (await committing_client.post("/api/v1/projects", json={"name": "O"})).json()["id"]
    await committing_client.put(f"/api/v1/projects/{oid}/stage", json={"stage": "printing"})
    done = await committing_client.patch(f"/api/v1/projects/{oid}", json={"status": "completed"})
    assert done.json()["stage"] == "done"
    refused = await committing_client.put(f"/api/v1/projects/{oid}/stage", json={"stage": "qc"})
    assert refused.status_code == 409
    cancelled = await committing_client.patch(f"/api/v1/projects/{oid}", json={"status": "cancelled"})
    assert cancelled.json()["stage"] is None
    back = await committing_client.patch(f"/api/v1/projects/{oid}", json={"status": "active"})
    assert back.json()["stage"] == "printing"
    assert [e[0] for e in await _events(db_session, oid)].count("stage_changed") == 1


@pytest.mark.asyncio
async def test_responsible_must_be_an_active_user_and_a_change_is_journaled(committing_client, db_session):
    ira = await _user(db_session, "ira")
    gone = await _user(db_session, "gone", active=False)
    oid = (await committing_client.post("/api/v1/projects", json={"name": "O"})).json()["id"]
    assert (await committing_client.patch(f"/api/v1/projects/{oid}", json={"responsible_id": gone})).status_code == 422
    missing = await committing_client.patch(f"/api/v1/projects/{oid}", json={"responsible_id": 999999})
    assert missing.status_code == 422
    r = await committing_client.patch(f"/api/v1/projects/{oid}", json={"responsible_id": ira})
    assert r.json()["responsible_name"] == "ira"
    changed = [e for e in await _events(db_session, oid) if e[0] == "responsible_changed"]
    assert changed[0][1]["to"] == {"id": ira, "name": "ira"} and changed[0][1]["from"]["name"] == "test_admin"


@pytest.mark.asyncio
async def test_a_since_deactivated_responsible_does_not_block_other_edits(committing_client, db_session):
    ira = await _user(db_session, "ira2")
    oid = (await committing_client.post("/api/v1/projects", json={"name": "O", "responsible_id": ira})).json()["id"]
    user = await db_session.get(User, ira)
    user.is_active = False
    await db_session.commit()
    r = await committing_client.patch(f"/api/v1/projects/{oid}", json={"name": "O renamed"})
    assert r.status_code == 200 and r.json()["responsible_name"] == "ira2"
    assert "responsible_changed" not in [e[0] for e in await _events(db_session, oid)]


@pytest.mark.asyncio
async def test_assignees_are_the_active_users_by_name(committing_client, db_session):
    await _user(db_session, "zoya")
    await _user(db_session, "asleep", active=False)
    names = [u["username"] for u in (await committing_client.get("/api/v1/projects/assignees")).json()]
    assert "zoya" in names and "asleep" not in names and names == sorted(names)


@pytest.mark.asyncio
async def test_a_copy_keeps_the_responsible_and_starts_in_preparation(committing_client, db_session):
    ira = await _user(db_session, "ira3")
    oid = (await committing_client.post("/api/v1/projects", json={"name": "O", "responsible_id": ira})).json()["id"]
    await committing_client.put(f"/api/v1/projects/{oid}/stage", json={"stage": "qc"})
    copy = (await committing_client.post(f"/api/v1/projects/{oid}/duplicate", json={})).json()
    assert copy["responsible_id"] == ira and copy["stage"] == "prep"


@pytest.mark.asyncio
async def test_deleting_a_user_leaves_no_id_behind(committing_client, db_session):
    ira = await _user(db_session, "ira4")
    oid = (await committing_client.post("/api/v1/projects", json={"name": "O", "responsible_id": ira})).json()["id"]
    # A journal line authored by ira, written through the writer the way a route would.
    from backend.app.services import order_journal

    await order_journal.record(db_session, oid, "stage_changed", {"from": "prep", "to": "qc"}, actor_id=ira)
    await db_session.commit()
    assert (await committing_client.delete(f"/api/v1/users/{ira}")).status_code in (200, 204)
    db_session.expire_all()
    assert (await db_session.get(Project, oid)).responsible_id is None
    row = (await db_session.execute(select(ProjectEvent).where(ProjectEvent.user_name == "ira4"))).scalar_one()
    assert row.user_id is None
