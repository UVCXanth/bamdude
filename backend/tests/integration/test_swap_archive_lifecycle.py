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
from backend.tests.integration.test_adopt_print_started_while_down import _clean_module_state, main_db  # noqa: F401
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


# --- the name a download really succeeded under (§7: FTP multi-path) -----------------------------------------------


class FakeFTPClient:
    """``BambuFTPClient`` over a set of remote paths that exist; counts the sessions it opened."""

    present: set[str] = set()
    sessions = 0

    def __init__(self, *args, **kwargs):
        pass

    def connect(self):
        FakeFTPClient.sessions += 1
        return True

    def download_to_file(self, remote_path, local_path):
        from backend.app.services.bambu_ftp import FileNotOnPrinterError

        if remote_path not in FakeFTPClient.present:
            raise FileNotOnPrinterError(remote_path)
        Path(local_path).write_bytes(b"PK")
        return True

    def disconnect(self):
        pass


@pytest.fixture
def fake_ftp(monkeypatch):
    import backend.app.services.archive_download  # noqa: F401 - bound to the real client before the patch
    import backend.app.services.bambu_ftp as bambu_ftp

    FakeFTPClient.present, FakeFTPClient.sessions = set(), 0
    monkeypatch.setattr(bambu_ftp, "BambuFTPClient", FakeFTPClient)
    return FakeFTPClient


async def test_ftp_bool_wrapper_keeps_old_contract_and_one_session(fake_ftp, tmp_path):
    import asyncio

    from backend.app.services.bambu_ftp import download_file_first_path_async, download_file_try_paths_async

    paths = ["/a.3mf", "/cache/b.3mf", "/model/c.3mf"]
    fake_ftp.present = {"/cache/b.3mf", "/model/c.3mf"}
    # The new answer is the path that worked -- the first that exists, not the first that was asked.
    found = await asyncio.wait_for(download_file_first_path_async("10.0.0.9", "x", paths, tmp_path / "t"), 5)
    assert found == "/cache/b.3mf"
    assert fake_ftp.sessions == 1
    # The old bool contract, on ONE session and ONE serialization: a second lock on the same printer would hang.
    assert await asyncio.wait_for(download_file_try_paths_async("10.0.0.9", "x", paths, tmp_path / "t"), 5) is True
    assert fake_ftp.sessions == 2
    fake_ftp.present = set()
    assert await asyncio.wait_for(download_file_try_paths_async("10.0.0.9", "x", paths, tmp_path / "t"), 5) is False
    assert await download_file_first_path_async("10.0.0.9", "x", paths, tmp_path / "t") is None


def _printer_for_download():
    from unittest.mock import MagicMock

    return MagicMock(id=7, ip_address="10.0.0.9", access_code="12345678", model="X1C", name="X1C")


@pytest.mark.parametrize(
    ("subtask", "filename", "present", "listing", "expected"),
    [
        # The marked candidate is asked first and is not there; the plain one is -- the file is the plain one.
        ("lamp.swap", "/data/Metadata/plate_1.gcode", {"/plate_1.gcode.3mf"}, [], "plate_1.gcode.3mf"),
        # The reverse: a plain first candidate is missing, the marked one downloaded.
        ("lamp", "/sdcard/lamp.swap.gcode.3mf", {"/cache/lamp.swap.gcode.3mf"}, [], "lamp.swap.gcode.3mf"),
        # Fuzzy: the first listed match does not download, the second does.
        (
            "lamp",
            None,
            {"/cache/lamp_v2.swap.3mf"},
            [{"name": "lamp_v1.3mf"}, {"name": "lamp_v2.swap.3mf"}],
            "lamp_v2.swap.3mf",
        ),
    ],
    ids=["direct-marked-missing", "direct-plain-missing", "fuzzy-second"],
)
async def test_external_pending_uses_successful_download_basename(
    subtask, filename, present, listing, expected, fake_ftp, tmp_path, monkeypatch
):
    from unittest.mock import AsyncMock

    from backend.app.services import archive_download

    fake_ftp.present = present

    async def listed(ip, code, directory, **kwargs):
        return [entry for entry in listing if directory == "/cache"] if listing else []

    monkeypatch.setattr(archive_download, "list_files_async", listed)
    monkeypatch.setattr(archive_download, "_try_internal_storage", AsyncMock(return_value=None))
    monkeypatch.setattr(archive_download, "get_ftp_retry_settings", AsyncMock(return_value=(False, 0, 0, 30)))

    result = await archive_download.try_download_3mf(_printer_for_download(), subtask, filename, tmp_path)

    assert result is not None
    _temp_path, received = result
    assert received == expected
    assert sc.classify_external_name(received) is (".swap." in expected)


