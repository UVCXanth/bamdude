"""The dispatch note's snapshot — written once, in the issuing transaction (spec workshop-dispatch-notes, rules 1–9)."""

import pytest
from sqlalchemy import event, select

from backend.app.models.customer import Customer
from backend.app.models.product import Product, ProductPart
from backend.app.models.product_variant import ProductVariantGroup, ProductVariantOption
from backend.app.models.project import Project
from backend.app.models.project_line import ProjectLine
from backend.app.models.settings import Settings
from backend.app.models.stock_issue import StockIssue, StockIssueLine
from backend.app.models.user import User
from backend.app.services import finished_stock, line_config, order_fulfilment, part_stock, product_delete, stock_issues
from backend.app.services.order_fulfilment import LineRequest
from backend.app.services.stock_issue_views import issue_rows, note_out
from backend.app.services.stock_issues import Recipient

pytestmark = pytest.mark.integration


@pytest.fixture
async def shop(db_session):
    """Lamp (SKU LMP-1, 3 ready) and Pipe (flask ×1, cap ×1; 3 of each free); Acme's active order; clerk; supplier set."""
    lamp = Product(name="Lamp", sku="LMP-1")
    pipe = Product(name="Pipe", sku="PIP-1")
    acme = Customer(name="Acme")
    clerk = User(username="clerk", password_hash="x")
    db_session.add_all([lamp, pipe, acme, clerk])
    await db_session.flush()
    flask = ProductPart(product_id=pipe.id, kind="printed", name="flask", name_key="flask", qty_per_unit=1)
    cap = ProductPart(product_id=pipe.id, kind="printed", name="cap", name_key="cap", qty_per_unit=1)
    db_session.add_all([flask, cap])
    await db_session.flush()
    for part in (flask, cap):
        await part_stock.move(db_session, part_id=part.id, delta=3, reason="manual", note="seed")
    position = await finished_stock.item_for(db_session, lamp.id, {}, create=True)
    await finished_stock.receive(db_session, position, 3)
    order = Project(name="Hall lights", customer_id=acme.id)
    db_session.add(order)
    db_session.add_all(
        [
            Settings(key="document_supplier_name", value="BamDude Workshop"),
            Settings(key="document_supplier_iban", value=" UA00 0000 "),
        ]
    )
    await db_session.commit()
    return {
        "lamp": lamp,
        "pipe": pipe,
        "flask": flask,
        "cap": cap,
        "acme": acme,
        "clerk": clerk,
        "order": order,
        "position": position,
    }


async def _line(db, shop, product, *, quantity, mode="product", counts=None):
    line = ProjectLine(project_id=shop["order"].id, product_id=product.id, quantity=quantity, mode=mode)
    db.add(line)
    await db.flush()
    await line_config.seed_line(db, line, choices=None, counts=counts)
    await db.refresh(shop["order"], ["lines"])
    return line


async def _apply(db, shop, requests):
    # A separate request, as in the app: the setup's locks are not the door's (WS-13 E1 BL2).
    await db.commit()
    return await order_fulfilment.apply(
        db,
        shop["order"],
        requests,
        recipient=Recipient(name="Ivan"),
        waybill=None,
        note=None,
        complete=False,
        actor=shop["clerk"],
    )


async def _manual_issue(db, shop, item, qty):
    issue = await stock_issues.create(
        db,
        customer_id=shop["acme"].id,
        project_id=None,
        recipient=Recipient(),
        waybill=None,
        note=None,
        actor=None,
    )
    await finished_stock.issue(db, item, qty, customer_id=shop["acme"].id, stock_issue_id=issue.id)
    return issue


async def _lines(db, issue):
    rows = await db.execute(
        select(StockIssueLine).where(StockIssueLine.issue_id == issue.id).order_by(StockIssueLine.position)
    )
    return [(r.position, r.product_name, r.sku, r.part_name, r.quantity) for r in rows.scalars()]


@pytest.mark.asyncio
async def test_an_order_issue_is_sealed_with_its_lines_and_snapshot(db_session, shop):
    lamp_line = await _line(db_session, shop, shop["lamp"], quantity=2)
    assert await finished_stock.reserve_for_line(db_session, lamp_line, 2) == 2
    flask, cap = shop["flask"], shop["cap"]
    parts_line = await _line(db_session, shop, shop["pipe"], quantity=1, mode="parts", counts={flask.id: 2, cap.id: 1})
    await part_stock.receive_parts_for_line(db_session, parts_line, {flask.id: 2, cap.id: 1}, created_by=None)
    issue = await _apply(
        db_session,
        shop,
        [LineRequest(lamp_line.id, issue=2), LineRequest(parts_line.id, parts={flask.id: (0, 2), cap.id: (0, 1)})],
    )
    assert await _lines(db_session, issue) == [
        (1, "Lamp", "LMP-1", None, 2),
        (2, "Pipe", "PIP-1", "flask", 2),
        (3, "Pipe", "PIP-1", "cap", 1),
    ]
    assert (issue.units, issue.created_by_name, issue.order_code, issue.order_name) == (
        5,
        "clerk",
        f"OR-{shop['order'].id:04d}",
        "Hall lights",
    )
    assert issue.supplier == {"name": "BamDude Workshop", "address": "", "phone": "", "code": "", "iban": "UA00 0000"}


