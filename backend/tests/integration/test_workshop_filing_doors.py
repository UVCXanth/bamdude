"""Filing a past print — one policy on every door (WS-13 E13 T16, O08/O09/O21).

``F(print)`` = ``orders:file_prints`` (any print) OR ``orders:update`` with the archive's own
update right (own with ``update_own``, any with ``update_all``). A NEW link goes only to an
active order (409 ``order_closed``); a print leaves an order by C1 (409 when the order already
received its output). The archive editor's PATCH keeps the archive's own right for its fields,
and a binding that changes asks ``orders:update`` or ``orders:file_prints`` beside it, an order
that exists and is open, a line of it and C1; ``status`` is a closed set, and a filed print
leaving ``completed`` is C1 too. A line change inside one order is journaled
(``prints_relined``); trashing and restoring a filed print ask ``F`` and are journaled.
"""

import pytest
from sqlalchemy import select

from backend.app.models.project import Project, ProjectEvent
from backend.tests.integration.test_order_issue_review_fixes import LEAVE, _fulfil, _lamp_order
from backend.tests.integration.test_orders_api import _completed_print, catalog  # noqa: F401
from backend.tests.integration.test_workshop_archive_rights import (  # noqa: F401 — the shared fixture
    _add,
    _archive,
    _order_of,
    _remove,
    desk,
)
from backend.tests.integration.test_workshop_library_rights import _jwt, _key, _user

pytestmark = pytest.mark.integration


async def _kinds(db, order_id: int) -> list[str]:
    rows = await db.execute(select(ProjectEvent.kind).where(ProjectEvent.project_id == order_id))
    return [kind for (kind,) in rows]


async def _close(db, order_id: int, status: str) -> None:
    order = await db.get(Project, order_id, populate_existing=True)
    order.status = status
    await db.commit()


class TestTheFilingClerk:
    @pytest.mark.asyncio
    async def test_the_filing_right_alone_files_and_unfiles_any_print(self, committing_client, db_session, desk):
        await _user(db_session, "fd_clerk", ["orders:read", "orders:file_prints"])
        ids = [desk["ownerless"], desk["theirs"]]
        assert (await _add(committing_client, desk["a"], ids, "fd_clerk")).status_code == 200
        assert (await _order_of(db_session, desk["theirs"]))[0] == desk["a"]
        assert (await _remove(committing_client, desk["a"], ids, "fd_clerk")).status_code == 200
        assert await _order_of(db_session, desk["theirs"]) == (None, None)

    @pytest.mark.asyncio
    async def test_a_reader_files_nothing(self, committing_client, db_session, desk):
        await _user(db_session, "fd_reader", ["orders:read", "archives:update_all"])
        r = await _add(committing_client, desk["a"], [desk["theirs"]], "fd_reader")
        assert r.status_code == 403
        assert await _order_of(db_session, desk["theirs"]) == (None, None)

    @pytest.mark.asyncio
    @pytest.mark.parametrize("header", ["x-api-key", "bearer"])
    async def test_a_key_of_a_clerk_files_inside_its_workshop_scope(self, committing_client, db_session, desk, header):
        clerk = await _user(db_session, f"fd_clerk_key_{header}", ["orders:file_prints"])
        raw = await _key(db_session, clerk, can_manage_projects=True, can_manage_archives=False)
        headers = {"X-API-Key": raw} if header == "x-api-key" else {"Authorization": f"Bearer {raw}"}
        r = await committing_client.post(
            f"/api/v1/projects/{desk['a']}/add-archives", json={"archive_ids": [desk["ownerless"]]}, headers=headers
        )
        assert r.status_code == 200, r.text
        assert (await _order_of(db_session, desk["ownerless"]))[0] == desk["a"]


class TestANewLinkGoesToAnOpenOrder:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("status", ["completed", "cancelled"])
    async def test_a_closed_order_takes_no_print(self, committing_client, db_session, desk, status):
        await _close(db_session, desk["b"], status)
        r = await _add(committing_client, desk["b"], [desk["ownerless"]])
        assert r.status_code == 409
        assert r.json()["detail"]["error"] == "order_closed"
        assert await _order_of(db_session, desk["ownerless"]) == (None, None)

    @pytest.mark.asyncio
    async def test_a_print_still_leaves_a_closed_order(self, committing_client, db_session, desk):
        assert (await _add(committing_client, desk["b"], [desk["ownerless"]])).status_code == 200
        await _close(db_session, desk["b"], "cancelled")
        assert (await _remove(committing_client, desk["b"], [desk["ownerless"]])).status_code == 200
        assert await _order_of(db_session, desk["ownerless"]) == (None, None)


