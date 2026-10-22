"""One shared draft, an explicit baseline, and CAS before any queue writes."""

import pytest
from sqlalchemy import select

from backend.app.models.product import ProductPlate
from backend.tests.integration.test_farm_forecast_api import _order, farm  # noqa: F401

pytestmark = pytest.mark.integration


async def setup_plan(client, db, farm, count=10):
    order_id, line_id = await _order(db, farm["product"].id, 10)
    plates = list((await db.scalars(select(ProductPlate).order_by(ProductPlate.id))).all())
    token = (await client.get(f"/api/v1/projects/{order_id}/plan")).json()["inputs_token"]
    entry = {
        "entry_id": "manual-p1",
        "line_id": line_id,
        "plate_id": plates[0].id,
        "count": count,
        "manual": True,
        "target": {"kind": "auto"},
    }
    response = await client.put(
        f"/api/v1/projects/{order_id}/working-plan",
        json={"expected_revision": 0, "inputs_token": token, "entries": [entry]},
    )
    assert response.status_code == 200, response.text
    return order_id, line_id, plates, entry, response.json()


async def save_baseline(client, order_id, state):
    response = await client.post(
        f"/api/v1/projects/{order_id}/working-plan/save",
        json={
            "expected_revision": state["revision"],
            "expected_saved_revision": state["saved_revision"],
            "expected_epoch": state["epoch"],
            "inputs_token": state["inputs_token"],
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


async def test_get_does_not_create_a_working_plan(committing_client, db_session, farm):
    from backend.app.models.order_working_plan import OrderWorkingPlan

    order_id, _ = await _order(db_session, farm["product"].id, 10)
    response = await committing_client.get(f"/api/v1/projects/{order_id}/working-plan")
    assert response.status_code == 200, response.text
    assert response.json()["revision"] == 0
    assert await db_session.get(OrderWorkingPlan, order_id) is None


async def test_reviewed_replan_is_applied_without_reconsulting_live_fleet(
    committing_client, db_session, farm, monkeypatch
):
    from backend.app.services import plan_engine

    order_id, _, _, _, state = await setup_plan(committing_client, db_session, farm, count=6)
    path = f"/api/v1/projects/{order_id}/working-plan/replan"
    request = {"expected_revision": state["revision"], "kind": "rebuild"}
    before = (await committing_client.post(path, json=request)).json()
    assert "proposal_token" in before, before

    async def changed_fleet(*_args, **_kwargs):
        raise AssertionError("Live fleet is no authority to change a reviewed payload")

    monkeypatch.setattr(plan_engine, "_current_fleet_capacity", changed_fleet)
    tampered = [{**e, "count": e["count"] + 1} for e in before["entries"]]
    rejected = await committing_client.post(
        path, json={**request, "apply": True, "proposal_token": before["proposal_token"], "proposal_entries": tampered}
    )
    assert rejected.status_code == 409, rejected.text
    applied = await committing_client.post(
        path,
        json={
            **request,
            "apply": True,
            "proposal_token": before["proposal_token"],
            "proposal_entries": before["entries"],
        },
    )
    assert applied.status_code == 200, applied.text
    assert applied.json()["entries"] == before["entries"]


async def test_autosave_does_not_move_saved_baseline(committing_client, db_session, farm):
    order_id, _, _, entry, state = await setup_plan(committing_client, db_session, farm)
    assert state["saved_revision"] == 0
    state = await save_baseline(committing_client, order_id, state)
    assert state["saved_revision"] == 1
    path = f"/api/v1/projects/{order_id}"
    for count, expected_delta in [(8, -7200), (7, -10800)]:
        response = await committing_client.put(
            path + "/working-plan",
            json={
                "expected_revision": state["revision"],
                "inputs_token": state["inputs_token"],
                "entries": [{**entry, "count": count}],
            },
        )
        assert response.status_code == 200, response.text
        state = response.json()
        assert state["saved_revision"] == 1
        preview = await committing_client.post(
            path + "/plan/forecast-preview",
            json={
                "client_revision": str(count),
                "saved_revision": 1,
                "comparison_epoch": 0,
                "entries": [{**entry, "count": count}],
            },
        )
        assert preview.status_code == 200, preview.text
        assert preview.json()["comparison"]["machine_seconds_delta"] == expected_delta
        assert preview.json()["comparison"]["coverage_changed"] is True
        assert preview.json()["comparison"]["now_seconds_delta"] is None
    reread = (await committing_client.get(path + "/working-plan")).json()
    assert reread["entries"][0]["count"] == 7
    assert reread["saved_revision"] == 1


async def test_save_and_discard_are_addressed_CAS_actions(committing_client, db_session, farm):
    order_id, _, _, entry, state = await setup_plan(committing_client, db_session, farm)
    state = await save_baseline(committing_client, order_id, state)
    path = f"/api/v1/projects/{order_id}/working-plan"
    change = {"expected_revision": state["revision"], "entries": [{**entry, "count": 8}]}
    first = await committing_client.put(path, json=change)
    assert first.status_code == 200, first.text
    stale = await committing_client.put(path, json={**change, "entries": [{**entry, "count": 6}]})
    assert stale.status_code == 409
    state = first.json()
    discarded = await committing_client.post(
        path + "/discard",
        json={
            "expected_revision": state["revision"],
            "expected_saved_revision": 1,
            "expected_epoch": 0,
        },
    )
    assert discarded.status_code == 200, discarded.text
    assert discarded.json()["entries"][0]["count"] == 10
    assert discarded.json()["saved_revision"] == 1


async def test_new_alternative_does_not_replace_the_manual_split(committing_client, db_session, farm):
    order_id, line_id, plates, entry, state = await setup_plan(committing_client, db_session, farm, count=6)
    second = {**entry, "entry_id": "manual-x1", "plate_id": plates[1].id, "count": 4}
    result = await committing_client.put(
        f"/api/v1/projects/{order_id}/working-plan",
        json={"expected_revision": state["revision"], "entries": [entry, second]},
    )
    assert result.status_code == 200, result.text
    db_session.add(ProductPlate(product_id=farm["product"].id, library_file_id=farm["files"][0].id, plate_index=1))
    await db_session.commit()
    plan = (await committing_client.get(f"/api/v1/projects/{order_id}/plan")).json()
    assert plan["mode"] == "working"
    assert sorted(row["count"] for line in plan["lines"] for row in line["rows"]) == [4, 6]


async def test_changed_source_keeps_the_entry_and_requires_review(committing_client, db_session, farm):
    order_id, _, _, _, state = await setup_plan(committing_client, db_session, farm)
    await save_baseline(committing_client, order_id, state)
    farm["files"][0].file_hash = "a" * 64
    await db_session.commit()
    state = (await committing_client.get(f"/api/v1/projects/{order_id}/working-plan")).json()
    assert state["entries"][0]["count"] == 10
    assert {i["code"] for i in state["issues"]} == {"source_changed"}
    response = await committing_client.post(
        f"/api/v1/projects/{order_id}/plan/forecast-preview",
        json={
            "client_revision": "new",
            "entries": state["entries"],
            "saved_revision": 1,
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["comparison"]["status"] == "source_changed"


async def test_replan_replaces_only_auto_work_and_does_not_accumulate(committing_client, db_session, farm):
    from backend.app.models.project_line import ProjectLine

    order_id, line_id, _, _, state = await setup_plan(committing_client, db_session, farm, count=6)
    (await db_session.get(ProjectLine, line_id)).quantity = 12
    await db_session.commit()
    path = f"/api/v1/projects/{order_id}/working-plan/replan"
    for _ in range(2):
        request = {"expected_revision": state["revision"], "kind": "remainder"}
        before = (await committing_client.post(path, json=request)).json()
        assert "proposal_token" in before, before
        assert (await committing_client.get(f"/api/v1/projects/{order_id}/working-plan")).json()["entries"][0][
            "count"
        ] == state["entries"][0]["count"]
        applied = await committing_client.post(
            path,
            json={
                **request,
                "apply": True,
                "proposal_token": before["proposal_token"],
                "proposal_entries": before["entries"],
            },
        )
        assert applied.status_code == 200, applied.text
        state = applied.json()
        assert sum(e["count"] for e in state["entries"]) == 12
        assert sum(e["protected_count"] for e in state["entries"]) == 6


async def test_invalid_target_is_reviewable_without_erasing_nominal_work(committing_client, db_session, farm):
    oid, _, _, entry, state = await setup_plan(committing_client, db_session, farm)
    path = f"/api/v1/projects/{oid}"
    result = await committing_client.put(
        path + "/working-plan",
        json={
            "expected_revision": state["revision"],
            "entries": [{**entry, "target": {"kind": "printer", "printer_id": 999999}}],
        },
    )
    assert result.status_code == 200, result.text
    read = (await committing_client.get(path + "/working-plan")).json()
    assert {i["code"] for i in read["issues"]} == {"target_unavailable"}
    preview = (
        await committing_client.post(
            path + "/plan/forecast-preview", json={"client_revision": "pinned", "entries": read["entries"]}
        )
    ).json()
    assert preview["workload"]["total_seconds"] == 36000


async def test_explicit_save_noop_and_timestamp_are_stable(committing_client, db_session, farm):
    oid, _, _, _, state = await setup_plan(committing_client, db_session, farm)
    first = await save_baseline(committing_client, oid, state)
    second = await save_baseline(committing_client, oid, first)
    assert first["saved_revision"] == second["saved_revision"] == 1
    assert first["saved_at"] == second["saved_at"]
    assert first["saved_at"].endswith("+00:00")


async def test_shared_forecast_cannot_call_an_undercovered_draft_ready(committing_client, db_session, farm):
    oid, _, _, _, _ = await setup_plan(committing_client, db_session, farm, count=8)
    detail = (await committing_client.get(f"/api/v1/projects/{oid}/forecast")).json()
    batch = (await committing_client.get(f"/api/v1/projects/forecast?ids={oid}")).json()["orders"][0]
    for result in (detail, batch):
        assert result["machine_seconds"] == 8 * 3600
        assert result["eta_complete"] is False
        assert {r["code"] for r in result["incomplete_reasons"]} == {"unplanned_parts"}
    second, _ = await _order(db_session, farm["product"].id, 1)
    following = (await committing_client.get(f"/api/v1/projects/{second}/forecast")).json()
    assert following["now_eta"] is not None
    assert following["after_eta"] is None
    assert "earlier_orders_incomplete" in following["assumptions"]


async def test_reused_line_id_does_not_retarget_the_old_draft(committing_client, db_session, farm):
    from backend.app.models.project_line import ProjectLine

    oid, lid, _, _, state = await setup_plan(committing_client, db_session, farm)
    token = state["entries"][0]["line_token"]
    assert token
    removed = await committing_client.delete(f"/api/v1/projects/{oid}/lines/{lid}")
    assert removed.status_code == 200, removed.text
    replacement = ProjectLine(id=lid, project_id=oid, product_id=farm["product"].id, quantity=10)
    db_session.add(replacement)
    await db_session.commit()
    assert replacement.plan_identity != token
    result = (await committing_client.get(f"/api/v1/projects/{oid}/working-plan")).json()
    assert result["entries"][0]["count"] == 10
    assert {issue["code"] for issue in result["issues"]} == {"line_unavailable"}


async def test_upgrade_backfills_line_identity_without_creating_baselines(test_engine, db_session, farm):
    from sqlalchemy import text

    from backend.app.migrations.m206_order_working_plans import upgrade

    await _order(db_session, farm["product"].id, 1)
    await _order(db_session, farm["product"].id, 2)
    async with test_engine.begin() as conn:
        await conn.execute(text("ALTER TABLE project_lines DROP COLUMN plan_identity"))
        await upgrade(conn)
        columns = await conn.run_sync(lambda sync: __import__("sqlalchemy").inspect(sync).get_columns("project_lines"))
        assert "plan_identity" in {column["name"] for column in columns}
        identities = (await conn.execute(text("SELECT plan_identity FROM project_lines ORDER BY id"))).scalars().all()
        assert len(identities) == len(set(identities)) == 2
        assert all(len(identity) == 36 for identity in identities)
        await upgrade(conn)
        assert (
            await conn.execute(text("SELECT plan_identity FROM project_lines ORDER BY id"))
        ).scalars().all() == identities
        assert await conn.scalar(text("SELECT count(*) FROM order_working_plans")) == 0
