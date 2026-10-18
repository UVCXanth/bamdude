"""Product A/B only; real accounting, read-only previews and the ordinary line writer."""

import pytest
from sqlalchemy import func, select

from backend.app.models.auto_queue import AutoQueueItem
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.project_line import ProjectLine
from backend.app.services import part_stock
from backend.tests.integration.test_workshop_stock_plan_regressions import archive, shop  # noqa: F401


async def preview(client, s, **kwargs):
    return await client.post(
        f"/api/v1/projects/{s['order']}/lines/{s['line']}/plate-fit",
        json={"around": 10, "plate_ids": [s["plate"].id], **kwargs},
    )


async def apply(client, s, response, option, ack=False):
    return await client.patch(
        f"/api/v1/projects/{s['order']}/lines/{s['line']}",
        json={
            "quantity": option["quantity"],
            "plate_fit": {
                "basis": response["basis"],
                "plate_ids": response["plate_ids"],
                "runs": option["runs"],
                "acknowledge_large_change": ack,
            },
        },
    )


async def test_preview_and_apply_create_no_jobs_or_stock_movements(committing_client, db_session, shop):
    r = await preview(committing_client, shop)
    assert r.status_code == 200, r.text
    data = r.json()
    assert [o["quantity"] for o in data["options"]] == [9, 10, 11]
    result = await apply(committing_client, shop, data, data["options"][0])
    assert result.status_code == 200, result.text
    assert result.json()["lines"][0]["quantity"] == 9
    for model in (AutoQueueItem, PrintQueueItem):
        assert await db_session.scalar(select(func.count()).select_from(model)) == 0
    assert await part_stock.reserved_parts_for_line(db_session, await db_session.get(ProjectLine, shop["line"])) == {}


async def test_free_stock_is_not_allocated_by_a_preview_but_existing_partial_stock_counts(
    committing_client, db_session, shop
):
    await part_stock.move(
        db_session, part_id=shop["a"].id, delta=300, reason="manual", note="Product A synthetic fixture"
    )
    await db_session.commit()
    r = await preview(committing_client, shop)
    assert r.status_code == 200, r.text
    assert all(part["allocated"] == 0 for o in r.json()["options"] for part in o["parts"])
    # The established intake takes partial parts; the fit reader follows that ledger.
    await part_stock.move(
        db_session,
        part_id=shop["a"].id,
        delta=-3,
        reason="reserved_parts_for_order",
        project_line_id=shop["line"],
        note=part_stock.NOTE_RESERVATION_REWRITTEN,
    )
    await db_session.commit()
    r = await preview(committing_client, shop)
    assert r.status_code == 200, r.text
    assert r.json()["options"] == []  # 3*n + 3 can never equal 3*n for this mixed plate.


async def test_completed_good_and_running_output_count_once_and_rejects_do_not(committing_client, db_session, shop):
    await archive(db_session, shop, status="completed", quantities=(6, 2), defects=(3, 1))
    await archive(db_session, shop, status="printing", quantities=(3, 1))
    r = await preview(committing_client, shop)
    assert r.status_code == 200, r.text
    current = next(o for o in r.json()["options"] if o["quantity"] == 10)
    assert sum(run["count"] for run in current["runs"]) == 8
    assert [(p["completed"], p["printing"]) for p in current["parts"]] == [(3, 3), (1, 1)]


async def test_stale_print_completion_and_large_change_are_refused_without_mutation(
    committing_client, db_session, shop
):
    r = await preview(committing_client, shop, around=30)
    assert r.status_code == 200, r.text
    data = r.json()
    chosen = data["options"][1]
    refused = await apply(committing_client, shop, data, chosen)
    assert refused.status_code == 409 and refused.json()["detail"]["error"] == "plate_fit_large_change"
    await archive(db_session, shop, status="completed", quantities=(3, 1))
    refused = await apply(committing_client, shop, data, chosen, True)
    assert refused.status_code == 409 and refused.json()["detail"]["error"] == "plate_fit_stale"
    order = await committing_client.get(f"/api/v1/projects/{shop['order']}")
    assert order.json()["lines"][0]["quantity"] == 10


@pytest.mark.parametrize(
    "payload",
    [
        {"around": 0},
        {"around": 1_000_001},
        {"around": True},
        {"around": 10, "plate_ids": []},
        {"around": 10, "plate_ids": [999999]},
    ],
)
async def test_invalid_scope_and_quantities_are_refused(committing_client, shop, payload):
    r = await preview(committing_client, shop, **payload)
    assert r.status_code in (409, 422), r.text


async def test_late_reject_recalculates_replacement_runs_and_invalidates_previous_offer(
    committing_client, db_session, shop
):
    _run, parts = await archive(db_session, shop, status="completed", quantities=(30, 10))
    first = await preview(committing_client, shop)
    assert first.status_code == 200, first.text
    complete = next(o for o in first.json()["options"] if o["quantity"] == 10)
    assert complete["runs"] == []
    parts[0].defective, parts[1].defective = 3, 1
    await db_session.commit()
    stale = await apply(committing_client, shop, first.json(), complete)
    assert stale.status_code == 409 and stale.json()["detail"]["error"] == "plate_fit_stale"
    second = await preview(committing_client, shop)
    assert second.status_code == 200, second.text
    repaired = next(o for o in second.json()["options"] if o["quantity"] == 10)
    assert repaired["runs"] == [{"plate_id": shop["plate"].id, "count": 1}]
    assert [p["new_printed"] for p in repaired["parts"]] == [3, 1]
    response = await apply(committing_client, shop, second.json(), repaired)
    assert response.status_code == 200, response.text


