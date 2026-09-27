"""Issues of goods — the one writer (spec workshop-order-issue, rules 1, 10, 18)."""

import pytest

from backend.app.models.customer import Customer, CustomerContact, DeliveryMethod, delivery_method_key
from backend.app.models.project import Project
from backend.app.models.user import User
from backend.app.services import stock_issues

pytestmark = pytest.mark.integration


@pytest.fixture
async def acme(db_session):
    post = DeliveryMethod(name="Нова пошта", name_key=delivery_method_key("Нова пошта"))
    acme = Customer(name="Acme")
    db_session.add_all([post, acme])
    await db_session.flush()
    main = CustomerContact(customer_id=acme.id, position=0, name="Olena", phone="+380 1", delivery_method_id=post.id)
    other = CustomerContact(
        customer_id=acme.id, position=1, name="Ihor", phone="+380 2", delivery_details="Kyiv, branch 5"
    )
    db_session.add_all([main, other])
    await db_session.commit()
    return {"customer": acme, "main": main, "other": other}


@pytest.mark.asyncio
async def test_the_default_recipient_is_the_orders_contact_else_the_main_one(db_session, acme):
    order = Project(name="O", customer_id=acme["customer"].id, contact_id=acme["other"].id)
    db_session.add(order)
    await db_session.flush()
    got = await stock_issues.default_recipient(db_session, project=order, customer_id=acme["customer"].id)
    assert got == stock_issues.Recipient("Ihor", "+380 2", None, "Kyiv, branch 5")
    got = await stock_issues.default_recipient(db_session, project=None, customer_id=acme["customer"].id)
    assert got == stock_issues.Recipient("Olena", "+380 1", "Нова пошта", None)


@pytest.mark.asyncio
async def test_an_issue_keeps_a_snapshot_of_its_customer_and_recipient(db_session, acme):
    who = User(username="clerk", password_hash="x")
    db_session.add(who)
    await db_session.flush()
    issue = await stock_issues.create(
        db_session,
        customer_id=acme["customer"].id,
        project_id=None,
        recipient=stock_issues.Recipient(" Olena ", "+380 1", "Нова пошта", ""),
        waybill=" 20450000000000 ",
        note=None,
        actor=who,
    )
    assert (issue.customer_name, issue.recipient_name, issue.delivery_details, issue.waybill, issue.created_by) == (
        "Acme",
        "Olena",
        None,
        "20450000000000",
        who.id,
    )


@pytest.mark.asyncio
async def test_refusals(db_session, acme):
    with pytest.raises(stock_issues.StockIssueError) as missing:
        await stock_issues.create(
            db_session,
            customer_id=999999,
            project_id=None,
            recipient=stock_issues.Recipient(),
            waybill=None,
            note=None,
            actor=None,
        )
    assert (str(missing.value), missing.value.status) == ("Customer not found", 404)
    with pytest.raises(stock_issues.StockIssueError) as long:
        await stock_issues.create(
            db_session,
            customer_id=acme["customer"].id,
            project_id=None,
            recipient=stock_issues.Recipient(),
            waybill="1" * 25,
            note=None,
            actor=None,
        )
    assert (str(long.value), long.value.status) == ("A waybill number is at most 24 characters", 422)


@pytest.mark.asyncio
async def test_only_the_waybill_and_the_note_change_afterwards(db_session, acme):
    issue = await stock_issues.create(
        db_session,
        customer_id=acme["customer"].id,
        project_id=None,
        recipient=stock_issues.Recipient("Olena"),
        waybill=None,
        note=None,
        actor=None,
    )
    await stock_issues.update(db_session, issue, waybill="ТТН 1")
    assert (issue.waybill, issue.note, issue.recipient_name) == ("ТТН 1", None, "Olena")
    await stock_issues.update(db_session, issue, note="  at the gate ")
    assert (issue.waybill, issue.note) == ("ТТН 1", "at the gate")


@pytest.mark.asyncio
async def test_detaching_keeps_the_snapshots(db_session, acme):
    who = User(username="clerk2", password_hash="x")
    order = Project(name="O", customer_id=acme["customer"].id)
    db_session.add_all([who, order])
    await db_session.flush()
    issue = await stock_issues.create(
        db_session,
        customer_id=acme["customer"].id,
        project_id=order.id,
        recipient=stock_issues.Recipient("Olena"),
        waybill=None,
        note=None,
        actor=who,
    )
    await stock_issues.detach_customer(db_session, acme["customer"].id)
    await stock_issues.detach_project(db_session, order.id)
    await stock_issues.detach_user(db_session, who.id)
    await db_session.refresh(issue)
    assert (issue.customer_id, issue.project_id, issue.created_by) == (None, None, None)
    assert (issue.customer_name, issue.recipient_name) == ("Acme", "Olena")
