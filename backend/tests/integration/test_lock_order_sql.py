"""The lock order of the stock doors, read off the SQL they actually send (WS-13 E1, spec BL0 / BL8).

A door that waits on locks takes them in one order of classes — order row, stock
positions, order lines, product parts — and never a lower class after a higher one
(BL0). On SQLite every lock of these services is announced by ``take_write_lock``'s
no-op ``UPDATE <table>``, and every write is a DML statement, so the FIRST statement
touching each table gives the order the door took them in. The PostgreSQL scenarios
check the same doors against a real second session; this file checks every door
cheaply, on every run.

BL8 (в): the doors without product gates (BL6).
"""

import pytest
from starlette.requests import Request

from backend.app.api.routes import projects as routes
from backend.app.models.customer import Customer
from backend.app.models.product import Product
from backend.app.models.project import Project
from backend.app.models.project_line import ProjectLine
from backend.app.schemas.project import (
    FulfilmentIn,
    FulfilmentLineIn,
    ProjectLineUpdate,
    ProjectUpdate,
)
from backend.app.services import finished_stock, line_config
from backend.tests.integration.lock_barriers import SqlRecorder

pytestmark = pytest.mark.integration

# spec BL0 — the classes a door waits on, in the only order it may take them.
LOCK_CLASS = {
    "library_files": 1,
    "products": 2,
    "projects": 3,
    "stock_items": 4,
    "project_lines": 5,
    "product_parts": 6,
    "project_procurements": 7,
}


def _request() -> Request:
    return Request({"type": "http", "method": "POST", "path": "/", "headers": []})


def first_touches(log, *, exempt=()) -> list[str]:
    """Tables of LOCK_CLASS in the order the door first locked or wrote them."""
    order: list[str] = []
    for kind, table, _nowait in log:
        if table not in LOCK_CLASS or (kind, table) in exempt:
            continue
        if kind == "INSERT":
            continue  # a new row is nobody else's lock; its FK checks are BL0's named exceptions
        if table not in order:
            order.append(table)
    return order


def assert_class_order(log, *, exempt=()) -> None:
    order = first_touches(log, exempt=exempt)
    classes = [LOCK_CLASS[t] for t in order]
    assert classes == sorted(classes), f"lock order {order} takes a lower class after a higher one: {log}"


async def _order(db, *, quantity=5, reserved=3, on_hand=6):
    customer = Customer(name="Lock order customer")
    lamp = Product(name="Lock order lamp")
    db.add_all([customer, lamp])
    await db.flush()
    order = Project(name="Lock order", status="active", customer_id=customer.id)
    db.add(order)
    await db.flush()
    line = ProjectLine(project_id=order.id, product_id=lamp.id, quantity=quantity, mode="product", sort_order=0)
    db.add(line)
    await db.flush()
    await line_config.seed_line(db, line, choices=None, counts=None)
    item = await finished_stock.item_for(db, lamp.id, {}, create=True)
    await finished_stock.receive(db, item, on_hand)
    await finished_stock.reserve_for_line(db, line, reserved)
    # Committed: the setup's own locks must not count as the door's (the ledger is
    # per transaction — spec BL2).
    await db.commit()
    return order, line


async def _record(db, call):
    recorder = SqlRecorder(db.bind.sync_engine if hasattr(db.bind, "sync_engine") else db.bind)
    await SqlRecorder.tag(db, "door")
    try:
        await call()
    finally:
        await SqlRecorder.untag(db)
        recorder.close()
    return recorder.log.get("door", [])


@pytest.mark.asyncio
async def test_a_quantity_change_locks_the_position_before_the_line(db_session):
    order, line = await _order(db_session)
    log = await _record(
        db_session, lambda: routes.update_line(order.id, line.id, ProjectLineUpdate(quantity=2), db_session, None)
    )
    assert "stock_items" in first_touches(log)
    assert_class_order(log)


@pytest.mark.asyncio
async def test_a_new_ready_units_number_locks_the_position_before_the_line(db_session):
    order, line = await _order(db_session)
    log = await _record(
        db_session, lambda: routes.update_line(order.id, line.id, ProjectLineUpdate(from_finished=1), db_session, None)
    )
    assert "stock_items" in first_touches(log)
    assert_class_order(log)


@pytest.mark.asyncio
async def test_deleting_a_line_locks_its_position_before_it(db_session):
    order, line = await _order(db_session)
    log = await _record(db_session, lambda: routes.delete_line(order.id, line.id, _request(), db_session, None))
    assert "stock_items" in first_touches(log)
    assert_class_order(log)


@pytest.mark.asyncio
async def test_cancelling_an_order_locks_the_order_then_positions_then_lines(db_session):
    order, _line = await _order(db_session)
    log = await _record(
        db_session,
        lambda: routes.update_project(order.id, ProjectUpdate(status="cancelled"), _request(), db_session, None),
    )
    assert first_touches(log)[:2] == ["projects", "stock_items"]
    assert_class_order(log)


@pytest.mark.asyncio
async def test_deleting_an_order_locks_positions_then_lines(db_session):
    order, _line = await _order(db_session)
    # The order row itself goes last, behind FOR UPDATE NOWAIT on PostgreSQL (spec BL6) —
    # a lock that never waits, so it is outside the waiting order.
    log = await _record(db_session, lambda: routes.delete_project(order.id, _request(), db_session, None))
    assert "stock_items" in first_touches(log, exempt={("DELETE", "projects")})
    assert_class_order(log, exempt={("DELETE", "projects")})


@pytest.mark.asyncio
async def test_an_issue_locks_the_order_row_before_positions_and_lines(db_session):
    order, line = await _order(db_session)
    data = FulfilmentIn(lines=[FulfilmentLineIn(line_id=line.id, issue=1)])
    log = await _record(db_session, lambda: routes.fulfil_order(order.id, data, _request(), db_session, None))
    assert first_touches(log)[:1] == ["projects"]
    assert_class_order(log)


@pytest.mark.asyncio
async def test_a_write_off_locks_the_order_row_before_positions_and_lines(db_session):
    order, line = await _order(db_session)
    data = FulfilmentIn(lines=[FulfilmentLineIn(line_id=line.id, write_off=1)], write_off_note="Broken on the shelf")
    log = await _record(db_session, lambda: routes.fulfil_order(order.id, data, _request(), db_session, None))
    assert first_touches(log)[:1] == ["projects"]
    assert_class_order(log)


@pytest.mark.asyncio
async def test_completing_through_the_issue_dialog_locks_the_order_row_first(db_session):
    order, line = await _order(db_session, quantity=3, reserved=3)
    data = FulfilmentIn(lines=[FulfilmentLineIn(line_id=line.id, issue=3)], complete=True)
    log = await _record(db_session, lambda: routes.fulfil_order(order.id, data, _request(), db_session, None))
    assert first_touches(log)[:1] == ["projects"]
    assert_class_order(log)


@pytest.mark.asyncio
async def test_taking_stock_locks_positions_before_lines(db_session):
    order, _line = await _order(db_session)
    log = await _record(db_session, lambda: routes.take_stock(order.id, _request(), None, db_session, None))
    assert_class_order(log)
