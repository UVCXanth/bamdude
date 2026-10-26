"""Equivalent plate yields must not erase distinct model lanes in durable plans."""

from copy import deepcopy

import pytest

from backend.tests.integration.test_farm_forecast_api import _order, farm  # noqa: F401

pytestmark = pytest.mark.integration


@pytest.mark.parametrize("replan_kind", [None, "rebuild", "remainder"])
async def test_equivalent_p1s_p2s_files_keep_fleet_split_through_working_plan(
    committing_client, db_session, farm, replan_kind
):
    # Two P1S lanes and one slower P2S: lower per-print time alone must not
    # strand P2S. All geometry is the synthetic fixture's single hook.
    farm["printers"][2].model = "P2S"
    p2s = farm["files"][1]
    metadata = deepcopy(p2s.file_metadata)
    metadata["sliced_for_model"] = "P2S"
    metadata["print_time_seconds"] = 4000
    metadata["plates"][0]["print_time_seconds"] = 4000
    p2s.file_metadata = metadata
    await db_session.commit()
    oid, lid = await _order(db_session, farm["product"].id, 30)
    base = f"/api/v1/projects/{oid}"
    plan = (await committing_client.get(base + "/plan")).json()
    rows = plan["lines"][0]["rows"]
    if replan_kind is None:
        # This is the browser's recommendation -> autosave boundary.
        assert {r["printer_model"] for r in rows if r["count"]} == {"P1S", "P2S"}
        entries = [
            {
                "entry_id": f"initial-{row['plate_id']}",
                "line_id": lid,
                "plate_id": row["plate_id"],
                "count": row["count"],
                "manual": False,
                "target": {"kind": "auto"},
                "line_token": row["line_token"],
                "source_token": row["source_token"],
            }
            for row in rows
        ]
        response = await committing_client.put(
            base + "/working-plan",
            json={
                "expected_revision": 0,
                "inputs_token": plan["inputs_token"],
                "entries": entries,
            },
        )
    else:
        empty = await committing_client.put(base + "/working-plan", json={"expected_revision": 0, "entries": []})
        assert empty.status_code == 200, empty.text
        request = {"expected_revision": empty.json()["revision"], "kind": replan_kind}
        preview = await committing_client.post(base + "/working-plan/replan", json=request)
        assert preview.status_code == 200, preview.text
        proposal = preview.json()
        response = await committing_client.post(
            base + "/working-plan/replan",
            json={
                **request,
                "apply": True,
                "proposal_token": proposal["proposal_token"],
                "proposal_entries": proposal["entries"],
            },
        )
    assert response.status_code == 200, response.text
    effective = (await committing_client.get(base + "/plan")).json()
    rows = effective["lines"][0]["rows"]
    assert {r["printer_model"] for r in rows if r["count"]} == {"P1S", "P2S"}
    assert sum(row["count"] for row in rows) == 30
    before = response.json()["entries"]
    forecast = (await committing_client.get(base + "/forecast")).json()
    by_model = {r["model"]: r for r in forecast["by_model"]}
    assert by_model["P2S"]["prints"] > 0
    assert sum(r["prints"] for r in by_model.values()) == 30
    assert forecast["eta_complete"] is True
    # Forecasts may not silently redistribute an operator's persisted draft.
    assert (await committing_client.get(base + "/working-plan")).json()["entries"] == before
