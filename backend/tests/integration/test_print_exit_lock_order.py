"""A print's exit from its order takes the order before the print (WS-13 E13 V04, Codex round 2).

Receiving locks the order row (class 3) and reads what the order's prints made; the exits
lock the same row before they read C1. They must also agree on the PRINT row: the archive
editor and the trash used to lock the print first and the order after it, while
``add-archives`` / ``remove-archives`` lock the order and then write the print — on
PostgreSQL one PATCH and one remove-archives on the same print could each hold what the
other waits for. One order now: order rows (ascending), then the prints (ascending),
then the parts' ledger.

Read off the ``SELECT … FOR UPDATE`` statements each door sends — the ORM statement
carries the lock whatever the dialect renders, so this runs on SQLite too. The
PostgreSQL interleavings themselves are the lock-protocol scenario ``print_exits`` (K02).
"""

import pytest
from sqlalchemy import event
from sqlalchemy.orm import Session

from backend.tests.integration.test_order_issue_review_fixes import _lamp_order
from backend.tests.integration.test_orders_api import _completed_print, catalog  # noqa: F401 — the fixture

pytestmark = pytest.mark.integration


class _Locks:
    """The tables of every ``FOR UPDATE`` statement, in the order they were sent."""

    def __init__(self) -> None:
        self.tables: list[str] = []

    def __call__(self, state) -> None:
        statement = state.statement
        if getattr(statement, "_for_update_arg", None) is None:
            return
        for source in statement.get_final_froms():
            name = getattr(source, "name", None)
            if name:
                self.tables.append(name)
                return

    def __enter__(self):
        event.listen(Session, "do_orm_execute", self)
        return self

    def __exit__(self, *_exc) -> None:
        event.remove(Session, "do_orm_execute", self)


def _first(tables: list[str], name: str) -> int:
    return tables.index(name) if name in tables else -1


async def _setup(client, db, catalog):  # noqa: F811
    order, _ = await _lamp_order(client, catalog, [1])
    other, _ = await _lamp_order(client, catalog, [1])
    printed = await _completed_print(db, order, catalog["file"].id)
    return order, other, printed.id


DOORS = {
    "patch-unfile": lambda c, order, other, a: c.patch(f"/api/v1/archives/{a}", json={"project_id": None}),
    "patch-move": lambda c, order, other, a: c.patch(f"/api/v1/archives/{a}", json={"project_id": other}),
    "patch-leave-completed": lambda c, order, other, a: c.patch(f"/api/v1/archives/{a}", json={"status": "failed"}),
    "trash": lambda c, order, other, a: c.delete(f"/api/v1/archives/{a}"),
    "add-archives": lambda c, order, other, a: c.post(
        f"/api/v1/projects/{other}/add-archives", json={"archive_ids": [a]}
    ),
    "remove-archives": lambda c, order, other, a: c.post(
        f"/api/v1/projects/{order}/remove-archives", json={"archive_ids": [a]}
    ),
}


@pytest.mark.asyncio
@pytest.mark.parametrize("door", list(DOORS))
async def test_an_exit_locks_the_order_and_then_the_print(committing_client, db_session, catalog, door):  # noqa: F811
    order, other, archive_id = await _setup(committing_client, db_session, catalog)
    with _Locks() as locks:
        answered = await DOORS[door](committing_client, order, other, archive_id)
    assert answered.status_code == 200, answered.text
    orders, prints = _first(locks.tables, "projects"), _first(locks.tables, "print_archives")
    assert orders >= 0, f"{door} locked no order: {locks.tables}"
    assert prints >= 0, f"{door} never locked the print it writes: {locks.tables}"
    assert orders < prints, f"{door} locked the print before the order: {locks.tables}"
