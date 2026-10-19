"""A declaration, a refresh of selected jobs and a change_table claim never hold each other (plan T9.4).

On PostgreSQL the map is plain: a declaration takes the archive's guard; a refresh and a claim take their lanes,
then the archive's. SQLite adds one lock the map does not name -- its single writer -- and an in-process lock waited
for while that writer is held is a stall: a declaration holding the archive's in-process lock waits for the writer,
the other waits for that lock, until SQLite's busy timeout fails one of them fifteen seconds later. So every writer
here takes its in-process locks before the database's -- and in ONE order shared with every writer that needs an
archive and a lane (spec r4 §4, T9.7 R4): the archives first, then the lanes, in process and in PostgreSQL's guards
alike, as operator print-state recovery and the terminal autorepair take them.

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

    # Held once every lock of the claim is taken -- the archive's and the lane's in-process locks, SQLite's writer --
    # at its read of the archive row: a declaration of the same archive then waits for the archive's in-process
    # lock, never holding the writer the claim needs.
    real_load = swap_terminal.load_active_archive_for_write

    async def load_when_released(*args, **kwargs):
        claim_holds.set()
        await release_claim.wait()
        return await real_load(*args, **kwargs)

    monkeypatch.setattr(swap_terminal, "load_active_archive_for_write", load_when_released)
    claiming = asyncio.create_task(
        swap_terminal.claim_change_table(factory, archive_id, queue_id=queue_id, owner="test", allow_absent=True)
    )
    declaring = None
    try:
        await asyncio.wait_for(claim_holds.wait(), DONE_WITHIN)
        declaring = asyncio.create_task(declare("archive", archive_id, again, user, value=False))
        await asyncio.sleep(0.5)
        release_claim.set()
        claimed = await asyncio.wait_for(claiming, DONE_WITHIN)
        redeclared = await asyncio.wait_for(declaring, DONE_WITHIN)
    finally:
        release_claim.set()
        for task in (claiming, declaring):
            if task is not None and not task.done():
                task.cancel()
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


class _PgSession:
    """A PostgreSQL-dialect stand-in: no SQL runs, the guards it is asked for are recorded in order."""

    def __init__(self):
        self.guards: list[tuple[int, int]] = []

    def get_bind(self):
        class Bind:
            class dialect:
                name = "postgresql"

        return Bind()

    def in_transaction(self):
        return True

    async def execute(self, statement, params=None):
        text = str(statement)
        for namespace in (182, 1625):
            if f"pg_advisory_xact_lock({namespace}," in text:
                self.guards.append((namespace, next(iter((params or {}).values()))))


async def test_an_archive_then_lane_writer_and_claim_lanes_never_hold_half_of_each_others_pair(monkeypatch):
    """Codex's T9-A-R4 probe: a writer that takes an archive and then a lane -- operator print-state recovery's order
    -- and ``claim_lanes`` over the same archive and lane. Each in its own order, each would hold one of the pair and
    wait for the other forever."""
    from backend.app.services import archive_write_scope as archives, queue_ops

    archives._archive_locks.clear()
    queue_ops._queue_claim_locks.clear()
    archive_owned, claim_started = asyncio.Event(), asyncio.Event()
    real_process_lock = archives.archive_process_lock

    def announce(archive_id):  # claim_lanes has begun taking its in-process locks
        claim_started.set()
        return real_process_lock(archive_id)

    monkeypatch.setattr(archives, "archive_process_lock", announce)

    async def archive_then_lane():
        async with archives.archive_write_scope(_PgSession(), 77):
            archive_owned.set()
            await claim_started.wait()
            await asyncio.sleep(0)  # let the claim take whatever it takes before the archive
            async with queue_ops.queue_claim_scope(_PgSession(), 88):
                pass

    async def claim():
        await archive_owned.wait()
        async with queue_ops.claim_lanes(_PgSession(), [88], archive_id=77):
            pass

    await asyncio.wait_for(asyncio.gather(archive_then_lane(), claim()), timeout=DONE_WITHIN)


async def test_postgresql_guards_come_archives_first_then_lanes_each_ascending():
    from backend.app.services.queue_ops import claim_lanes

    session = _PgSession()
    async with claim_lanes(session, [88, 87, 88], archive_ids=[5, 3], archive_id=4):
        pass
    assert session.guards == [(182, 3), (182, 4), (182, 5), (1625, 87), (1625, 88)]


async def test_a_lane_lock_contended_in_an_earlier_event_loop():
    """With no ``factory``: a lane's in-process lock waited for in THIS test's event loop is bound to it (asyncio
    binds a lock to the loop of its first waiter), and stays in the module's registry after the test."""
    from backend.app.services import queue_ops

    lock = queue_ops._queue_claim_locks[1]
    await lock.acquire()
    waiter = asyncio.ensure_future(lock.acquire())
    await asyncio.sleep(0)
    lock.release()
    await waiter
    lock.release()


async def test_a_test_on_the_factory_never_meets_a_lane_lock_of_another_event_loop(factory):
    """Every test on ``factory`` starts with fresh in-process locks: a lane lock left bound to the previous test's
    loop would make the first wait in this one a RuntimeError, not a wait."""
    from backend.app.services.queue_ops import claim_lanes

    async def claim(hold: float):
        async with factory() as db, claim_lanes(db, [1]):
            await asyncio.sleep(hold)

    await asyncio.wait_for(asyncio.gather(claim(0.2), claim(0)), DONE_WITHIN)
