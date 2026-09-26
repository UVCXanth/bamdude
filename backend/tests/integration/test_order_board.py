"""The kanban board endpoint (spec workshop-order-views, rule 5)."""

import pytest

from backend.app.models.customer import Customer
from backend.app.models.project import Project

pytestmark = pytest.mark.integration


@pytest.mark.asyncio
async def test_the_board_groups_active_orders_by_stage_and_shows_the_latest_done(async_client, db_session):
    db_session.add_all(
        [
            Project(name="B-low", stage="printing", priority="low"),
            Project(name="B-urgent", stage="printing", priority="urgent"),
            Project(name="B-prep", stage="prep"),
            Project(name="B-done", stage="qc", status="completed"),
            Project(name="B-cancelled", stage="qc", status="cancelled"),
        ]
    )
    await db_session.commit()
    board = (await async_client.get("/api/v1/projects/board", params={"q": "B-"})).json()
    assert [o["name"] for o in board["printing"]["items"]] == ["B-urgent", "B-low"]  # priority first
    assert board["printing"]["total"] == 2 and board["prep"]["total"] == 1 and board["qc"]["total"] == 0
    assert [o["name"] for o in board["done"]["items"]] == ["B-done"] and board["done"]["total"] == 1
    everything = [o["name"] for column in board.values() for o in column["items"]]
    assert "B-cancelled" not in everything
    assert board["printing"]["items"][0]["stage"] == "printing"  # the list row, as the list sends it


@pytest.mark.asyncio
async def test_a_column_is_capped_and_its_total_counts_the_rest(async_client, db_session):
    db_session.add_all([Project(name=f"C-{i:02d}", stage="prep") for i in range(52)])
    db_session.add_all([Project(name=f"C-done-{i}", status="completed") for i in range(8)])
    await db_session.commit()
    board = (await async_client.get("/api/v1/projects/board", params={"q": "C-"})).json()
    assert len(board["prep"]["items"]) == 50 and board["prep"]["total"] == 52
    assert len(board["done"]["items"]) == 6 and board["done"]["total"] == 8


@pytest.mark.asyncio
async def test_the_board_follows_the_list_filters(async_client, db_session):
    acme = Customer(name="ACME board")
    db_session.add(acme)
    await db_session.flush()
    db_session.add_all([Project(name="F-acme", stage="qc", customer_id=acme.id), Project(name="F-other", stage="qc")])
    await db_session.commit()
    board = (await async_client.get("/api/v1/projects/board", params={"q": "F-", "customer_id": acme.id})).json()
    assert [o["name"] for o in board["qc"]["items"]] == ["F-acme"] and board["qc"]["total"] == 1
