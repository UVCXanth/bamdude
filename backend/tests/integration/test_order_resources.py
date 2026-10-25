"""Generic Product A, real order accounting and queue rows; no physical commands."""

from datetime import datetime, timezone

import pytest
from sqlalchemy import func, select

from backend.app.models.auto_queue import AutoQueueItem
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.product import ProductPlate
from backend.app.models.project import Project
from backend.app.services import plan_engine
from backend.app.services.filament_policy import serialize_policy
from backend.app.services.filament_routing import RoutingPolicy
from backend.app.services.order_resources import allowed
from backend.tests.integration.test_workshop_stock_plan_regressions import archive, shop  # noqa: F401


@pytest.fixture
async def resource_shop(shop, db_session, printer_factory):
    shop["printer"].model = "A1 mini"
    shop["file"].file_metadata = {**shop["file"].file_metadata, "sliced_for_model": "A1 mini"}
    second = await printer_factory(name="Other model", model="P1S")
    from backend.app.services.printer_queues import ensure_printer_queue

    await ensure_printer_queue(db_session, second.id)
    await db_session.commit()
    return {**shop, "other": second}


async def choose(client, s, **resources):
    path = f"/api/v1/projects/{s['order']}/printer-resources"
    current = await client.get(path)
    assert current.status_code == 200, current.text
    response = await client.put(path, json={"expected_token": current.json()["token"], "resources": resources})
    assert response.status_code == 200, response.text
    return response.json()


async def pending_rows(db, s):
    printer = PrintQueueItem(
        queue_id=s["printer"].id,
        position=1,
        library_file_id=s["file"].id,
        project_id=s["order"],
        project_line_id=s["line"],
        plate_id=1,
        filament_routing=serialize_policy(RoutingPolicy(mode="auto")),
    )
    auto = AutoQueueItem(
        library_file_id=s["file"].id,
        project_id=s["order"],
        project_line_id=s["line"],
        plate_id=1,
        target_model="A1 mini",
    )
    db.add_all([printer, auto])
    await db.commit()
    return printer, auto


async def review(client, s):
    path = f"/api/v1/projects/{s['order']}/printer-resources/replan"
    current = await client.get(f"/api/v1/projects/{s['order']}/working-plan")
    response = await client.post(path, json={"expected_revision": current.json()["revision"]})
    assert response.status_code == 200, response.text
    return path, response.json()


def apply_body(proposal):
    return {
        "apply": True,
        "expected_revision": proposal["expected_revision"],
        "proposal_token": proposal["proposal_token"],
        "inputs_token": proposal["inputs_token"],
        "proposal_entries": proposal["entries"],
    }


@pytest.mark.parametrize("line_only", [False, True])
async def test_automatic_cross_model_rebalancing_cannot_escape_order_policy(
    committing_client, db_session, resource_shop, line_only
):
    from backend.app.services.auto_queue_eligibility import printers_for_item
    from backend.app.services.queue_rebalance import rebalance

    s = resource_shop
    await choose(committing_client, s, models=["A1 mini"], printer_ids=[s["printer"].id])
    _, auto = await pending_rows(db_session, s)
    if line_only:
        auto.project_id = None
        await db_session.commit()
    printers, _, _ = await printers_for_item(db_session, auto)
    assert [p.id for p in printers] == [s["printer"].id]
    result = await rebalance(db_session, item_ids=[auto.id], force=True)
    assert result.skipped == [(auto.id, "order_resources")]
    assert (await db_session.get(AutoQueueItem, auto.id, populate_existing=True)).target_model == "A1 mini"


async def test_model_and_printer_policy_is_order_local_and_does_not_unlink_plates(
    committing_client,
    db_session,
    resource_shop,
):
    s = resource_shop
    selected = await choose(committing_client, s, models=["A1MINI"], printer_ids=[s["printer"].id, s["other"].id])
    assert [p["id"] for p in selected["printers"] if p["allowed"]] == [s["printer"].id]
    assert await allowed(db_session, s["order"], s["printer"].id)
    assert not await allowed(db_session, s["order"], s["other"].id)
    assert not await allowed(db_session, None, s["other"].id, project_line_id=s["line"])
    assert await allowed(db_session, None, s["other"].id)
    assert await db_session.get(ProductPlate, s["plate"].id)