@pytest.mark.asyncio
async def test_a_manual_issue_is_sealed_without_a_basis(committing_client, db_session, shop):
    body = {"kind": "issue", "item_id": shop["position"].id, "qty": 2, "customer_id": shop["acme"].id}
    r = await committing_client.post("/api/v1/stock/moves", json=body)
    assert r.status_code == 200, r.text
    issue_id = r.json()["issue_id"]
    assert r.json()["issue_code"] == f"DN-{issue_id:04d}"
    issue = await db_session.get(StockIssue, issue_id, populate_existing=True)
    assert (issue.units, issue.order_code, issue.created_by_name) == (2, None, "test_admin")
    assert await _lines(db_session, issue) == [(1, "Lamp", "LMP-1", None, 2)]


@pytest.mark.asyncio
async def test_the_configuration_is_frozen_as_named_then(db_session, shop):
    lamp = shop["lamp"]
    group = ProductVariantGroup(product_id=lamp.id, name="Colour", position=0)
    db_session.add(group)
    await db_session.flush()
    white = ProductVariantOption(group_id=group.id, name="White", position=0)
    black = ProductVariantOption(group_id=group.id, name="Black", position=1)
    db_session.add_all([white, black])
    await db_session.flush()
    group.default_option_id = white.id
    black_position = await finished_stock.item_for(db_session, lamp.id, {group.id: black.id}, create=True)
    await finished_stock.receive(db_session, black_position, 1)
    issue = await _manual_issue(db_session, shop, black_position, 1)
    await stock_issues.seal(db_session, issue, actor=None)
    black.name = "Graphite"
    await db_session.flush()
    [line] = (await db_session.execute(select(StockIssueLine).where(StockIssueLine.issue_id == issue.id))).scalars()
    assert [(c["group_name"], c["option_name"]) for c in line.configuration["choices"]] == [("Colour", "Black")]


@pytest.mark.asyncio
async def test_the_note_keeps_its_basis_and_supplier(db_session, shop):
    line = await _line(db_session, shop, shop["lamp"], quantity=1)
    assert await finished_stock.reserve_for_line(db_session, line, 1) == 1
    issue = await _apply(db_session, shop, [LineRequest(line.id, issue=1)])
    shop["order"].name = "Renamed"
    supplier = (await db_session.execute(select(Settings).where(Settings.key == "document_supplier_name"))).scalar_one()
    supplier.value = "Other Workshop"
    shop["lamp"].name = "Lamp v2"
    await stock_issues.detach_project(db_session, shop["order"].id)
    await db_session.flush()
    await db_session.refresh(issue)
    assert (issue.order_code, issue.order_name, issue.supplier["name"], issue.project_id) == (
        f"OR-{shop['order'].id:04d}",
        "Hall lights",
        "BamDude Workshop",
        None,
    )
    assert await _lines(db_session, issue) == [(1, "Lamp", "LMP-1", None, 1)]


@pytest.mark.asyncio
async def test_a_deleted_product_leaves_the_note_whole(db_session, shop):
    issue = await _manual_issue(db_session, shop, shop["position"], 3)
    await stock_issues.seal(db_session, issue, actor=None)
    # The product's deletion is its own request (WS-13 E1 BL2): the issue's locks are not its own.
    await db_session.commit()
    lamp = shop["lamp"]
    await db_session.refresh(lamp, ["library_files", "library_folders"])
    await product_delete.delete_product(db_session, lamp)
    [line] = (await db_session.execute(select(StockIssueLine).where(StockIssueLine.issue_id == issue.id))).scalars()
    assert (line.product_id, line.product_name, line.sku, line.quantity) == (None, "Lamp", "LMP-1", 3)
    assert issue.units == 3


@pytest.mark.asyncio
async def test_a_note_is_sealed_once_and_never_empty(db_session, shop):
    issue = await stock_issues.create(
        db_session,
        customer_id=shop["acme"].id,
        project_id=None,
        recipient=Recipient(),
        waybill=None,
        note=None,
        actor=None,
    )
    with pytest.raises(stock_issues.StockIssueError) as empty:
        await stock_issues.seal(db_session, issue, actor=None)
    assert (str(empty.value), empty.value.status) == ("An issue that hands nothing over has no dispatch note", 409)
    await finished_stock.issue(db_session, shop["position"], 1, customer_id=shop["acme"].id, stock_issue_id=issue.id)
    await stock_issues.seal(db_session, issue, actor=None)
    with pytest.raises(stock_issues.StockIssueError) as twice:
        await stock_issues.seal(db_session, issue, actor=None)
    assert (str(twice.value), twice.value.status) == ("This issue already has its dispatch note", 409)


@pytest.mark.asyncio
async def test_a_stored_null_is_no_supplier_detail(db_session, shop):
    # Final review M5: the settings route stores a JSON null as the text "None" — never on paper.
    (
        await db_session.execute(select(Settings).where(Settings.key == "document_supplier_iban"))
    ).scalar_one().value = "None"
    assert (await stock_issues.supplier_snapshot(db_session))["iban"] == ""


