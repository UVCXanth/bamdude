"""The execution archive records the job's own declaration -- swap-source-lifecycle spec r4 §3, §7; plan T3.

``archive_print`` guesses nothing: both runners hand it the fact the job captured, and the archive writes it as
its record (``extra_data["swap_source"]``) with the bool column as its projection. The library row the job came
from may be renamed or re-declared afterwards; the print that ran keeps what it ran with, and a reprint of that
archive carries it on -- an unknown included, through any number of reprints.
"""

from __future__ import annotations

import hashlib
import time
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.core.config import settings
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer_queue import PrinterQueue
from backend.app.schemas.print_queue import PrintQueueItemCreate
from backend.app.services import queue_sources, swap_compatibility as sc
from backend.tests.integration.test_dispatch_without_original import (
    PLATE,
    a_sliced_file,
    an_archive_source,
    dispatch_mocks,
    drain,
    scheduler_with_captured_dispatch,
)
from backend.tests.integration.test_filament_routing_dispatch import setup_source

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def clean_state():
    from backend.app.services.printer_manager import printer_manager

    def clear():
        queue_sources._reset_state()
        for attribute in (
            "_print_run_bindings",
            "_print_run_finishing_bindings",
            "_print_start_resolutions",
            "_pending_print_terminals",
        ):
            registry = getattr(printer_manager, attribute, None)
            if isinstance(registry, dict):
                registry.clear()

    clear()
    yield clear
    deadline = time.monotonic() + 10
    while queue_sources.active_captures() and time.monotonic() < deadline:  # pragma: no cover - drain
        time.sleep(0.01)
    clear()


@pytest.fixture
def sessions(test_engine, monkeypatch):
    from backend.app.core import database

    factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr(database, "async_session", factory)
    return factory


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


async def queue_and_dispatch(db, monkeypatch, test_engine, queue, **source) -> PrintArchive:
    """Queue through the real writer (it captures), dispatch through the real scheduler, return the execution."""
    from backend.app.services.queue_add import add_items_to_printer_queue

    items, _queue = await add_items_to_printer_queue(
        db, PrintQueueItemCreate(queue_id=queue.id, plate_id=PLATE, **source), None
    )
    factory = async_sessionmaker(test_engine, expire_on_commit=False)
    dispatch_mocks(monkeypatch, factory)
    scheduler, spawned = scheduler_with_captured_dispatch(monkeypatch)
    assert await scheduler.check_queue() is True
    assert await drain(spawned) == 1
    item = await db.get(PrintQueueItem, items[0].id, populate_existing=True)
    assert item.status == "printing"
    return await db.get(PrintArchive, item.archive_id, populate_existing=True)


async def finish(db, archive: PrintArchive, queue: PrinterQueue, clear) -> None:
    """The print ended: its archive is a completed source, the printer is free again."""
    archive.status = "completed"
    # Re-read: the dispatch wrote these rows from its own sessions, so this session's copies are stale.
    for item in (await db.execute(select(PrintQueueItem).execution_options(populate_existing=True))).scalars():
        item.status = "completed"
    claim = await db.get(PrinterQueue, queue.id, populate_existing=True)
    claim.status, claim.current_item_id = "idle", None
    await db.commit()
    clear()


@pytest.mark.parametrize("declared", [True, False])
async def test_execution_archive_uses_fact_not_linked_library(
    declared, db_session, test_engine, tmp_path, printer_factory, monkeypatch, sessions
):
    _unused, printer, queue, mqtt = await setup_source(db_session, tmp_path, printer_factory, monkeypatch)
    settings.archive_dir.mkdir(parents=True, exist_ok=True)
    path = a_sliced_file(tmp_path / ("lamp.swap.gcode.3mf" if declared else "lamp.gcode.3mf"))
    library = LibraryFile(
        filename=path.name,
        file_path=str(path),
        file_size=path.stat().st_size,
        file_type="gcode",
        file_hash=sha(path),
        swap_compatible=declared,
    )
    db_session.add(library)
    await db_session.commit()
    from backend.app.services.queue_add import add_items_to_printer_queue

    items, _queue = await add_items_to_printer_queue(
        db_session, PrintQueueItemCreate(queue_id=queue.id, library_file_id=library.id, plate_id=PLATE), None
    )
    # After the job was queued the library row changes its mind and its name -- the job captured the old answer.
    library.swap_compatible = not declared
    library.filename = "renamed.swaps.gcode.3mf" if declared is False else "renamed.gcode.3mf"
    await db_session.commit()

    factory = async_sessionmaker(test_engine, expire_on_commit=False)
    dispatch_mocks(monkeypatch, factory)
    scheduler, spawned = scheduler_with_captured_dispatch(monkeypatch)
    assert await scheduler.check_queue() is True
    assert await drain(spawned) == 1

    item = await db_session.get(PrintQueueItem, items[0].id, populate_existing=True)
    execution = await db_session.get(PrintArchive, item.archive_id, populate_existing=True)
    assert execution.library_file_id == library.id  # the link is kept, it is just not the authority
    fact = sc.archive_fact(execution)
    assert fact.recorded is True
    assert fact.value is declared and fact.pending_external is False
    assert execution.swap_compatible is declared


@pytest.mark.parametrize("start", ["legacy False", "recorded True", "recorded False"])
async def test_unknown_survives_reprint_of_reprint(
    start, db_session, test_engine, tmp_path, printer_factory, monkeypatch, sessions, clean_state
):
    _unused, printer, queue, mqtt = await setup_source(db_session, tmp_path, printer_factory, monkeypatch)
    settings.archive_dir.mkdir(parents=True, exist_ok=True)
    first = await an_archive_source(db_session, tmp_path, printer.id, name="shelf.swap.gcode.3mf")
    expected = {"legacy False": None, "recorded True": True, "recorded False": False}[start]
    if start != "legacy False":
        sc.write_archive_fact(first, expected)
        await db_session.commit()

    chain = [first]
    for _hop in range(2):
        execution = await queue_and_dispatch(db_session, monkeypatch, test_engine, queue, archive_id=chain[-1].id)
        fact = sc.archive_fact(execution)
        # Recorded, and the same answer -- never upgraded by the ".swap." in its name, never a legacy False.
        assert fact.recorded is True
        assert fact.value is expected, (start, len(chain))
        chain.append(execution)
        await finish(db_session, execution, queue, clean_state)


async def test_parsed_metadata_cannot_write_the_record(db_session, printer_factory, tmp_path, monkeypatch):
    """A 3MF whose parsed metadata carries the reserved key declares nothing through it."""
    import backend.app.services.archive as archive_module
    from backend.app.services.archive import ArchiveService

    printer = await printer_factory()
    settings.archive_dir.mkdir(parents=True, exist_ok=True)
    path = a_sliced_file(tmp_path / "forged.gcode.3mf")
    real_parse = archive_module.ThreeMFParser.parse

    def forged(self, *args, **kwargs):
        parsed = real_parse(self, *args, **kwargs)
        parsed[sc.CARRIER_KEY] = {"version": 1, "value": True, "pending_external": False}
        return parsed

    monkeypatch.setattr(archive_module.ThreeMFParser, "parse", forged)
    archive = await ArchiveService(db_session).archive_print(
        printer_id=printer.id,
        source_file=path,
        source_content_hash=sha(path),
        print_data={"status": "printing"},
        source_swap_compatible=False,
    )

    assert sc.archive_fact(archive) == sc.ArchiveFact(False, recorded=True)