async def test_final_queue_claim_refuses_a_model_excluded_after_enqueue(
    committing_client, db_session, resource_shop, monkeypatch
):
    from contextlib import asynccontextmanager

    from backend.app.services.print_scheduler import PrintScheduler

    s = resource_shop
    printer, _ = await pending_rows(db_session, s)
    await choose(committing_client, s, models=["P1S"])

    @asynccontextmanager
    async def session():
        yield db_session

    monkeypatch.setattr("backend.app.services.print_scheduler.async_session", session)
    monkeypatch.setattr("backend.app.services.print_scheduler.farm_startup_guard.allowed", lambda: True)
    result = await PrintScheduler()._claim_for_dispatch(
        item_id=printer.id, queue_id=printer.queue_id, printer_id=s["printer"].id, plan_fields={}
    )
    assert not result.claimed
    assert result.reason == "order_resources_changed"
    assert (await db_session.get(PrintQueueItem, printer.id, populate_existing=True)).status == "pending"


async def test_replan_reviews_both_queues_then_replaces_only_the_shared_draft(
    committing_client,
    db_session,
    resource_shop,
):
    s = resource_shop
    await choose(committing_client, s, models=["A1 mini"], printer_ids=[s["printer"].id])
    printer, auto = await pending_rows(db_session, s)
    path, proposal = await review(committing_client, s)
    assert proposal["remove_printer_ids"] == [printer.id]
    assert proposal["remove_auto_ids"] == [auto.id]
    assert sum(e["count"] for e in proposal["entries"]) == 10
    assert await db_session.get(PrintQueueItem, printer.id)  # preview is read-only
    response = await committing_client.post(path, json=apply_body(proposal))
    assert response.status_code == 200, response.text
    assert response.json()["working_plan"]["revision"] == 1
    assert (await db_session.execute(select(func.count()).select_from(PrintQueueItem))).scalar_one() == 0
    assert (await db_session.execute(select(func.count()).select_from(AutoQueueItem))).scalar_one() == 0
    assert (await db_session.get(Project, s["order"], populate_existing=True)).status == "active"
    assert await db_session.get(ProductPlate, s["plate"].id)


@pytest.mark.parametrize("change", ["new_job", "policy", "tampered"])
async def test_changed_review_refuses_before_any_queue_deletion(committing_client, db_session, resource_shop, change):
    s = resource_shop
    await choose(committing_client, s, printer_ids=[s["printer"].id])
    printer, auto = await pending_rows(db_session, s)
    path, proposal = await review(committing_client, s)
    if change == "new_job":
        await pending_rows(db_session, s)
    elif change == "policy":
        await choose(committing_client, s, models=["P1S"])
    else:
        proposal["entries"][0]["count"] += 1
    response = await committing_client.post(path, json=apply_body(proposal))
    assert response.status_code == 409, response.text
    assert await db_session.get(PrintQueueItem, printer.id, populate_existing=True)
    assert await db_session.get(AutoQueueItem, auto.id, populate_existing=True)


async def test_claimed_and_manual_work_is_preserved_and_counted_once(committing_client, db_session, resource_shop):
    s = resource_shop
    await choose(committing_client, s, models=["A1 mini"])
    printer, auto = await pending_rows(db_session, s)
    printer.manual_start = True
    run, _ = await archive(db_session, s, status="printing", quantities=(3, 1))
    claimed = PrintQueueItem(
        queue_id=s["printer"].id,
        position=0,
        project_id=s["order"],
        project_line_id=s["line"],
        library_file_id=s["file"].id,
        archive_id=run.id,
        status="printing",
        started_at=datetime.now(timezone.utc),
    )
    db_session.add(claimed)
    await db_session.commit()
    path, proposal = await review(committing_client, s)
    assert set(proposal["preserved_printer_ids"]) == {printer.id, claimed.id}
    assert sum(e["count"] for e in proposal["entries"]) == 8
    response = await committing_client.post(path, json=apply_body(proposal))
    assert response.status_code == 200, response.text
    assert (await db_session.get(PrintQueueItem, claimed.id, populate_existing=True)).status == "printing"
    assert (await db_session.get(PrintQueueItem, printer.id, populate_existing=True)).manual_start


async def test_unattributed_preparation_refuses_a_duplicate_plan(committing_client, db_session, resource_shop):
    s = resource_shop
    printer, _ = await pending_rows(db_session, s)
    printer.status = "printing"
    printer.started_at = datetime.now(timezone.utc)
    await db_session.commit()
    response = await committing_client.post(
        f"/api/v1/projects/{s['order']}/printer-resources/replan", json={"expected_revision": 0}
    )
    assert response.status_code == 409 and response.json()["detail"]["code"] == "order_resources_preparing"


async def test_no_fallback_when_selected_machine_model_cannot_print_the_plate(
    committing_client, db_session, resource_shop
):
    s = resource_shop
    await choose(committing_client, s, printer_ids=[s["other"].id])
    await pending_rows(db_session, s)
    response = await committing_client.post(
        f"/api/v1/projects/{s['order']}/printer-resources/replan", json={"expected_revision": 0}
    )
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "order_resources_no_plan"
