"""The Workshop's doors onto the farm-wide distributor are closed to a printer-restricted key
(WS-13 E13 O14, ORD-33 / ORD-34).

A key restricted to some printers may not use the auto-queue, whose distributor may hand
work to any printer (``core/api_key_scope``). An order's plan sent to the auto-queue and a
line's rebalance reach the same distributor, so they are refused the same way; a plan sent
to one printer's queue is an ordinary printer door, judged by the key's list.
"""

import pytest

from backend.tests.integration.test_project_line_passthrough import (  # noqa: F401 — fixtures
    order_line,
    printer_with_queue,
)
from backend.tests.integration.test_workshop_library_rights import _key, _user

pytestmark = pytest.mark.integration

FARM_WIDE = "An API key restricted to specific printers cannot use the farm-wide auto-queue"
RIGHTS = ["orders:update", "orders:file_prints", "queue:create", "queue:update_all"]


@pytest.fixture
async def restricted(db_session, printer_with_queue):
    owner = await _user(db_session, "kfw_owner", RIGHTS)
    raw = await _key(db_session, owner, can_manage_projects=True, can_queue=True, printer_ids=[printer_with_queue.id])
    return {"X-API-Key": raw}


@pytest.mark.asyncio
async def test_a_plan_sent_to_the_auto_queue_is_refused(committing_client, order_line, restricted):
    project, line = order_line
    r = await committing_client.post(
        f"/api/v1/projects/{project.id}/plan/enqueue",
        json={"items": [{"plate_id": 1, "count": 1, "line_id": line.id}], "target": {"kind": "auto"}},
        headers=restricted,
    )
    assert (r.status_code, r.json()["detail"]) == (403, FARM_WIDE)


@pytest.mark.asyncio
async def test_a_plan_sent_to_an_allowed_printer_is_not_refused_as_farm_wide(
    committing_client, order_line, printer_with_queue, restricted
):
    project, line = order_line
    r = await committing_client.post(
        f"/api/v1/projects/{project.id}/plan/enqueue",
        json={
            "items": [{"plate_id": 999999, "count": 1, "line_id": line.id}],
            "target": {"kind": "printer", "printer_id": printer_with_queue.id},
        },
        headers=restricted,
    )
    assert r.json().get("detail") != FARM_WIDE
    assert r.status_code == 404, r.text  # the plate is not there — the route's own answer


@pytest.mark.asyncio
async def test_a_line_rebalance_is_refused(committing_client, order_line, restricted):
    project, line = order_line
    r = await committing_client.post(f"/api/v1/projects/{project.id}/lines/{line.id}/rebalance", headers=restricted)
    assert (r.status_code, r.json()["detail"]) == (403, FARM_WIDE)
