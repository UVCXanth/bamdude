"""A print in the trash is not filed under an order (WS-13 E13 V08, Codex round 3).

A trashed archive covers no order — the order's figures and its print list read live
archives only — yet filing one took its parts off the free shelf: 200, the shelf lost what
the print had put there, and the order gained nothing. Filing is refused for such a print
under the print's own lock, before any print, shelf or journal row moves; a batch with one
trashed print moves nothing; a restore comes first, and filing after it takes the free
credit back exactly once. The archive editor's binding is the same door and refuses too.
"""

import pytest
from sqlalchemy import func, select

from backend.app.models.archive import PrintArchive
from backend.app.models.project import ProjectEvent
from backend.app.services import part_stock
from backend.tests.integration.test_order_issue_review_fixes import _lamp_order
from backend.tests.integration.test_orders_api import _completed_print, catalog  # noqa: F401 — the fixture

pytestmark = pytest.mark.integration


async def _credited_print(db, catalog):  # noqa: F811
    """A finished print filed under no order, its parts counted onto the free shelf."""
    printed = await _completed_print(db, None, catalog["file"].id)
    await part_stock.credit_unfiled_print(db, printed)
    await db.commit()
    return printed.id


async def _shelf(db, catalog):  # noqa: F811
    return await part_stock.balances(db, catalog["product"].id)


async def _filed_events(db, order_id: int) -> int:
    return int(
        await db.scalar(
            select(func.count())
            .select_from(ProjectEvent)
            .where(ProjectEvent.project_id == order_id, ProjectEvent.kind == "prints_filed")
        )
        or 0
    )


async def _binding(db, archive_id: int):
    archive = await db.get(PrintArchive, archive_id, populate_existing=True)
    return archive.project_id, archive.project_line_id


def _refused(response) -> None:
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["error"] == "print_in_trash", response.text


@pytest.mark.asyncio
async def test_a_trashed_print_is_not_filed_and_the_shelf_keeps_its_parts(
    committing_client,
    db_session,
    catalog,  # noqa: F811
):
    order, _ = await _lamp_order(committing_client, catalog, [1])
    printed = await _credited_print(db_session, catalog)
    before = await _shelf(db_session, catalog)
    assert sum(before.values()) == 3, before
    trashed = await committing_client.delete(f"/api/v1/archives/{printed}")
    assert trashed.status_code == 200, trashed.text

    _refused(await committing_client.post(f"/api/v1/projects/{order}/add-archives", json={"archive_ids": [printed]}))

    assert await _shelf(db_session, catalog) == before
    assert await _binding(db_session, printed) == (None, None)
    assert await _filed_events(db_session, order) == 0


@pytest.mark.asyncio
async def test_a_batch_with_one_trashed_print_moves_none_of_them(committing_client, db_session, catalog):  # noqa: F811
    order, _ = await _lamp_order(committing_client, catalog, [1])
    live = await _credited_print(db_session, catalog)
    gone = await _credited_print(db_session, catalog)
    before = await _shelf(db_session, catalog)
    assert sum(before.values()) == 6, before
    assert (await committing_client.delete(f"/api/v1/archives/{gone}")).status_code == 200

    answered = await committing_client.post(
        f"/api/v1/projects/{order}/add-archives", json={"archive_ids": [live, gone]}
    )

    _refused(answered)
    assert await _shelf(db_session, catalog) == before
    assert await _binding(db_session, live) == (None, None)
    assert await _binding(db_session, gone) == (None, None)
    assert await _filed_events(db_session, order) == 0


@pytest.mark.asyncio
async def test_the_archive_editor_does_not_file_a_trashed_print_either(
    committing_client,
    db_session,
    catalog,  # noqa: F811
):
    order, _ = await _lamp_order(committing_client, catalog, [1])
    printed = await _credited_print(db_session, catalog)
    before = await _shelf(db_session, catalog)
    assert (await committing_client.delete(f"/api/v1/archives/{printed}")).status_code == 200

    _refused(await committing_client.patch(f"/api/v1/archives/{printed}", json={"project_id": order}))

    assert await _shelf(db_session, catalog) == before
    assert await _binding(db_session, printed) == (None, None)


@pytest.mark.asyncio
async def test_after_a_restore_filing_takes_the_free_credit_back_once(
    committing_client,
    db_session,
    catalog,  # noqa: F811
):
    order, _ = await _lamp_order(committing_client, catalog, [1])
    printed = await _credited_print(db_session, catalog)
    assert (await committing_client.delete(f"/api/v1/archives/{printed}")).status_code == 200
    restored = await committing_client.post(f"/api/v1/archives/trash/{printed}/restore")
    assert restored.status_code == 200, restored.text

    for _ in range(2):
        filed = await committing_client.post(f"/api/v1/projects/{order}/add-archives", json={"archive_ids": [printed]})
        assert filed.status_code == 200, filed.text

    assert sum((await _shelf(db_session, catalog)).values()) == 0
    assert await part_stock.unfiled_credit_net(db_session, printed) == 0
    assert (await _binding(db_session, printed))[0] == order
