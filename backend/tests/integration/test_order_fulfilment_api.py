"""The issue dialog's endpoints, the completion gate and the figures (spec workshop-order-issue, rules 12, 18, 19, 23)."""

import pytest
from sqlalchemy import func, select

from backend.app.models.archive import PrintArchive
from backend.app.models.archive_part import PrintArchivePart
from backend.app.models.customer import Customer, CustomerContact, DeliveryMethod
from backend.app.models.finished_stock import StockItemMovement
from backend.app.models.product import Product, ProductPart
from backend.app.models.project import Project
from backend.app.models.project_line import ProjectLine
from backend.app.models.stock_issue import StockIssue
from backend.app.services import finished_stock, line_config, part_stock

pytestmark = pytest.mark.integration


@pytest.fixture
async def order(db_session):
    """The spec's line: Pipe ×10 for Acme — 2 ready off the shelf, 3 kits, 5 printed."""
    pipe = Product(name="Pipe")
    post = DeliveryMethod(name="Nova Poshta", name_key="nova poshta")
    acme = Customer(name="Acme")
    db_session.add_all([pipe, post, acme])
    await db_session.flush()
    db_session.add(
        CustomerContact(
            customer_id=acme.id,
            name="Ivan",
            phone="+380501112233",
            delivery_method_id=post.id,
            delivery_details="Branch 5",
        )
    )
    flask = ProductPart(product_id=pipe.id, kind="printed", name="flask", name_key="flask", qty_per_unit=1)
    db_session.add(flask)
    await db_session.flush()
    await part_stock.move(db_session, part_id=flask.id, delta=3, reason="manual", note="seed")
    position = await finished_stock.item_for(db_session, pipe.id, {}, create=True)
    await finished_stock.receive(db_session, position, 2)
    project = Project(name="O", customer_id=acme.id)
    db_session.add(project)
    await db_session.flush()
    line = ProjectLine(project_id=project.id, product_id=pipe.id, quantity=10)
    db_session.add(line)
    await db_session.flush()
    await line_config.seed_line(db_session, line, choices=None, counts=None)
    assert await finished_stock.reserve_for_line(db_session, line, 2) == 2
    assert await part_stock.reserve_for_line(db_session, line, 3) == 3
    archive = PrintArchive(
        project_id=project.id,
        project_line_id=line.id,
        filename="pipe",
        file_path="",
        file_size=0,
        status="completed",
        quantity=1,
    )
    db_session.add(archive)
    await db_session.flush()
    db_session.add(PrintArchivePart(archive_id=archive.id, name="flask", name_key="flask", quantity=5))
    await db_session.commit()
    return {"id": project.id, "line_id": line.id, "acme": acme}


def _url(order):
    return f"/api/v1/projects/{order['id']}/fulfilment"


async def _line(client, order):
    [line] = (await client.get(f"/api/v1/projects/{order['id']}")).json()["lines"]
    return line


@pytest.mark.asyncio
async def test_the_dialog_reads_the_orders_state_and_its_recipient(committing_client, order):
    r = await committing_client.get(_url(order))
    assert r.status_code == 200, r.text
    body = r.json()
    # WS-13 E6 H04 added each line's configuration and stock position — pinned on
    # their own below, so the rest of the row keeps its exact shape.
    [row] = body["lines"]
    configuration, position = row.pop("configuration"), row.pop("stock_position")
    assert configuration["choices"] == [] and configuration["changed_parts"] == []
    assert position["code"] == f"SK-{position['id']:04d}" and position["location"] is None
    assert body["lines"] == [
        {
            "line_id": order["line_id"],
            "product_name": "Pipe",
            "mode": "product",
            "ordered": 10,
            "from_finished": 2,
            "kits_reserved": 3,
            "can_assemble": 3,
            "can_receive": 5,
            "held": 2,
            "issued": 0,
            "written_off": 0,
            "parts": [],
        }
    ]
    assert (body["ordered"], body["issued"], body["held"], body["fully_issued"]) == (10, 0, 2, False)
    # The order's own totals, so the banner never adds the rows up (WS-01).
    assert (body["can_assemble"], body["can_receive"], body["can_issue"]) == (3, 5, 10)
    assert body["recipient"] == {
        "name": "Ivan",
        "phone": "+380501112233",
        "delivery_method": "Nova Poshta",
        "delivery_details": "Branch 5",
    }