class TestALineChangeIsJournaled:
    @pytest.mark.asyncio
    async def test_moving_a_print_to_another_line_of_its_order_writes_the_journal(
        self, committing_client, db_session, desk
    ):
        first, second = desk["lines_a"]
        assert (await _add(committing_client, desk["a"], [desk["theirs"]], project_line_id=first)).status_code == 200
        before = await _kinds(db_session, desk["a"])
        moved = await _add(committing_client, desk["a"], [desk["theirs"]], project_line_id=second)
        assert moved.status_code == 200, moved.text
        assert await _order_of(db_session, desk["theirs"]) == (desk["a"], second)
        after = await _kinds(db_session, desk["a"])
        assert after.count("prints_relined") == before.count("prints_relined") + 1
        assert after.count("prints_filed") == before.count("prints_filed")

    @pytest.mark.asyncio
    async def test_the_editor_journals_a_line_change_too(self, committing_client, db_session, desk):
        first, second = desk["lines_a"]
        assert (await _add(committing_client, desk["a"], [desk["theirs"]], project_line_id=first)).status_code == 200
        r = await committing_client.patch(f"/api/v1/archives/{desk['theirs']}", json={"project_line_id": second})
        assert r.status_code == 200, r.text
        assert "prints_relined" in await _kinds(db_session, desk["a"])


class TestTheArchiveEditorsBinding:
    @pytest.mark.asyncio
    async def test_the_filing_right_beside_the_archives_own_moves_the_binding(
        self, committing_client, db_session, desk
    ):
        await _user(db_session, "fd_own_filer", ["archives:update_all", "orders:file_prints"])
        r = await committing_client.patch(
            f"/api/v1/archives/{desk['theirs']}", json={"project_id": desk["a"]}, headers=_jwt("fd_own_filer")
        )
        assert r.status_code == 200, r.text
        assert (await _order_of(db_session, desk["theirs"]))[0] == desk["a"]

    @pytest.mark.asyncio
    async def test_a_binding_to_an_order_that_is_not_there_is_404(self, committing_client, db_session, desk):
        r = await committing_client.patch(f"/api/v1/archives/{desk['ownerless']}", json={"project_id": 999999})
        assert r.status_code == 404
        assert await _order_of(db_session, desk["ownerless"]) == (None, None)

    @pytest.mark.asyncio
    async def test_a_binding_to_a_closed_order_is_refused(self, committing_client, db_session, desk):
        await _close(db_session, desk["b"], "cancelled")
        r = await committing_client.patch(f"/api/v1/archives/{desk['ownerless']}", json={"project_id": desk["b"]})
        assert r.status_code == 409
        assert r.json()["detail"]["error"] == "order_closed"
        assert await _order_of(db_session, desk["ownerless"]) == (None, None)

    @pytest.mark.asyncio
    async def test_a_line_change_inside_a_closed_order_is_refused(self, committing_client, db_session, desk):
        first, second = desk["lines_a"]
        assert (await _add(committing_client, desk["a"], [desk["theirs"]], project_line_id=first)).status_code == 200
        await _close(db_session, desk["a"], "completed")
        r = await committing_client.patch(f"/api/v1/archives/{desk['theirs']}", json={"project_line_id": second})
        assert r.status_code == 409
        assert await _order_of(db_session, desk["theirs"]) == (desk["a"], first)

    @pytest.mark.asyncio
    @pytest.mark.parametrize("status", ["teleported", None])
    async def test_a_status_outside_the_closed_set_is_refused(self, committing_client, desk, status):
        r = await committing_client.patch(f"/api/v1/archives/{desk['ownerless']}", json={"status": status})
        assert r.status_code == 422

    @pytest.mark.asyncio
    async def test_a_received_print_does_not_leave_completed(self, committing_client, db_session, catalog):  # noqa: F811
        order, [line] = await _lamp_order(committing_client, catalog, [1])
        received = await _completed_print(db_session, order, catalog["file"].id)
        assert (await _fulfil(committing_client, order, [{"line_id": line, "receive": 1}])).status_code == 200
        r = await committing_client.patch(f"/api/v1/archives/{received.id}", json={"status": "failed"})
        assert (r.status_code, r.json()["detail"]) == (409, LEAVE)

    @pytest.mark.asyncio
    async def test_a_spare_print_may_leave_completed(self, committing_client, db_session, catalog):  # noqa: F811
        order, _ = await _lamp_order(committing_client, catalog, [1])
        spare = await _completed_print(db_session, order, catalog["file"].id)
        r = await committing_client.patch(f"/api/v1/archives/{spare.id}", json={"status": "failed"})
        assert r.status_code == 200, r.text


