import pytest

from backend.app.models.project import Project
from backend.app.models.user import User

pytestmark = pytest.mark.integration


async def _farm(db_session):
    ira = User(username="ira_list", role="user", is_active=True)
    db_session.add(ira)
    await db_session.flush()
    # Inserted out of stage order, so a sort that did nothing would show it.
    db_session.add_all(
        [
            Project(name="S-cancelled", stage="printing", status="cancelled"),
            Project(name="S-qc", stage="qc", responsible_id=ira.id),
            Project(name="S-done", stage="qc", status="completed"),
            Project(name="S-prep", stage="prep", responsible_id=ira.id),
            Project(name="S-printing", stage="printing"),
        ]
    )
    await db_session.commit()
    return ira.id


async def _names(client, **params):
    body = (await client.get("/api/v1/projects/", params={"page": 1, "q": "S-", **params})).json()
    return [row["name"] for row in body["items"]], body


@pytest.mark.asyncio
async def test_stage_filters_the_list_and_done_means_completed(async_client, db_session):
    await _farm(db_session)
    assert (await _names(async_client, stage="qc"))[0] == ["S-qc"]
    assert (await _names(async_client, stage="done"))[0] == ["S-done"]
    assert (await async_client.get("/api/v1/projects/", params={"page": 1, "stage": "shipped"})).status_code == 400


@pytest.mark.asyncio
async def test_stage_sorts_preparation_first_and_closed_orders_last(async_client, db_session):
    await _farm(db_session)
    names, _ = await _names(async_client, sort_by="stage-asc")
    assert names == ["S-prep", "S-printing", "S-qc", "S-done", "S-cancelled"]
    names, _ = await _names(async_client, sort_by="stage-desc")
    assert names == ["S-cancelled", "S-done", "S-qc", "S-printing", "S-prep"]


@pytest.mark.asyncio
async def test_responsible_filters_and_stage_counts_follow_every_filter_but_status_and_stage(async_client, db_session):
    ira = await _farm(db_session)
    names, body = await _names(async_client, responsible_id=ira, stage="qc")
    assert names == ["S-qc"]
    assert body["totals"]["stages"] == {"prep": 1, "printing": 0, "qc": 1}
    assert body["totals"]["active"] == 1  # the tabs keep the stage filter
