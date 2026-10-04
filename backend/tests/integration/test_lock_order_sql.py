"""The lock order of the stock doors, read off the SQL they actually send (WS-13 E1, spec BL0 / BL8).

A door that waits on locks takes them in one order of classes — order row, stock
positions, order lines, product parts — and never a lower class after a higher one
(BL0). On SQLite every lock of these services is announced by ``take_write_lock``'s
no-op ``UPDATE <table>``, and every write is a DML statement, so the FIRST statement
touching each table gives the order the door took them in. The PostgreSQL scenarios
check the same doors against a real second session; this file checks every door
cheaply, on every run.

BL8 (в): the doors without product gates (BL6). BL8 (а): a gated door's first write
or lock is its gate (SQLite: the gate's no-op ``UPDATE products``). BL8 (б): the one-off
plate preparation — the only statements allowed before the gates. BL8 (г): a re-entry
sends no ``products`` statement.
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
    "project_procurement": 7,
}


def _request() -> Request:
    return Request({"type": "http", "method": "POST", "path": "/", "headers": []})


class _AllowEverything:
    """The request's credentials for a door called directly: every right is held (WS-13 E13 §O).

    These tests read the SQL a door sends; who may open it is the rights tests' question."""

    async def check(self, _gate):
        return None, True

    async def allows(self, _gate) -> bool:
        return True


ALLOW = _AllowEverything()


@pytest.fixture(autouse=True)
def _every_file_visible(monkeypatch):
    """The order-from-files doors ask the library who may see a file (WS-13 E13 B07); a door
    called directly has no request credentials, so here every file is visible."""

    async def _visible(_request, _db, _user):
        return lambda _file: True

    monkeypatch.setattr(routes, "_library_visible", _visible)


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


def assert_gate_first(log) -> None:
    """BL8 (а): nothing is written or locked before the gate, and a re-entry (BL8 г)
    sends no ``products`` statement after the first lock of another class."""
    assert log, "the door sent nothing"
    assert log[0] == ("UPDATE", "products", False), f"the gate is not the first write or lock: {log[:6]}"
    later = [i for i, (_kind, table, _nw) in enumerate(log) if table != "products"]
    first_other = later[0] if later else len(log)
    assert all(table != "products" or kind != "UPDATE" for kind, table, _nw in log[first_other:]), (
        f"a gate statement after other locks: {log}"
    )


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
        db_session,
        lambda: routes.update_line(order.id, line.id, ProjectLineUpdate(quantity=2), db_session, None, creds=ALLOW),
    )
    assert "stock_items" in first_touches(log)
    assert_class_order(log)


