"""Real process deaths at the dispatch's commit boundaries (post-rebuild I04).

A child pytest process runs the real scheduler and runner (device I/O faked, the harness of
``test_dispatch_without_original``) against a SQLite FILE of the parent's temporary
directory, and dies with ``os._exit`` — no ``finally``, no rollback, no cleanup, an open
connection and its WAL left behind — right after a named commit:

* ``linked``: the execution archive is created, stamped ``prepared`` with the dying boot, and
  linked to its queue row, committed; nothing has reached the printer;
* ``sending``: ``sending`` is committed and the start command is about to be published.

The parent then reads what the death left in that file and runs the next owner's recovery
over it, as a process holding the installation's lock under another boot would. Never the
live database: the file lives under pytest's ``tmp_path``.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import Mock

import pytest
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from backend.app.core.database import Base, configure_sqlite_connection, import_all_models
from backend.app.models.archive import PrintArchive
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer_queue import PrinterQueue
from backend.tests.integration.test_dispatch_without_original import (  # noqa: F401 - fixtures
    clean_spool_state,
    sessions,
)

pytestmark = pytest.mark.integration

CRASH_AT = os.environ.get("BAMDUDE_CRASH_AT")
CRASH_DB = os.environ.get("BAMDUDE_CRASH_DB")
DYING_BOOT = "the-boot-that-died"
NEXT_BOOT = "the-boot-after-it"
DIED = 77


def _engine(path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}")
    event.listen(engine.sync_engine, "connect", configure_sqlite_connection)
    return engine


if CRASH_AT:

    @pytest.fixture
    async def test_engine(monkeypatch):
        """The child's database is the parent's file, and it outlives the child's death."""
        engine = _engine(CRASH_DB)
        import_all_models()
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        monkeypatch.setattr(
            "backend.app.core.database.async_session", async_sessionmaker(engine, expire_on_commit=False)
        )
        yield engine


@pytest.mark.skipif(not CRASH_AT, reason="the child half of a crash probe; the parent starts it")
async def test_the_child_runs_a_dispatch_and_dies_at_its_boundary(
    db_session, test_engine, tmp_path, printer_factory, monkeypatch, sessions
):
    import backend.app.services.background_dispatch as bd
    from backend.app.services.farm_startup_guard import farm_startup_guard
    from backend.tests.integration.test_dispatch_attempt_verdicts import a_job_and_its_dispatch, one_tick

    monkeypatch.setattr(farm_startup_guard, "boot_id", lambda: DYING_BOOT)
    _queue_id, _mqtt, _item_id, _service, scheduler, spawned = await a_job_and_its_dispatch(
        db_session, test_engine, tmp_path, printer_factory, monkeypatch
    )

    def die(*_args, **_kwargs):
        sys.stdout.flush()
        os._exit(DIED)

    if CRASH_AT == "linked":
        monkeypatch.setattr(bd, "resolve_dispatch_storage", die)  # the first step after the link commit
    else:
        monkeypatch.setattr(bd.printer_manager, "start_print", die)  # after ``sending`` is committed

    await one_tick(scheduler, spawned)
    pytest.fail("the dispatch ran past its boundary without the death")


def _die_at(boundary: str, db_file: Path) -> subprocess.CompletedProcess:
    root = Path(__file__).resolve().parents[3]
    env = {**os.environ, "BAMDUDE_CRASH_AT": boundary, "BAMDUDE_CRASH_DB": str(db_file)}
    env.pop("PYTEST_XDIST_WORKER", None)
    return subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            f"{Path(__file__).relative_to(root).as_posix()}::test_the_child_runs_a_dispatch_and_dies_at_its_boundary",
            "-q",
            "-p",
            "no:cacheprovider",
            "-p",
            "no:xdist",
            "--timeout=180",
            "--timeout-method=thread",
        ],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        timeout=300,
    )


@pytest.mark.skipif(bool(CRASH_AT), reason="the parent half of a crash probe")
@pytest.mark.parametrize(("boundary", "phase"), [("linked", "prepared"), ("sending", "sending")])
async def test_a_process_killed_at_a_commit_boundary_leaves_what_its_recovery_proves(
    tmp_path, monkeypatch, boundary, phase
):
    from backend.app.core import database
    from backend.app.services import interrupted_dispatch, print_state_recovery_store as store
    from backend.app.services.background_dispatch import background_dispatch
    from backend.app.services.farm_startup_guard import farm_startup_guard
    from backend.app.services.print_scheduler import scheduler
    from backend.app.services.printer_manager import printer_manager
    from backend.tests.unit.services.test_terminal_queue_repair import PrinterState

    db_file = tmp_path / "crash.sqlite"
    run = _die_at(boundary, db_file)
    assert run.returncode == DIED, (run.stdout[-4000:], run.stderr[-4000:])

    engine = _engine(db_file)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with factory() as db:
            item = (await db.scalars(select(PrintQueueItem))).one()
            archive = await db.get(PrintArchive, item.archive_id)
            queue = await db.get(PrinterQueue, item.queue_id)
            # What the death left: the claim and its archive, in the phase of the boundary.
            assert item.status == "printing" and item.dispatch_attempts == 1
            assert archive.status == "printing" and archive.queue_id == queue.id
            assert archive.dispatch_phase == phase and archive.dispatch_boot_id == DYING_BOOT
            printer_id, item_id = queue.printer_id, item.id

        # The next owner: this process holds the lock under another boot; the printer is idle.
        monkeypatch.setattr(database, "async_session", factory)
        monkeypatch.setattr(farm_startup_guard, "boot_id", lambda: NEXT_BOOT)
        monkeypatch.setattr(farm_startup_guard, "allowed", lambda: True)
        state = PrinterState(connected=True, state="IDLE", connection_generation=1)
        monkeypatch.setattr(printer_manager, "peek_status", Mock(return_value=(state, 10.0, False)))
        monkeypatch.setattr(scheduler, "has_dispatch_in_flight", Mock(return_value=False))
        monkeypatch.setattr(background_dispatch, "has_work_for_printer", Mock(return_value=False))

        outcomes = await interrupted_dispatch.recover_interrupted_dispatches(printer_id)

        async with factory() as db:
            item = await db.get(PrintQueueItem, item_id)
            if phase == "prepared":
                # Provably never sent: back in the queue by itself, the spent attempt kept.
                assert outcomes == [interrupted_dispatch.REQUEUED]
                assert item.status == "pending" and item.dispatch_attempts == 1
            else:
                # The start may be on the printer: the operator's, with the close in Info.
                assert outcomes == []
                assert item.status == "printing"
                page = await store.list_issues(db, None)
                issue = next(i for i in page["issues"] if i["kind"] == "item" and i["target_id"] == item_id)
                assert issue["code"] == "interrupted_dispatch"
                assert issue["actions"] == ["close_interrupted_attempt"]
    finally:
        await engine.dispose()
