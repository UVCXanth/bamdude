"""Every door that creates work decides on the captured fact -- swap-source-lifecycle spec r4 §8, plan T4.1.

A check of the library or archive row before the copy is a preview, never the decision: the request's swap
fields are decided from the receipt's declaration, after the capture, for the printer the job is for. True mutes
our macros, False keeps exactly what was asked, and an unknown source with an effective request is refused
(409, ``swap_source_unknown``) before anything is published -- the staging is discarded and no row is left. A
default ``execute=True`` with no events asks for nothing, and a printer without swap mode turns a stored
preference into no request at all.
"""

from __future__ import annotations

import hashlib
import json
import time

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.core.config import settings
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.queue_source import QueueSource
from backend.app.schemas.print_queue import PrintQueueItemCreate
from backend.app.services import queue_sources, swap_compatibility as sc
from backend.tests.integration.test_dispatch_without_original import PLATE, a_sliced_file
from backend.tests.integration.test_filament_routing_dispatch import setup_source

pytestmark = pytest.mark.integration

START = ["swap_mode_start"]


@pytest.fixture(autouse=True)
def clean_spool_state():
    queue_sources._reset_state()
    yield
    deadline = time.monotonic() + 10
    while queue_sources.active_captures() and time.monotonic() < deadline:  # pragma: no cover - drain
        time.sleep(0.01)
    queue_sources._reset_state()


@pytest.fixture
def sessions(test_engine, monkeypatch):
    from backend.app.core import database

    factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr(database, "async_session", factory)
    # The dispatcher bound the name at import; a direct Print now opens its sessions through it.
    monkeypatch.setattr("backend.app.services.background_dispatch.async_session", factory)
    return factory


def staged_parts():
    root = queue_sources.staging_root()
    return sorted(root.glob("*.part")) if root.exists() else []


async def a_library(db, tmp_path, *, fact, name="lamp.gcode.3mf") -> LibraryFile:
    """A library row declaring ``fact`` -- unknown is a declared True whose hash no longer matches the bytes."""
    path = a_sliced_file(tmp_path / name)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    row = LibraryFile(
        filename=path.name,
        file_path=str(path),
        file_size=path.stat().st_size,
        file_type="gcode",
        file_hash=digest if fact is not None else "0" * 64,
        swap_compatible=True if fact is None else fact,
    )
    db.add(row)
    await db.commit()
    return row


async def a_swap_printer(db, tmp_path, printer_factory, monkeypatch, *, swap_mode=True):
    _unused, printer, queue, mqtt = await setup_source(db, tmp_path, printer_factory, monkeypatch)
    printer.swap_mode_enabled = swap_mode
    await db.commit()
    settings.archive_dir.mkdir(parents=True, exist_ok=True)
    return printer, queue


async def nothing_was_left(db) -> None:
    assert (await db.execute(select(PrintQueueItem))).scalars().all() == []
    assert (await db.execute(select(QueueSource))).scalars().all() == []
    assert staged_parts() == []


def refused_as_unknown(exc: HTTPException) -> None:
    assert exc.status_code == 409
    assert exc.detail["code"] == sc.UNKNOWN_SOURCE_REASON


# --- one add ---------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("fact", "execute", "events", "swap_mode", "stored"),
    [
        (True, True, START, True, (False, None)),  # baked: ours muted
        (False, True, START, True, (True, START)),  # plain: exactly what was asked
        (None, True, None, True, (False, None)),  # default execute without events asks for nothing
        (None, True, START, False, (False, None)),  # a preference on a printer without swap mode is no request
        (False, False, START, True, (False, None)),  # an opt-out is never raised into a request
    ],
    ids=["baked", "plain", "default-without-events", "inactive-preference", "opt-out"],
)
async def test_queue_add_decides_on_the_captured_fact(
    fact, execute, events, swap_mode, stored, db_session, tmp_path, printer_factory, monkeypatch, sessions
):
    from backend.app.services.queue_add import add_items_to_printer_queue

    printer, queue = await a_swap_printer(db_session, tmp_path, printer_factory, monkeypatch, swap_mode=swap_mode)
    library = await a_library(db_session, tmp_path, fact=fact)

    items, _queue = await add_items_to_printer_queue(
        db_session,
        PrintQueueItemCreate(
            queue_id=queue.id,
            library_file_id=library.id,
            plate_id=PLATE,
            execute_swap_macros=execute,
            swap_macro_events=events,
        ),
        None,
    )

    (item,) = items
    assert (item.execute_swap_macros, json.loads(item.swap_macro_events) if item.swap_macro_events else None) == stored