@pytest.mark.asyncio
async def test_a_new_ready_units_number_locks_the_position_before_the_line(db_session):
    order, line = await _order(db_session)
    log = await _record(
        db_session,
        lambda: routes.update_line(
            order.id, line.id, ProjectLineUpdate(from_finished=1), db_session, None, creds=ALLOW
        ),
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
    log = await _record(
        db_session, lambda: routes.fulfil_order(order.id, data, _request(), db_session, None, creds=ALLOW)
    )
    assert_gate_first(log)
    assert first_touches(log)[:2] == ["products", "projects"]
    assert_class_order(log)


@pytest.mark.asyncio
async def test_a_write_off_locks_the_order_row_before_positions_and_lines(db_session):
    order, line = await _order(db_session)
    data = FulfilmentIn(lines=[FulfilmentLineIn(line_id=line.id, write_off=1)], write_off_note="Broken on the shelf")
    log = await _record(
        db_session, lambda: routes.fulfil_order(order.id, data, _request(), db_session, None, creds=ALLOW)
    )
    assert_gate_first(log)
    assert first_touches(log)[:2] == ["products", "projects"]
    assert_class_order(log)


@pytest.mark.asyncio
async def test_completing_through_the_issue_dialog_locks_the_order_row_first(db_session):
    order, line = await _order(db_session, quantity=3, reserved=3)
    data = FulfilmentIn(lines=[FulfilmentLineIn(line_id=line.id, issue=3)], complete=True)
    log = await _record(
        db_session, lambda: routes.fulfil_order(order.id, data, _request(), db_session, None, creds=ALLOW)
    )
    assert_gate_first(log)
    assert first_touches(log)[:2] == ["products", "projects"]
    assert_class_order(log)


@pytest.mark.asyncio
async def test_taking_stock_locks_positions_before_lines(db_session):
    order, _line = await _order(db_session)
    log = await _record(db_session, lambda: routes.take_stock(order.id, _request(), None, db_session, None))
    assert_class_order(log)


# ---------- BL8 (а) — the gated doors of spec BL3 ----------


@pytest.mark.asyncio
async def test_creating_an_order_with_lines_takes_the_gates_before_inserting_it(db_session):
    from backend.app.schemas.project import ProjectCreate, ProjectLineCreate

    lamp = Product(name="Gate lamp")
    db_session.add(lamp)
    await db_session.commit()
    data = ProjectCreate(name="Gate order", lines=[ProjectLineCreate(product_id=lamp.id, quantity=2)])
    log = await _record(db_session, lambda: routes.create_project(data, db_session, None, creds=ALLOW))
    assert_gate_first(log)


@pytest.mark.asyncio
async def test_adding_a_line_takes_the_gate_before_inserting_it(db_session):
    from backend.app.schemas.project import ProjectLineCreate

    order, line = await _order(db_session)
    log = await _record(
        db_session,
        lambda: routes.add_line(
            order.id, ProjectLineCreate(product_id=line.product_id, quantity=1), db_session, None, creds=ALLOW
        ),
    )
    assert_gate_first(log)
    assert_class_order(log)


@pytest.mark.asyncio
async def test_copying_an_order_takes_the_gates_before_inserting_the_copy(db_session):
    from backend.app.schemas.project import ProjectDuplicate

    order, _line = await _order(db_session)
    log = await _record(db_session, lambda: routes.duplicate_project(order.id, ProjectDuplicate(), db_session, None))
    assert_gate_first(log)


@pytest.mark.asyncio
async def test_deleting_a_line_takes_its_products_gate_first(db_session):
    order, line = await _order(db_session)
    log = await _record(db_session, lambda: routes.delete_line(order.id, line.id, _request(), db_session, None))
    assert_gate_first(log)
    assert_class_order(log)


@pytest.mark.asyncio
async def test_deleting_an_order_takes_its_products_gates_first(db_session):
    order, _line = await _order(db_session)
    log = await _record(db_session, lambda: routes.delete_project(order.id, _request(), db_session, None))
    assert_gate_first(log)
    assert_class_order(log, exempt={("DELETE", "projects"), ("DELETE", "products")})


@pytest.mark.asyncio
async def test_closing_an_order_to_stock_takes_the_gates_before_the_order_row(db_session):
    order, _line = await _order(db_session, quantity=3, reserved=3)
    order.customer_id = None
    await db_session.commit()
    log = await _record(
        db_session,
        lambda: routes.update_project(order.id, ProjectUpdate(status="completed"), _request(), db_session, None),
    )
    assert_gate_first(log)
    assert first_touches(log)[:2] == ["products", "projects"]
    assert_class_order(log)


@pytest.mark.asyncio
async def test_a_receipt_that_creates_a_position_takes_the_gate_first(db_session):
    from backend.app.api.routes import stock as stock_routes
    from backend.app.schemas.finished_stock import StockMoveIn

    lamp = Product(name="Receipt lamp")
    db_session.add(lamp)
    await db_session.commit()
    data = StockMoveIn(kind="receipt", product_id=lamp.id, qty=2)
    log = await _record(db_session, lambda: stock_routes.move_stock(data, _request(), db_session, None, creds=ALLOW))
    assert_gate_first(log)


@pytest.mark.asyncio
async def test_adding_a_variant_group_takes_the_gate_first(db_session):
    from backend.app.api.routes import products as product_routes
    from backend.app.schemas.product import VariantGroupCreate

    _order_row, line = await _order(db_session)
    data = VariantGroupCreate(name="Shade", options=["round", "square"])
    log = await _record(
        db_session, lambda: product_routes.create_variant_group(line.product_id, data, db_session, None)
    )
    assert_gate_first(log)


@pytest.mark.asyncio
async def test_deleting_a_product_takes_the_gate_first(db_session):
    from backend.app.api.routes import products as product_routes

    lamp = Product(name="Doomed lamp")
    db_session.add(lamp)
    await db_session.commit()
    log = await _record(db_session, lambda: product_routes.delete_product(lamp.id, db_session, None, creds=ALLOW))
    assert_gate_first(log)


# ---------- BL8 (б) — the one-off plate preparation ----------

_PLATE_FILE = {
    "sliced_for_model": "P1S",
    "plates": [
        {
            "index": 1,
            "printable_objects": {"1": "flask", "2": "cap"},
            "print_time_seconds": 3600,
            "filaments": [{"slot_id": 1, "type": "PETG"}],
        }
    ],
}
# BL8 б: what may precede the gates — the file lock, the new products and the sync's writes.
_PREP_TABLES = {"library_files", "products", "product_files", "product_plates", "product_facets", "product_parts"}


async def _plate_file(db):
    from backend.app.models.library import LibraryFile

    f = LibraryFile(
        filename="plate-job.gcode.3mf",
        file_path="plate-job.gcode.3mf",
        file_size=1,
        file_type="3mf",
        file_metadata=_PLATE_FILE,
    )
    db.add(f)
    await db.commit()
    return f


@pytest.mark.asyncio
async def test_an_order_from_a_plate_prepares_its_product_then_takes_the_gates(db_session):
    from backend.app.schemas.order_from_files import PlateCopiesIn, PlatesOrderIn

    f = await _plate_file(db_session)
    data = PlatesOrderIn(kind="plates", library_file_id=f.id, plates=[PlateCopiesIn(plate_index=1, copies=2)])
    log = await _record(
        db_session, lambda: routes.create_project_from_files(data, _request(), db_session, None, creds=ALLOW)
    )
    first_order = next(i for i, (kind, table, _nw) in enumerate(log) if (kind, table) == ("INSERT", "projects"))
    before = log[:first_order]
    assert {table for _kind, table, _nw in before} <= _PREP_TABLES, before
    assert ("UPDATE", "library_files", False) in before, "the file is locked before the product is made"
    assert all(table != "library_files" for _kind, table, _nw in log[first_order:]), "no file lock after the gates"


@pytest.mark.asyncio
async def test_a_plate_product_seeds_its_own_parts_not_the_catalogue_products(db_session):
    """Review round 5: the file already belongs to a catalogue product that lacks one of
    the file's objects. Making the plate's one-off product links the file to both — and
    must not seed the missing part into the catalogue product, whose gate it does not hold."""
    from sqlalchemy import select

    from backend.app.models.product import ProductPart
    from backend.app.schemas.order_from_files import PlateCopiesIn, PlatesOrderIn
    from backend.app.services.product_sync import sync_product_for_file

    f = await _plate_file(db_session)
    catalogue = Product(name="Catalogue flask")
    db_session.add(catalogue)
    await db_session.flush()
    await sync_product_for_file(db_session, library_file_id=f.id, product_ids=[catalogue.id])
    await db_session.flush()
    cap = (
        await db_session.execute(
            select(ProductPart).where(ProductPart.product_id == catalogue.id, ProductPart.name_key == "cap")
        )
    ).scalar_one()
    await db_session.delete(cap)
    await db_session.commit()
    before = set(await db_session.scalars(select(ProductPart.name_key).where(ProductPart.product_id == catalogue.id)))

    data = PlatesOrderIn(kind="plates", library_file_id=f.id, plates=[PlateCopiesIn(plate_index=1, copies=1)])
    await routes.create_project_from_files(data, _request(), db_session, None, creds=ALLOW)
    await db_session.commit()

    after = set(await db_session.scalars(select(ProductPart.name_key).where(ProductPart.product_id == catalogue.id)))
    assert after == before == {"flask"}, "the catalogue product got a part seeded behind its back"


@pytest.mark.asyncio
async def test_a_job_order_locks_its_files_prepares_its_product_then_takes_the_gates(db_session):
    """Final review I3: the wizard's one-off product is the same preparation as a plate's."""
    from backend.app.schemas.order_from_files import JobOrderIn

    f = await _plate_file(db_session)
    data = JobOrderIn(kind="job", name="Job", file_ids=[f.id], targets={"flask": 2})
    log = await _record(
        db_session, lambda: routes.create_project_from_files(data, _request(), db_session, None, creds=ALLOW)
    )
    first_order = next(i for i, (kind, table, _nw) in enumerate(log) if (kind, table) == ("INSERT", "projects"))
    before = log[:first_order]
    assert {table for _kind, table, _nw in before} <= _PREP_TABLES, before
    lock = before.index(("UPDATE", "library_files", False))
    made = before.index(("INSERT", "products", False))
    assert lock < made, "the file is locked before the product is made"
    assert all(table != "library_files" for _kind, table, _nw in log[first_order:]), "no file lock after the gates"
