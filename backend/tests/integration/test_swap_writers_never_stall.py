"""A declaration, a refresh of selected jobs and a change_table claim never hold each other (plan T9.4).

On PostgreSQL the map is plain: a declaration takes the archive's guard; a refresh and a claim take their lanes,
then the archive's. SQLite adds one lock the map does not name -- its single writer -- and an in-process lock waited
for while that writer is held is a stall: a declaration holding the archive's in-process lock waits for the writer,
the other waits for that lock, until SQLite's busy timeout fails one of them fifteen seconds later. So every writer
here takes its in-process locks -- lanes ascending, then the archive's -- before the database's.

Two independent sessions on a file database; each side is held at a named point while the other starts.
"""

from __future__ import annotations

import asyncio
import uuid

import pytest

from backend.app.models.archive import PrintArchive
from backend.app.services import swap_job_refresh as jobs, swap_source_declarations as decl, swap_terminal
from backend.tests.integration.test_swap_declaration_service import (  # noqa: F401 -- fixtures
    ALL,
    a_3mf,
    a_user,
    actor_of,
    an_archive,
    clean_spool_state,
    declare,
    factory,
)
from backend.tests.integration.test_swap_job_refresh import QUEUE_ALL, a_job, a_printer_queue, by_id, ref

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]

#: Well under SQLite's 15 s busy timeout: a stall shows up as this wait running out, not as a slow pass.
DONE_WITHIN = 8


async def a_declared_source(factory, tmp_path):
    user = await a_user(factory)
    queue_id = await a_printer_queue(factory)
    path = tmp_path / "plate.gcode.3mf"
    a_3mf(path, "plate")
    archive_id = await an_archive(factory, path, owner=user)
    job_id = await a_job(factory, archive_id, queue_id=queue_id)
    seen = await decl.inspect("archive", archive_id, actor=actor_of(user), rights=ALL)
    await declare("archive", archive_id, seen, user, value=True)
    return user, queue_id, archive_id, job_id


async def test_a_declaration_and_a_refresh_of_the_same_source_never_stall(factory, tmp_path, monkeypatch):
    user, _queue_id, archive_id, job_id = await a_declared_source(factory, tmp_path)
    listing = await jobs.candidates("archive", archive_id, actor=actor_of(user), rights=ALL, job_rights=QUEUE_ALL)
    again = await decl.inspect("archive", archive_id, actor=actor_of(user), rights=ALL)  # the next declaration's

    refresh_holds, release_refresh = asyncio.Event(), asyncio.Event()
    real_lock_source = jobs._lock_source

    async def lock_source_when_released(*args, **kwargs):  # the refresh holds its lanes and SQLite's writer
        refresh_holds.set()
        await release_refresh.wait()
        return await real_lock_source(*args, **kwargs)

    monkeypatch.setattr(jobs, "_lock_source", lock_source_when_released)
    refreshing = asyncio.create_task(
        jobs.refresh(
            "archive",
            archive_id,
            declaration_id=listing["declaration_id"],
            source_revision=listing["source_revision"],
            jobs=[ref(by_id(listing, "queue", job_id))],
            operation_id=str(uuid.uuid4()),
            actor=actor_of(user),
            rights=ALL,
            job_rights=QUEUE_ALL,
        )
    )
    await asyncio.wait_for(refresh_holds.wait(), DONE_WITHIN)
    declaring = asyncio.create_task(declare("archive", archive_id, again, user, value=False))
    await asyncio.sleep(0.5)  # the declaration reaches its own locks
    release_refresh.set()

    done = await asyncio.wait_for(refreshing, DONE_WITHIN)
    redeclared = await asyncio.wait_for(declaring, DONE_WITHIN)

    assert done["refreshed"] == [{"kind": "queue", "id": job_id}]
    assert redeclared["value"] is False  # it waited for the refresh, then declared over the same bytes


async def test_a_declaration_and_a_change_table_claim_on_the_same_archive_never_stall(factory, tmp_path, monkeypatch):
    user, queue_id, archive_id, _job_id = await a_declared_source(factory, tmp_path)
    again = await decl.inspect("archive", archive_id, actor=actor_of(user), rights=ALL)
    async with factory() as db:  # this archive's own run still owes its table change
        archive = await db.get(PrintArchive, archive_id)
        archive.extra_data = {**(archive.extra_data or {}), "swap_macro_events_pending": ["swap_mode_change_table"]}
        await db.commit()

    claim_holds, release_claim = asyncio.Event(), asyncio.Event()

    # Held once the lane and SQLite's writer are taken, before the archive's database guard -- in front of the
    # archive's whole write scope where the claim enters one after its lane, at the guard where it takes the
    # in-process locks first.
    if hasattr(swap_terminal, "archive_db_guard"):
        real_guard = swap_terminal.archive_db_guard

        async def guard_when_released(*args, **kwargs):
            claim_holds.set()
            await release_claim.wait()
            return await real_guard(*args, **kwargs)

        monkeypatch.setattr(swap_terminal, "archive_db_guard", guard_when_released)
    else:
        from contextlib import asynccontextmanager

        real_scope = swap_terminal.archive_write_scope

        @asynccontextmanager
        async def scope_when_released(*args, **kwargs):
            claim_holds.set()
            await release_claim.wait()
            async with real_scope(*args, **kwargs):
                yield

        monkeypatch.setattr(swap_terminal, "archive_write_scope", scope_when_released)
    claiming = asyncio.create_task(
        swap_terminal.claim_change_table(factory, archive_id, queue_id=queue_id, owner="test", allow_absent=True)
    )
    await asyncio.wait_for(claim_holds.wait(), DONE_WITHIN)
    declaring = asyncio.create_task(declare("archive", archive_id, again, user, value=False))
    await asyncio.sleep(0.5)
    release_claim.set()

    try:
        claimed = await asyncio.wait_for(claiming, DONE_WITHIN)
        redeclared = await asyncio.wait_for(declaring, DONE_WITHIN)
    finally:
        swap_terminal._sending.discard(archive_id)

    assert claimed == swap_terminal.CLAIMED
    assert redeclared["value"] is False


async def test_every_in_process_lock_is_held_before_sqlites_writer(factory):
    from backend.app.services.archive_write_scope import archive_process_lock
    from backend.app.services.queue_ops import _queue_claim_locks, claim_lanes

    held_at_begin: list[tuple[bool, bool, bool]] = []
    async with factory() as db:
        real_execute = db.execute

        async def watched(statement, *args, **kwargs):
            if "BEGIN IMMEDIATE" in str(statement):
                held_at_begin.append(
                    (_queue_claim_locks[3].locked(), _queue_claim_locks[7].locked(), archive_process_lock(5).locked())
                )
            return await real_execute(statement, *args, **kwargs)

        db.execute = watched
        async with claim_lanes(db, [7, 3, 7], archive_id=5):
            pass

    assert held_at_begin == [(True, True, True)]
