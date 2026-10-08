"""Cross-feature acceptance for loose reservations and additional BOM parts."""

import pytest

from backend.app.models.project_line import ProjectLine
from backend.app.services import part_stock
from backend.tests.integration.test_workshop_extra_parts import extra_order
from backend.tests.integration.test_workshop_stock_plan_regressions import shop as shop

pytestmark = [pytest.mark.integration, pytest.mark.asyncio]


@pytest.mark.parametrize(
    "first_delivery, expected_kits, expected_loose_a, expected_loose_b", [(15, 5, 3, 5), (30, 0, 3, 10), (33, 0, 0, 10)]
)
async def test_later_delivery_does_not_offer_extras_as_a_missing_base_kit(
    committing_client, db_session, shop, first_delivery, expected_kits, expected_loose_a, expected_loose_b
):
    s = await extra_order(committing_client, db_session, shop, a=10, b=0)
    await part_stock.move(db_session, part_id=s["a"].id, delta=first_delivery, reason="manual")
    await db_session.commit()
    url = f"/api/v1/projects/{s['order']}/take-stock"
    response = await committing_client.post(url, json={})
    assert response.status_code == 200, response.text
    for part, qty in ((s["a"], 33 - first_delivery), (s["b"], 10)):
        if qty:
            await part_stock.move(db_session, part_id=part.id, delta=qty, reason="manual")
    await db_session.commit()
    offers = await committing_client.get(f"/api/v1/projects/{s['order']}/stock-offers")
    assert offers.status_code == 200, offers.text
    [offer] = offers.json()
    assert offer["kits"] == expected_kits
    assert offer["parts"] == {
        **({str(s["a"].id): expected_loose_a} if expected_loose_a else {}),
        str(s["b"].id): expected_loose_b,
    }
    response = await committing_client.post(url, json={"lines": offers.json()})
    assert response.status_code == 200, response.text
    line = await db_session.get(ProjectLine, s["line"])
    assert await part_stock.reserved_parts_for_line(db_session, line) == {s["a"].id: 33, s["b"].id: 10}
    assert await part_stock.balances(db_session, s["a"].product_id) == {s["a"].id: 0, s["b"].id: 0}
    response = await committing_client.post(url, json={})
    assert response.status_code == 200 and response.json()["results"] == []
    response = await committing_client.post(
        f"/api/v1/projects/{s['order']}/fulfilment",
        json={"lines": [{"line_id": s["line"], "assemble": 10, "parts": [{"part_id": s["a"].id, "receive": 3}]}]},
    )
    assert response.status_code == 200, response.text
    assert await part_stock.reserved_parts_for_line(db_session, line) == {}
