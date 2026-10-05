"""A print leaving its order and a receipt of its output are serialized (WS-13 E13 V04).

C1 — a print whose output the order received cannot leave it — was read before any lock, so a
receipt committed between that read and the exit's write let both pass: the order kept the
received unit and the print it came from was credited to the free parts shelf again. Both doors
now take the order's own row lock before they read (``order_fulfilment.lock_orders`` /
``lock_order``), so whichever comes second reads the other's result.

Two real HTTP requests run concurrently on a FILE SQLite database (independent connections —
the ordinary in-memory pool is one connection) and a barrier holds the first one inside its
transaction, behind its locks, while the second starts. SQLite's write lock is what serializes
here; the PostgreSQL row locks are the lock protocol's and are proven by its own scenarios.
"""

import asyncio

import pytest

from backend.app.models.project_line import ProjectLine
from backend.app.services import order_fulfilment, part_stock
from backend.tests import conftest as shared_fixtures
from backend.tests.integration.test_order_issue_review_fixes import _fulfil, _lamp_order
from backend.tests.integration.test_orders_api import _completed_print, catalog  # noqa: F401 — the fixture
from backend.tests.integration.test_workshop_archive_rights import _order_of

pytestmark = pytest.mark.integration

# The four doors a print leaves its order by: the order's two commands, the archive editor's
# un-filing and the trash (C1 at each).
ACTIONS = ["remove-archives", "add-archives", "patch", "trash"]


@pytest.fixture
async def test_engine(monkeypatch, tmp_path):
    """A file database: every session its own connection, as in production."""
    monkeypatch.setattr(shared_fixtures, "TEST_DATABASE_URL", f"sqlite+aiosqlite:///{tmp_path / 'exit.db'}")
    generator = shared_fixtures.test_engine.__wrapped__(monkeypatch)
    engine = await anext(generator)
    try:
        yield engine
    finally:
        try:
            await anext(generator)
        except StopAsyncIteration:
            pass


async def _setup(committing_client, db_session, catalog):  # noqa: F811
    order, [line] = await _lamp_order(committing_client, catalog, [1])
    destination, _ = await _lamp_order(committing_client, catalog, [1])
    printed = await _completed_print(db_session, order, catalog["file"].id)
    return order, line, destination, printed


def _exit(committing_client, action, order, destination, archive_id):
    if action == "patch":
        return committing_client.patch(f"/api/v1/archives/{archive_id}", json={"project_id": None})
    if action == "trash":
        return committing_client.delete(f"/api/v1/archives/{archive_id}")
    target = order if action == "remove-archives" else destination
    return committing_client.post(f"/api/v1/projects/{target}/{action}", json={"archive_ids": [archive_id]})


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ACTIONS)
async def test_a_receipt_holding_the_order_makes_the_exit_wait_and_refuse(
    committing_client,
    db_session,
    catalog,
    monkeypatch,
    action,  # noqa: F811
):
    order, line, destination, printed = await _setup(committing_client, db_session, catalog)
    inside, go = asyncio.Event(), asyncio.Event()
    original = order_fulfilment.state

    async def held(db, project):
        answer = await original(db, project)
        if not inside.is_set():  # the receipt's own read, behind its locks
            inside.set()
            await go.wait()
        return answer

    monkeypatch.setattr(order_fulfilment, "state", held)
    receipt = asyncio.create_task(_fulfil(committing_client, order, [{"line_id": line, "receive": 1}]))
    await asyncio.wait_for(inside.wait(), 10)
    leaving = asyncio.create_task(_exit(committing_client, action, order, destination, printed.id))
    await asyncio.sleep(0.5)
    go.set()
    received, left = await asyncio.wait_for(asyncio.gather(receipt, leaving), 30)

    assert received.status_code == 200, received.text
    assert left.status_code == 409, left.text
    assert (await _order_of(db_session, printed.id))[0] == order
    saved = await db_session.get(ProjectLine, line, populate_existing=True)
    assert saved.received == 1
    assert await part_stock.unfiled_credit_net(db_session, printed.id) == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ACTIONS)
async def test_an_exit_holding_the_order_leaves_the_receipt_nothing_to_receive(
    committing_client,
    db_session,
    catalog,
    monkeypatch,
    action,  # noqa: F811
):
    order, line, destination, printed = await _setup(committing_client, db_session, catalog)
    inside, go = asyncio.Event(), asyncio.Event()
    original = order_fulfilment.ensure_prints_can_leave

    async def held(db, project_id, archive_ids):
        await original(db, project_id, archive_ids)
        inside.set()  # the exit's C1, behind its lock
        await go.wait()

    monkeypatch.setattr(order_fulfilment, "ensure_prints_can_leave", held)
    leaving = asyncio.create_task(_exit(committing_client, action, order, destination, printed.id))
    await asyncio.wait_for(inside.wait(), 10)
    receipt = asyncio.create_task(_fulfil(committing_client, order, [{"line_id": line, "receive": 1}]))
    await asyncio.sleep(0.5)
    go.set()
    left, received = await asyncio.wait_for(asyncio.gather(leaving, receipt), 30)

    assert left.status_code == 200, left.text
    assert received.status_code == 409, received.text
    saved = await db_session.get(ProjectLine, line, populate_existing=True)
    assert saved.received == 0
    stored_order = (await _order_of(db_session, printed.id))[0]
    # The trash keeps the link (a restore brings it back); every other exit moved it.
    expected = {"remove-archives": None, "patch": None, "add-archives": destination, "trash": order}[action]
    assert stored_order == expected