async def test_queue_add_refuses_an_unknown_source_asked_for_our_macros(
    db_session, tmp_path, printer_factory, monkeypatch, sessions
):
    from backend.app.services.queue_add import add_items_to_printer_queue

    printer, queue = await a_swap_printer(db_session, tmp_path, printer_factory, monkeypatch)
    library = await a_library(db_session, tmp_path, fact=None)

    with pytest.raises(HTTPException) as refused:
        await add_items_to_printer_queue(
            db_session,
            PrintQueueItemCreate(
                queue_id=queue.id,
                library_file_id=library.id,
                plate_id=PLATE,
                quantity=3,
                execute_swap_macros=True,
                swap_macro_events=START,
            ),
            None,
        )

    refused_as_unknown(refused.value)
    await nothing_was_left(db_session)


async def test_next_block_refuses_an_unknown_source_asked_for_our_macros(
    db_session, tmp_path, printer_factory, monkeypatch, sessions
):
    from backend.app.services.queue_add import add_next_block_to_printer_queue

    printer, queue = await a_swap_printer(db_session, tmp_path, printer_factory, monkeypatch)
    library = await a_library(db_session, tmp_path, fact=None)

    with pytest.raises(HTTPException) as refused:
        await add_next_block_to_printer_queue(
            db_session,
            [
                PrintQueueItemCreate(
                    queue_id=queue.id,
                    library_file_id=library.id,
                    plate_id=PLATE,
                    enqueue_position="next",
                    execute_swap_macros=True,
                    swap_macro_events=START,
                )
            ],
            None,
        )

    refused_as_unknown(refused.value)
    await nothing_was_left(db_session)


@pytest.mark.parametrize(("parent_fact", "stored"), [(True, (False, None)), (False, (True, START)), (None, "refused")])
async def test_a_copy_of_a_job_decides_on_the_parents_own_fact(
    parent_fact, stored, db_session, tmp_path, printer_factory, monkeypatch, sessions
):
    from backend.app.services.queue_add import add_items_to_printer_queue

    printer, queue = await a_swap_printer(db_session, tmp_path, printer_factory, monkeypatch)
    # The parent was queued without asking for our macros, so it exists whatever its source declared.
    library = await a_library(db_session, tmp_path, fact=parent_fact)
    (parent,), _queue = await add_items_to_printer_queue(
        db_session,
        PrintQueueItemCreate(queue_id=queue.id, library_file_id=library.id, plate_id=PLATE, swap_macro_events=None),
        None,
    )
    # The library row changing its mind afterwards is not the copy's business: it copies the parent's answer.
    library.swap_compatible = not bool(parent_fact)
    await db_session.commit()

    request = PrintQueueItemCreate(
        queue_id=queue.id,
        source_queue_item_id=parent.id,
        plate_id=PLATE,
        execute_swap_macros=True,
        swap_macro_events=START,
    )
    if stored == "refused":
        with pytest.raises(HTTPException) as refused:
            await add_items_to_printer_queue(db_session, request, None)
        refused_as_unknown(refused.value)
        assert [row.id for row in (await db_session.execute(select(PrintQueueItem))).scalars()] == [parent.id]
        return
    items, _queue = await add_items_to_printer_queue(db_session, request, None)
    copy = next(item for item in items if item.id != parent.id)
    assert (copy.execute_swap_macros, json.loads(copy.swap_macro_events) if copy.swap_macro_events else None) == stored


# --- Print now: one copy dispatched directly, several through the queue ----------------------------------------------


async def test_print_now_hash_change_is_checked_after_capture(
    db_session, tmp_path, printer_factory, monkeypatch, sessions
):
    """The row's hash matched when the request was read; the bytes changed before the copy. The copy decides."""
    from backend.app.services.background_dispatch import BackgroundDispatchService

    printer, queue = await a_swap_printer(db_session, tmp_path, printer_factory, monkeypatch)
    library = await a_library(db_session, tmp_path, fact=True)
    import zipfile

    with zipfile.ZipFile(library.file_path, "a") as edited:  # same name, other bytes
        edited.writestr("Metadata/edited.txt", "changed after the row was hashed")

    with pytest.raises(HTTPException) as refused:
        await BackgroundDispatchService().dispatch_print_library_file(
            file_id=library.id,
            filename=library.filename,
            printer_id=printer.id,
            printer_name=printer.name,
            options={"plate_id": PLATE, "execute_swap_macros": True, "swap_macro_events": START},
            requested_by_user_id=None,
            requested_by_username=None,
        )

    refused_as_unknown(refused.value)
    await nothing_was_left(db_session)