# ---- WS-13 E12 A01: the list's summary names each line's configuration, from the same snapshot ----


async def _graphite_pipe(db, shop):
    """Pipe in Black (White is the standard) with cap ×2 instead of ×1 — one ready, issued by hand."""
    pipe = shop["pipe"]
    group = ProductVariantGroup(product_id=pipe.id, name="Colour", position=0)
    db.add(group)
    await db.flush()
    white = ProductVariantOption(group_id=group.id, name="White", position=0)
    black = ProductVariantOption(group_id=group.id, name="Black", position=1)
    db.add_all([white, black])
    await db.flush()
    group.default_option_id = white.id
    position = await finished_stock.item_for(db, pipe.id, {group.id: black.id}, {shop["cap"].id: 2}, create=True)
    await finished_stock.receive(db, position, 1)
    issue = await _manual_issue(db, shop, position, 1)
    await stock_issues.seal(db, issue, actor=None)
    return issue, black


@pytest.mark.asyncio
async def test_the_summary_names_the_configuration_the_document_names(committing_client, db_session, shop):
    issue, _ = await _graphite_pipe(db_session, shop)
    [row] = await issue_rows(db_session, [issue])
    document = await note_out(db_session, issue)
    summary = row.summary[0].model_dump()["configuration"]
    assert summary == document.lines[0].configuration.model_dump()
    assert [(c["group_name"], c["option_name"]) for c in summary["choices"]] == [("Colour", "Black")]
    assert [(p["name"], p["qty"]) for p in summary["changed_parts"]] == [("cap", 2)]
    [stored] = (await db_session.execute(select(StockIssueLine).where(StockIssueLine.issue_id == issue.id))).scalars()
    assert summary == stored.configuration
    # On the wire, through the list itself.
    await db_session.commit()
    r = await committing_client.get("/api/v1/stock-issues/", params={"q": f"DN-{issue.id:04d}"})
    assert r.status_code == 200, r.text
    [item] = r.json()["items"]
    assert item["summary"][0]["configuration"] == summary


@pytest.mark.asyncio
async def test_a_part_line_has_no_configuration_in_the_summary(db_session, shop):
    lamp_line = await _line(db_session, shop, shop["lamp"], quantity=1)
    assert await finished_stock.reserve_for_line(db_session, lamp_line, 1) == 1
    flask = shop["flask"]
    parts_line = await _line(db_session, shop, shop["pipe"], quantity=1, mode="parts", counts={flask.id: 1})
    await part_stock.receive_parts_for_line(db_session, parts_line, {flask.id: 1}, created_by=None)
    issue = await _apply(
        db_session, shop, [LineRequest(lamp_line.id, issue=1), LineRequest(parts_line.id, parts={flask.id: (0, 1)})]
    )
    [row] = await issue_rows(db_session, [issue])
    assert [(s.product_name, s.part_name, s.configuration) for s in row.summary][1] == ("Pipe", "flask", None)
    assert row.summary[0].configuration.model_dump() == {"choices": [], "changed_parts": []}


@pytest.mark.asyncio
async def test_the_summary_outlives_a_rename_a_new_part_and_the_product(db_session, shop):
    issue, black = await _graphite_pipe(db_session, shop)
    [before] = await issue_rows(db_session, [issue])
    black.name = "Graphite"
    db_session.add(
        ProductPart(product_id=shop["pipe"].id, kind="printed", name="ring", name_key="ring", qty_per_unit=1)
    )
    await db_session.commit()
    [after_edit] = await issue_rows(db_session, [issue])
    assert after_edit.summary == before.summary
    pipe = shop["pipe"]
    await db_session.refresh(pipe, ["library_files", "library_folders"])
    await product_delete.delete_product(db_session, pipe)
    [after_delete] = await issue_rows(db_session, [issue])
    assert after_delete.summary == before.summary


@pytest.mark.asyncio
async def test_the_summary_costs_the_same_statements_for_one_note_or_many(db_session, shop):
    async def notes(count, lines):
        made = []
        for _ in range(count):
            issue = await stock_issues.create(
                db_session,
                customer_id=shop["acme"].id,
                project_id=None,
                recipient=Recipient(),
                waybill=None,
                note=None,
                actor=None,
            )
            for position in range(1, lines + 1):
                db_session.add(
                    StockIssueLine(
                        issue_id=issue.id,
                        position=position,
                        product_id=shop["lamp"].id,
                        product_name="Lamp",
                        sku="LMP-1",
                        configuration={"choices": [], "changed_parts": []},
                        part_name=None,
                        quantity=1,
                    )
                )
            made.append(issue)
        await db_session.flush()
        return made

    async def statements(issues):
        seen = []

        def count(*_args):
            seen.append(1)

        engine = db_session.bind.sync_engine
        event.listen(engine, "before_cursor_execute", count)
        try:
            await issue_rows(db_session, issues)
        finally:
            event.remove(engine, "before_cursor_execute", count)
        return len(seen)

    one = await statements(await notes(1, 1))
    many = await statements(await notes(10, 5))
    assert one == many