class TestTheTrash:
    @pytest.mark.asyncio
    async def test_trashing_a_filed_print_asks_the_filing_right_and_is_journaled(
        self, committing_client, db_session, desk
    ):
        assert (await _add(committing_client, desk["a"], [desk["theirs"]])).status_code == 200
        await _user(db_session, "fd_deleter", ["archives:delete_all"])
        await _user(db_session, "fd_deleter_filer", ["archives:delete_all", "orders:file_prints"])
        url = f"/api/v1/archives/{desk['theirs']}"
        assert (await committing_client.delete(url, headers=_jwt("fd_deleter"))).status_code == 403
        assert (await committing_client.delete(url, headers=_jwt("fd_deleter_filer"))).status_code == 200
        assert "print_trashed" in await _kinds(db_session, desk["a"])
        restore = f"/api/v1/archives/trash/{desk['theirs']}/restore"
        assert (await committing_client.post(restore, headers=_jwt("fd_deleter"))).status_code == 403
        restored = await committing_client.post(restore, headers=_jwt("fd_deleter_filer"))
        assert restored.status_code == 200, restored.text
        assert "print_restored" in await _kinds(db_session, desk["a"])

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("rights", "expected"),
        [
            (["orders:update", "archives:update_own", "archives:delete_own"], 200),
            (["archives:update_own", "archives:delete_own"], 403),
        ],
    )
    async def test_the_owner_trashes_an_own_filed_print_with_the_orders_right(
        self, committing_client, db_session, desk, rights, expected
    ):
        owner = await _user(db_session, f"fd_own_deleter_{expected}", rights)
        own = await _archive(db_session, owner=owner)
        assert (await _add(committing_client, desk["a"], [own.id])).status_code == 200
        r = await committing_client.delete(f"/api/v1/archives/{own.id}", headers=_jwt(f"fd_own_deleter_{expected}"))
        assert r.status_code == expected, r.text

    @pytest.mark.asyncio
    async def test_an_unfiled_print_is_trashed_as_before(self, committing_client, db_session, desk):
        await _user(db_session, "fd_plain_deleter", ["archives:delete_all"])
        r = await committing_client.delete(f"/api/v1/archives/{desk['ownerless']}", headers=_jwt("fd_plain_deleter"))
        assert r.status_code == 200, r.text

    @pytest.mark.asyncio
    async def test_a_received_print_is_not_trashed(self, committing_client, db_session, catalog):  # noqa: F811
        order, [line] = await _lamp_order(committing_client, catalog, [1])
        received = await _completed_print(db_session, order, catalog["file"].id)
        assert (await _fulfil(committing_client, order, [{"line_id": line, "receive": 1}])).status_code == 200
        r = await committing_client.delete(f"/api/v1/archives/{received.id}")
        assert (r.status_code, r.json()["detail"]) == (409, LEAVE)


class TestCountingAnOldPrintIntoStock:
    @pytest.mark.asyncio
    async def test_it_needs_the_archive_to_be_visible(self, committing_client, db_session, desk):
        counter = await _user(db_session, "fd_counter", ["stock:adjust", "archives:read_own"])
        await _user(db_session, "fd_blind_counter", ["stock:adjust"])
        own = await _archive(db_session, owner=counter)
        url = "/api/v1/archives/{}/count-into-stock"
        assert (await committing_client.post(url.format(own.id), headers=_jwt("fd_counter"))).status_code == 200
        assert (await committing_client.post(url.format(desk["theirs"]), headers=_jwt("fd_counter"))).status_code == 404
        blind = await committing_client.post(url.format(desk["theirs"]), headers=_jwt("fd_blind_counter"))
        assert blind.status_code == 404