@pytest.mark.parametrize(("fact", "stored"), [(True, (False, [])), (False, (True, START))])
async def test_print_now_direct_decides_the_options_it_dispatches(
    fact, stored, db_session, tmp_path, printer_factory, monkeypatch, sessions
):
    from backend.app.services.background_dispatch import BackgroundDispatchService

    printer, queue = await a_swap_printer(db_session, tmp_path, printer_factory, monkeypatch)
    library = await a_library(db_session, tmp_path, fact=fact)
    service = BackgroundDispatchService()

    await service.dispatch_print_library_file(
        file_id=library.id,
        filename=library.filename,
        printer_id=printer.id,
        printer_name=printer.name,
        options={"plate_id": PLATE, "execute_swap_macros": True, "swap_macro_events": list(START)},
        requested_by_user_id=None,
        requested_by_username=None,
    )

    (job,) = service._queued_jobs
    assert (job.options["execute_swap_macros"], job.options["swap_macro_events"] or []) == (stored[0], stored[1])
    claim = (await db_session.execute(select(PrintQueueItem))).scalar_one()
    assert claim.execute_swap_macros is stored[0]


async def test_failed_batch_policy_leaves_no_items_or_staging(
    db_session, tmp_path, printer_factory, monkeypatch, sessions
):
    from backend.app.services.queue_batch import enqueue_batch_copies

    printer, queue = await a_swap_printer(db_session, tmp_path, printer_factory, monkeypatch)
    library = await a_library(db_session, tmp_path, fact=None)

    with pytest.raises(HTTPException) as refused:
        await enqueue_batch_copies(
            db_session,
            printer_id=printer.id,
            count=3,
            library_file_id=library.id,
            plate_id=PLATE,
            execute_swap_macros=True,
            swap_macro_events=START,
            library_file=library,
        )

    refused_as_unknown(refused.value)
    await nothing_was_left(db_session)


@pytest.mark.parametrize(("fact", "stored"), [(True, False), (False, True)])
async def test_reprint_batch_checks_final_receipt(
    fact, stored, db_session, tmp_path, printer_factory, monkeypatch, sessions
):
    from backend.app.services.queue_batch import enqueue_batch_copies
    from backend.tests.integration.test_dispatch_without_original import an_archive_source

    printer, queue = await a_swap_printer(db_session, tmp_path, printer_factory, monkeypatch)
    archive = await an_archive_source(db_session, tmp_path, printer.id)
    sc.write_archive_fact(archive, fact)
    await db_session.commit()

    items, _batch = await enqueue_batch_copies(
        db_session,
        printer_id=printer.id,
        count=2,
        archive_id=archive.id,
        plate_id=PLATE,
        execute_swap_macros=True,
        swap_macro_events=START,
    )

    assert [item.execute_swap_macros for item in items] == [stored, stored]


async def test_the_print_route_no_longer_strips_the_request_by_the_library_row(
    async_client, db_session, tmp_path, printer_factory, monkeypatch
):
    """The route hands the request to the dispatcher whole; the decision is the copy's, after the capture."""
    from unittest.mock import AsyncMock, patch

    printer, queue = await a_swap_printer(db_session, tmp_path, printer_factory, monkeypatch)
    library = await a_library(db_session, tmp_path, fact=True)
    with (
        patch("backend.app.services.printer_manager.printer_manager.is_connected", return_value=True),
        patch(
            "backend.app.services.background_dispatch.background_dispatch.dispatch_print_library_file",
            new=AsyncMock(return_value={"dispatch_job_id": 1, "dispatch_position": 1}),
        ) as dispatched,
    ):
        response = await async_client.post(
            f"/api/v1/library/files/{library.id}/print?printer_id={printer.id}",
            json={"plate_id": PLATE, "execute_swap_macros": True, "swap_macro_events": START},
        )

    assert response.status_code == 200, response.text
    options = dispatched.await_args.kwargs["options"]
    assert options["execute_swap_macros"] is True and options["swap_macro_events"] == START