async def test_both_queue_tiers_are_counted_without_double_counting_handed_work(committing_client, db_session, shop):
    item = PrintQueueItem(
        queue_id=shop["printer"].id,
        library_file_id=shop["file"].id,
        plate_id=1,
        project_id=shop["order"],
        project_line_id=shop["line"],
        status="pending",
        position=1,
    )
    db_session.add(item)
    await db_session.flush()
    db_session.add_all(
        [
            AutoQueueItem(
                library_file_id=shop["file"].id,
                plate_id=1,
                project_id=shop["order"],
                project_line_id=shop["line"],
                status="pending",
                assigned_to_item_id=item.id,
            ),
            AutoQueueItem(
                library_file_id=shop["file"].id,
                plate_id=1,
                project_id=shop["order"],
                project_line_id=shop["line"],
                status="pending",
            ),
        ]
    )
    await db_session.commit()
    response = await preview(committing_client, shop)
    assert response.status_code == 200, response.text
    current = next(o for o in response.json()["options"] if o["quantity"] == 10)
    assert current["runs"] == [{"plate_id": shop["plate"].id, "count": 8}]
    assert [p["queued"] for p in current["parts"]] == [6, 2]
    item.status = "cancelled"
    await db_session.commit()
    again = await preview(committing_client, shop)
    assert next(o for o in again.json()["options"] if o["quantity"] == 10)["runs"][0]["count"] == 9


async def test_completed_line_can_browse_linked_plates_without_an_outstanding_plan(committing_client, db_session, shop):
    await archive(db_session, shop, status="completed", quantities=(30, 10))
    response = await committing_client.post(
        f"/api/v1/projects/{shop['order']}/lines/{shop['line']}/plate-fit", json={"around": 10}
    )
    assert response.status_code == 200, response.text
    assert next(o for o in response.json()["options"] if o["quantity"] == 11)["runs"][0]["count"] == 1


async def test_missing_stock_or_product_read_right_does_not_leak_a_proposal(committing_client, db_session, shop):
    from backend.tests.integration.test_workshop_library_rights import _jwt, _user

    for index, missing in enumerate(("stock:read", "products:read", "orders:update")):
        rights = [p for p in ("orders:read", "orders:update", "products:read", "stock:read") if p != missing]
        name = f"fit_restricted_{index}"
        await _user(db_session, name, rights)
        response = await committing_client.post(
            f"/api/v1/projects/{shop['order']}/lines/{shop['line']}/plate-fit", json={"around": 10}, headers=_jwt(name)
        )
        assert response.status_code == 403, response.text


async def test_reviewed_auto_removal_is_atomic_with_quantity_and_preserves_protected_rows(
    committing_client, db_session, shop
):
    from datetime import datetime

    rows = [
        AutoQueueItem(
            library_file_id=shop["file"].id,
            plate_id=1,
            project_id=shop["order"],
            project_line_id=shop["line"],
            status="pending",
            position=i,
        )
        for i in range(3)
    ]
    rows[1].manual_start = True
    rows[2].scheduled_time = datetime(2030, 1, 1)
    db_session.add_all(rows)
    await db_session.commit()
    removable_id, protected_ids = rows[0].id, [rows[1].id, rows[2].id]
    response = await preview(committing_client, shop, replace_pending=True)
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["removable_auto_ids"] == [removable_id]
    target = next(o for o in data["options"] if o["quantity"] == 10)
    assert target["runs"][0]["count"] == 8
    payload = {
        "quantity": 10,
        "plate_fit": {
            "basis": data["basis"],
            "plate_ids": data["plate_ids"],
            "runs": target["runs"],
            "replace_pending": True,
        },
    }
    refused = await committing_client.patch(f"/api/v1/projects/{shop['order']}/lines/{shop['line']}", json=payload)
    assert refused.status_code == 409 and refused.json()["detail"]["error"] == "plate_fit_queue_change"
    assert await db_session.get(AutoQueueItem, removable_id) is not None
    payload["plate_fit"]["acknowledge_queue_change"] = True
    accepted = await committing_client.patch(f"/api/v1/projects/{shop['order']}/lines/{shop['line']}", json=payload)
    assert accepted.status_code == 200, accepted.text
    remaining = list((await db_session.execute(select(AutoQueueItem.id))).scalars())
    assert sorted(remaining) == sorted(protected_ids)
    assert await db_session.scalar(select(func.count()).select_from(PrintQueueItem)) == 0


async def test_auto_assignment_during_review_refuses_removal_and_quantity_edit(committing_client, db_session, shop):
    auto = AutoQueueItem(
        library_file_id=shop["file"].id,
        plate_id=1,
        project_id=shop["order"],
        project_line_id=shop["line"],
        status="pending",
    )
    db_session.add(auto)
    await db_session.commit()
    response = await preview(committing_client, shop, replace_pending=True)
    assert response.status_code == 200, response.text
    data = response.json()
    auto.status = "assigned"
    await db_session.commit()
    target = next(o for o in data["options"] if o["quantity"] == 9)
    payload = {
        "quantity": 9,
        "plate_fit": {
            "basis": data["basis"],
            "plate_ids": data["plate_ids"],
            "runs": target["runs"],
            "replace_pending": True,
            "acknowledge_queue_change": True,
        },
    }
    refused = await committing_client.patch(f"/api/v1/projects/{shop['order']}/lines/{shop['line']}", json=payload)
    assert refused.status_code == 409 and refused.json()["detail"]["error"] == "plate_fit_stale"
    order = await committing_client.get(f"/api/v1/projects/{shop['order']}")
    assert order.json()["lines"][0]["quantity"] == 10
    assert (await db_session.get(AutoQueueItem, auto.id)).status == "assigned"