@pytest.mark.asyncio
async def test_a_batch_is_performed_and_answers_its_issue(committing_client, db_session, order):
    body = {
        "lines": [{"line_id": order["line_id"], "assemble": 3, "receive": 5, "issue": 4}],
        "recipient": {"name": "Petro", "phone": "+380", "delivery_method": "Nova Poshta", "delivery_details": "B7"},
        "waybill": "20450000000001",
        "note": "first box",
        "complete": False,
    }
    r = await committing_client.post(_url(order), json=body)
    assert r.status_code == 200, r.text
    out = r.json()
    issue = await db_session.get(StockIssue, out["issue_id"])
    assert (issue.customer_id, issue.recipient_name, issue.waybill, issue.note) == (
        order["acme"].id,
        "Petro",
        "20450000000001",
        "first box",
    )
    [line] = out["order"]["lines"]
    assert (line["assembled"], line["received"], line["issued"], line["held"]) == (3, 5, 4, 6)
    assert out["order"]["status"] == "active"


@pytest.mark.asyncio
async def test_a_refusal_is_the_sentence_of_the_service(committing_client, order):
    r = await committing_client.post(_url(order), json={"lines": [{"line_id": order["line_id"], "issue": 3}]})
    assert r.status_code == 409
    assert r.json()["detail"] == "«Pipe»: only 2 can be issued"
    nothing = await committing_client.post(_url(order), json={"lines": [{"line_id": order["line_id"]}]})
    assert (nothing.status_code, nothing.json()["detail"]) == (422, "Nothing to do")


@pytest.mark.asyncio
async def test_a_waybill_is_at_most_24_characters(committing_client, order):
    body = {"lines": [{"line_id": order["line_id"], "issue": 1}], "waybill": "1" * 25}
    assert (await committing_client.post(_url(order), json=body)).status_code == 422


@pytest.mark.asyncio
async def test_an_order_completes_only_fully_issued(committing_client, db_session, order):
    r = await committing_client.patch(f"/api/v1/projects/{order['id']}", json={"status": "completed"})
    assert r.status_code == 409
    assert r.json()["detail"] == "Issue everything the order holds before completing it"
    moves = await db_session.scalar(
        select(func.count()).select_from(StockItemMovement).where(StockItemMovement.kind == "issue")
    )
    assert moves == 0  # the WS-10 silent issue at completion is gone

    everything = {"lines": [{"line_id": order["line_id"], "assemble": 3, "receive": 5, "issue": 10}], "complete": True}
    r = await committing_client.post(_url(order), json=everything)
    assert r.status_code == 200, r.text
    assert r.json()["order"]["status"] == "completed"


@pytest.mark.asyncio
async def test_a_fully_issued_order_may_be_completed_by_patch_too(committing_client, order):
    everything = {"lines": [{"line_id": order["line_id"], "assemble": 3, "receive": 5, "issue": 10}]}
    assert (await committing_client.post(_url(order), json=everything)).status_code == 200
    r = await committing_client.patch(f"/api/v1/projects/{order['id']}", json={"status": "completed"})
    assert r.status_code == 200, r.text


@pytest.mark.asyncio
async def test_the_orders_list_says_how_much_went_out(committing_client, order):
    body = {"lines": [{"line_id": order["line_id"], "assemble": 3, "receive": 5, "issue": 4}]}
    assert (await committing_client.post(_url(order), json=body)).status_code == 200
    [row] = (await committing_client.get("/api/v1/projects/")).json()
    assert (row["ordered"], row["issued_units"]) == (10, 4)


@pytest.mark.asyncio
async def test_assembling_a_kit_does_not_change_the_lines_coverage(committing_client, order):
    before = await _line(committing_client, order)
    assert (before["from_stock_units"], before["from_kit_units"], before["covered_units"]) == (5, 3, 10)
    body = {"lines": [{"line_id": order["line_id"], "assemble": 3}]}
    assert (await committing_client.post(_url(order), json=body)).status_code == 200
    after = await _line(committing_client, order)
    assert (after["from_stock_units"], after["from_kit_units"], after["covered_units"]) == (5, 3, 10)
    assert all(
        part["need"] == before_part["need"] for part, before_part in zip(after["parts"], before["parts"], strict=True)
    )


@pytest.mark.asyncio
async def test_the_order_figures_carry_issued_and_held_as_the_lines_sum_them(committing_client, order):
    """WS-13 E1 OR8: the order page's «issued» / «held» tiles are the lines' own
    counters summed on the server, and ``counts.issues`` counts the order's notes."""
    body = {"lines": [{"line_id": order["line_id"], "assemble": 3, "receive": 5, "issue": 4}]}
    assert (await committing_client.post(_url(order), json=body)).status_code == 200
    detail = (await committing_client.get(f"/api/v1/projects/{order['id']}")).json()
    lines = detail["lines"]
    assert detail["figures"]["issued_units"] == sum(line["issued"] for line in lines) == 4
    assert detail["figures"]["held_units"] == sum(line["held"] for line in lines) == 6
    assert detail["counts"]["issues"] == 1
