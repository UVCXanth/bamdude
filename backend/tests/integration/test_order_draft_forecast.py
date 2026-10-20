"""A preview follows explicit files/counts without filing work in either queue."""

import pytest
from sqlalchemy import func, select

from backend.app.models.auto_queue import AutoQueueItem
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.product import ProductPlate
from backend.tests.integration.test_farm_forecast_api import _order, farm  # noqa: F401

pytestmark = pytest.mark.integration


async def draft_fixture(db, farm):
    order_id, line_id = await _order(db, farm["product"].id, 10)
    plates = list((await db.scalars(select(ProductPlate).order_by(ProductPlate.id))).all())
    return order_id, line_id, plates


async def test_exact_split_is_forecast_without_queue_writes(committing_client, db_session, farm):
    order_id, line_id, plates = await draft_fixture(db_session, farm)
    before = [await db_session.scalar(select(func.count()).select_from(m)) for m in (AutoQueueItem, PrintQueueItem)]
    plan = (await committing_client.get(f"/api/v1/projects/{order_id}/plan")).json()
    response = await committing_client.post(
        f"/api/v1/projects/{order_id}/plan/forecast-preview",
        json={
            "client_revision": "edited-1",
            "inputs_token": plan["inputs_token"],
            "entries": [
                {"entry_id": "p1", "line_id": line_id, "plate_id": plates[0].id, "count": 6},
                {"entry_id": "x1", "line_id": line_id, "plate_id": plates[1].id, "count": 4},
            ],
        },
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["client_revision"] == "edited-1"
    assert data["coverage_complete"] is True
    assert data["forecast"]["eta_complete"] is True
    assert sorted(m["prints"] for m in data["forecast"]["by_model"]) == [4, 6]
    assert data["totals"]["prints"] == 10
    assert before == [
        await db_session.scalar(select(func.count()).select_from(m)) for m in (AutoQueueItem, PrintQueueItem)
    ]


@pytest.mark.parametrize("count,missing,surplus", [(8, 2, 0), (12, 0, 2), (0, 10, 0)])
async def test_coverage_is_not_the_selected_plans_finish(committing_client, db_session, farm, count, missing, surplus):
    order_id, line_id, plates = await draft_fixture(db_session, farm)
    response = await committing_client.post(
        f"/api/v1/projects/{order_id}/plan/forecast-preview",
        json={
            "client_revision": "a",
            "entries": (
                [{"entry_id": "e", "line_id": line_id, "plate_id": plates[0].id, "count": count}] if count else []
            ),
        },
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert sum(p["missing"] for p in data["coverage"]) == missing
    assert sum(p["surplus"] for p in data["coverage"]) == surplus
    assert data["coverage_complete"] is (missing == 0)
    if missing:
        assert data["order_ready_at"] is None


async def test_source_changes_reject_stale_inputs_but_names_do_not(committing_client, db_session, farm):
    order_id, line_id, plates = await draft_fixture(db_session, farm)
    path = f"/api/v1/projects/{order_id}/plan"
    token = (await committing_client.get(path)).json()["inputs_token"]
    body = {
        "client_revision": "a",
        "inputs_token": token,
        "entries": [
            {"entry_id": "e", "line_id": line_id, "plate_id": plates[0].id, "count": 10},
        ],
    }
    farm["files"][0].filename = "renamed.gcode.3mf"
    await db_session.commit()
    assert (await committing_client.post(path + "/forecast-preview", json=body)).status_code == 200
    farm["files"][0].file_hash = "a" * 64
    await db_session.commit()
    result = await committing_client.post(path + "/forecast-preview", json=body)
    assert result.status_code == 409
    assert result.json()["detail"]["code"] == "inputs_changed"


async def test_foreign_line_and_expansion_limits(committing_client, db_session, farm):
    order_id, line_id, plates = await draft_fixture(db_session, farm)
    _, other_line = await _order(db_session, farm["product"].id, 1)
    base = {"entry_id": "e", "line_id": other_line, "plate_id": plates[0].id, "count": 1}
    path = f"/api/v1/projects/{order_id}/plan/forecast-preview"
    bad = await committing_client.post(path, json={"client_revision": "a", "entries": [base]})
    assert bad.status_code == 422
    assert bad.json()["detail"]["code"] == "invalid_draft"
    excessive = [{**base, "entry_id": str(i), "line_id": line_id, "count": 999} for i in range(11)]
    assert (await committing_client.post(path, json={"client_revision": "a", "entries": excessive})).status_code == 422


async def test_explicit_target_waits_for_that_printer(committing_client, db_session, farm):
    order_id, line_id, plates = await draft_fixture(db_session, farm)
    from datetime import datetime

    from backend.app.models.print_queue import PrintQueueItem
    from backend.app.schemas.order_draft import DraftEntry
    from backend.app.services.order_draft import preview

    busy = farm["printers"][0]
    db_session.add(PrintQueueItem(queue_id=busy.id, library_file_id=farm["files"][0].id, status="pending", position=1))
    await db_session.commit()
    data = await preview(
        db_session,
        order_id,
        [
            DraftEntry(
                entry_id="e",
                line_id=line_id,
                plate_id=plates[0].id,
                count=1,
                target={"kind": "printer", "printer_id": busy.id},
            )
        ],
        datetime(2026, 10, 20),
    )
    assert data["forecast"]["now_seconds"] >= 7200


async def test_nominal_time_survives_missing_farm_and_forecast_failure(
    committing_client, db_session, farm, monkeypatch
):
    from backend.app.services import farm_forecast

    order_id, line_id, plates = await draft_fixture(db_session, farm)

    async def broken(*_):
        raise RuntimeError("simulation unavailable")

    monkeypatch.setattr(farm_forecast, "load_snapshot", broken)
    response = await committing_client.post(
        f"/api/v1/projects/{order_id}/plan/forecast-preview",
        json={
            "client_revision": "a",
            "entries": [{"entry_id": "e", "line_id": line_id, "plate_id": plates[0].id, "count": 10}],
        },
    )
    assert response.status_code == 200, response.text
    answer = response.json()
    assert answer["workload"]["total_seconds"] == 36000
    assert answer["forecast"] is None
    assert answer["forecast_error"] == "forecast_unavailable"
    assert answer["comparison"]["status"] == "no_baseline"


async def test_unknown_time_is_not_a_complete_partial_sum(committing_client, db_session, farm):
    order_id, line_id, plates = await draft_fixture(db_session, farm)
    file = farm["files"][1]
    file.file_metadata = {
        **file.file_metadata,
        "print_time_seconds": None,
        "plates": [{**file.file_metadata["plates"][0], "print_time_seconds": None}],
    }
    await db_session.commit()
    answer = (
        await committing_client.post(
            f"/api/v1/projects/{order_id}/plan/forecast-preview",
            json={
                "client_revision": "a",
                "entries": [
                    {"entry_id": "p", "line_id": line_id, "plate_id": plates[0].id, "count": 6},
                    {"entry_id": "x", "line_id": line_id, "plate_id": plates[1].id, "count": 4},
                ],
            },
        )
    ).json()
    assert answer["workload"]["known_seconds"] == 21600
    assert answer["workload"]["unknown_prints"] == 4
    assert answer["workload"]["total_seconds"] is None
    assert answer["totals"]["print_time_seconds"] is None


async def test_same_file_on_two_targets_preserves_each_entry(db_session, farm):
    from datetime import datetime

    from backend.app.schemas.order_draft import DraftEntry
    from backend.app.services.order_draft import preview

    order_id, line_id, plates = await draft_fixture(db_session, farm)
    data = await preview(
        db_session,
        order_id,
        [
            DraftEntry(
                entry_id=str(printer.id),
                line_id=line_id,
                plate_id=plates[0].id,
                count=1,
                target={"kind": "printer", "printer_id": printer.id},
            )
            for printer in farm["printers"][:2]
        ],
        datetime(2026, 10, 20),
    )
    assert data["workload"]["total_seconds"] == 7200
    assert data["forecast"]["now_seconds"] == 3600


async def test_invisible_source_is_an_issue_not_a_zero_time_plan(db_session, farm):
    from datetime import datetime

    from backend.app.schemas.order_draft import DraftEntry
    from backend.app.services.order_draft import preview

    order_id, line_id, plates = await draft_fixture(db_session, farm)
    data = await preview(
        db_session,
        order_id,
        [DraftEntry(entry_id="e", line_id=line_id, plate_id=plates[0].id, count=10)],
        datetime(2026, 10, 20),
        visible=lambda _: False,
    )
    assert data["issues"] == [{"entry_id": "e", "code": "source_unavailable"}]
    assert data["workload"]["total_seconds"] is None
    assert data["workload"]["unknown_prints"] == 10
    assert not data["coverage_complete"]


async def test_maximum_draft_budget_is_not_truncated(committing_client, db_session, farm):
    from time import perf_counter

    order_id, line_id, plates = await draft_fixture(db_session, farm)
    start = perf_counter()
    response = await committing_client.post(
        f"/api/v1/projects/{order_id}/plan/forecast-preview",
        json={
            "client_revision": "max",
            "entries": [
                {"entry_id": str(i), "line_id": line_id, "plate_id": plates[0].id, "count": n}
                for i, n in enumerate([999] * 10 + [10])
            ],
        },
    )
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["workload"]["prints"] == 10000
    assert result["workload"]["total_seconds"] == 36000000
    assert result["forecast"]["eta_complete"]
    print(f"maximum exact draft (10000 jobs): {perf_counter() - start:.3f}s")