async def test_internal_storage_names_the_entry_it_read(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from backend.app.services import archive_download

    entries = [SimpleNamespace(name="lamp.swap.gcode.3mf", path="/lamp.swap.gcode.3mf")]
    transport = SimpleNamespace(list_files=AsyncMock(return_value=entries), read_bytes=AsyncMock(return_value=b"PK"))
    monkeypatch.setattr(
        "backend.app.utils.printer_storage.storage_capability_for", lambda *a: {"can_browse_internal": True}
    )
    monkeypatch.setattr("backend.app.services.printer_files.factory.transport_for", lambda *a: transport)

    result = await archive_download._try_internal_storage(
        _printer_for_download(), ["lamp.gcode.3mf", "lamp.swap.gcode.3mf"], tmp_path
    )

    assert result is not None and result[1] == "lamp.swap.gcode.3mf"


# --- external start, attach, adopt (§7) -----------------------------------------------------------------------------


async def an_external_row(db, printer_id, *, fact, pending=False, legacy_column=None, filename="lamp.gcode.3mf"):
    archive = PrintArchive(
        printer_id=printer_id,
        filename=filename,
        file_path="",
        file_size=0,
        print_name="lamp",
        status="printing",
        extra_data={"original_subtask": "lamp"},
    )
    if legacy_column is None:
        sc.write_archive_fact(archive, fact, pending_external=pending)
    else:
        archive.swap_compatible = legacy_column
    db.add(archive)
    await db.commit()
    return archive


async def attach(db, archive, received_name, tmp_path):
    from backend.app.services.archive import ArchiveService

    (tmp_path / "download").mkdir(parents=True, exist_ok=True)
    downloaded = a_sliced_file(tmp_path / "download" / (received_name or "x.gcode.3mf"))
    settings.archive_dir.mkdir(parents=True, exist_ok=True)
    assert await ArchiveService(db).attach_3mf_to_archive(
        archive.id, downloaded, received_name, received_name=received_name
    )
    return await db.get(PrintArchive, archive.id, populate_existing=True)


@pytest.mark.parametrize(("received", "expected"), [("lamp.swap.gcode.3mf", True), ("lamp.gcode.3mf", False)])
async def test_attach_finishes_only_a_pending_external_record(
    received, expected, db_session, printer_factory, tmp_path
):
    printer = await printer_factory()
    pending = await an_external_row(db_session, printer.id, fact=None, pending=True)

    attached = await attach(db_session, pending, received, tmp_path)

    assert sc.archive_fact(attached) == sc.ArchiveFact(expected, recorded=True)


async def test_attach_without_a_proven_name_leaves_pending_unknown(db_session, printer_factory, tmp_path):
    from backend.app.services.archive import ArchiveService

    printer = await printer_factory()
    pending = await an_external_row(db_session, printer.id, fact=None, pending=True)
    downloaded = a_sliced_file(tmp_path / "x.swap.gcode.3mf")
    settings.archive_dir.mkdir(parents=True, exist_ok=True)
    # A display name is no proof of what the transport read.
    assert await ArchiveService(db_session).attach_3mf_to_archive(pending.id, downloaded, "x.swap.gcode.3mf")

    attached = await db_session.get(PrintArchive, pending.id, populate_existing=True)
    assert sc.archive_fact(attached).value is None


@pytest.mark.parametrize("legacy_column", [False, True])
async def test_legacy_unattached_false_is_not_reclassified(legacy_column, db_session, printer_factory, tmp_path):
    printer = await printer_factory()
    legacy = await an_external_row(db_session, printer.id, fact=None, legacy_column=legacy_column)
    received = "lamp.gcode.3mf" if legacy_column else "lamp.swap.gcode.3mf"

    attached = await attach(db_session, legacy, received, tmp_path)

    # No record before, none after: a legacy False stays unknown (D1) and a legacy True stays True.
    assert sc.archive_fact(attached) == sc.ArchiveFact(True if legacy_column else None)
    assert sc.CARRIER_KEY not in (attached.extra_data or {})


@pytest.mark.parametrize(
    ("fact", "received"),
    [(False, "lamp.swap.gcode.3mf"), (None, "lamp.swap.gcode.3mf"), (True, "lamp.gcode.3mf")],
    ids=["captured False", "adopted unknown", "completed external True"],
)
async def test_capture_fact_and_completed_external_fact_survive_retry(
    fact, received, db_session, printer_factory, tmp_path
):
    printer = await printer_factory()
    recorded = await an_external_row(db_session, printer.id, fact=fact)

    attached = await attach(db_session, recorded, received, tmp_path)

    assert sc.archive_fact(attached) == sc.ArchiveFact(fact, recorded=True)


async def test_parsed_metadata_cannot_rewrite_the_record_on_attach(db_session, printer_factory, tmp_path, monkeypatch):
    import backend.app.services.archive as archive_module

    printer = await printer_factory()
    recorded = await an_external_row(db_session, printer.id, fact=False)
    real_parse = archive_module.ThreeMFParser.parse

    def forged(self, *args, **kwargs):
        parsed = real_parse(self, *args, **kwargs)
        parsed[sc.CARRIER_KEY] = {"version": 1, "value": True, "pending_external": False}
        return parsed

    monkeypatch.setattr(archive_module.ThreeMFParser, "parse", forged)
    attached = await attach(db_session, recorded, "lamp.gcode.3mf", tmp_path)

    assert sc.archive_fact(attached) == sc.ArchiveFact(False, recorded=True)


START_DATA = {"subtask_id": "sub-7", "raw_data": {}}


async def drive_external_start(db_session, test_engine, tmp_path, monkeypatch, printer, data, download_result=None):
    from unittest.mock import AsyncMock, MagicMock, patch

    from backend.app.core.config import settings as app_settings
    from backend.app.main import _active_prints, on_print_start

    _active_prints.clear()
    monkeypatch.setattr(app_settings, "base_dir", tmp_path)
    monkeypatch.setattr(app_settings, "archive_dir", tmp_path / "archive")
    (tmp_path / "archive").mkdir(parents=True, exist_ok=True)
    factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr("backend.app.main.async_session", factory)
    monkeypatch.setattr("backend.app.core.database.async_session", factory)
    ws = MagicMock()
    for attribute in ("send_print_start", "send_archive_created", "send_archive_updated", "broadcast"):
        setattr(ws, attribute, AsyncMock())
    with (
        patch("backend.app.main.ws_manager", ws),
        patch("backend.app.main.printer_manager", MagicMock()),
        patch("backend.app.main.mqtt_relay", MagicMock(on_print_start=AsyncMock(), on_archive_created=AsyncMock())),
        patch("backend.app.main.smart_plug_manager", MagicMock(on_print_start=AsyncMock())),
        patch("backend.app.main.notify_missing_spool_assignments_on_print_start", new_callable=AsyncMock),
        patch("backend.app.services.macro_trigger.fire_event_macros", new_callable=AsyncMock),
        patch("backend.app.main._send_print_start_notification", new_callable=AsyncMock),
        patch("backend.app.main._record_energy_start", new_callable=AsyncMock),
        patch("backend.app.main._list_timelapse_videos", new_callable=AsyncMock, return_value=([], None)),
        patch("backend.app.services.archive_download.try_download_3mf", AsyncMock(return_value=download_result)),
        patch("backend.app.services.bambu_ftp.get_ftp_retry_settings", AsyncMock(return_value=(False, 0, 0, 30))),
    ):
        await on_print_start(printer.id, {**START_DATA, **data})
    _active_prints.clear()
    db_session.expire_all()
    return (await db_session.execute(select(PrintArchive).order_by(PrintArchive.id))).scalars().all()


async def an_archiving_printer(db_session, printer_factory):
    printer = await printer_factory()
    printer.auto_archive = True
    printer.plate_detection_enabled = False
    printer.external_camera_enabled = False
    await db_session.commit()
    return printer


@pytest.mark.parametrize(
    ("data", "expected"),
    [
        ({"filename": "/sdcard/lamp.swap.gcode.3mf", "subtask_name": "lamp"}, sc.ArchiveFact(True, recorded=True)),
        # A plate path names no file; the subtask helps find one but declares nothing by itself.
        (
            {"filename": "/data/Metadata/plate_1.gcode", "subtask_name": "lamp.swap"},
            sc.ArchiveFact(None, pending_external=True, recorded=True),
        ),
        ({"filename": "lamp.swap", "subtask_name": ""}, sc.ArchiveFact(None, pending_external=True, recorded=True)),
        ({"filename": "", "subtask_name": "lamp"}, sc.ArchiveFact(None, pending_external=True, recorded=True)),
    ],
    ids=["marked filename", "plate path + marked subtask", "stem without a boundary", "no filename"],
)
async def test_external_start_distinguishes_filename_subtask_and_stem(
    data, expected, db_session, test_engine, tmp_path, monkeypatch, printer_factory
):
    printer = await an_archiving_printer(db_session, printer_factory)

    rows = await drive_external_start(db_session, test_engine, tmp_path, monkeypatch, printer, data)

    assert len(rows) == 1
    assert sc.archive_fact(rows[0]) == expected


async def test_an_external_start_attaches_by_the_name_that_downloaded(
    db_session, test_engine, tmp_path, monkeypatch, printer_factory
):
    printer = await an_archiving_printer(db_session, printer_factory)
    (tmp_path / "dl").mkdir()
    downloaded = a_sliced_file(tmp_path / "dl" / "lamp.swaps.gcode.3mf")

    rows = await drive_external_start(
        db_session,
        test_engine,
        tmp_path,
        monkeypatch,
        printer,
        # The plate the synthetic file was sliced for, so the plate check accepts the download.
        {"filename": "/data/Metadata/plate_15.gcode", "subtask_name": "lamp"},
        download_result=(downloaded, "lamp.swaps.gcode.3mf"),
    )

    assert len(rows) == 1
    assert sc.archive_fact(rows[0]) == sc.ArchiveFact(True, recorded=True)


async def test_adopted_renamed_own_print_is_unknown_and_stays_so(db_session, printer_factory, main_db, tmp_path):
    from backend.tests.integration.test_adopt_print_started_while_down import _drive_hook

    _printer_id, rows, _spies, _spawned = await _drive_hook(
        db_session=db_session,
        printer_factory=printer_factory,
        data={"filename": "/sdcard/lamp.swap.gcode.3mf", "subtask_name": "lamp", "remaining_time": 60, "raw_data": {}},
    )

    assert len(rows) == 1
    # An adopted run's origin is not proven: a marked name is not an authority, and no attach may finish it.
    assert sc.archive_fact(rows[0]) == sc.ArchiveFact(None, recorded=True)
    attached = await attach(db_session, rows[0], "lamp.swap.gcode.3mf", tmp_path)
    assert sc.archive_fact(attached) == sc.ArchiveFact(None, recorded=True)
