"""How a library row gets its swap declaration -- swap-source-lifecycle spec r4 §4, plan T5.

A NEW external file is classified by its own basename, the same way at every door that takes one in: upload, a
ZIP member, the external scan and the Virtual Printer's receive. A display rename, a same-hash re-ingest and a
same-hash scan keep what the row already declares; only a successful new content identity on a scanned path
publishes a new declaration, together with its hash and metadata. What BamDude generates itself -- a slice, a
calibration print, a re-sliced archive -- is False whatever it is called.

Saving an archive to the library is a transfer, not an ingest: the archive's own record, confirmed against the
bytes really read, travels explicitly; an unknown or a mismatch is refused before anything is written, and the
library's existing row of the same bytes is never rewritten to another declaration.

A row without a valid content hash is unknown, and the ordinary scan repairs it (R2-3): a NULL or invalid hash is
not a complete extraction, so the next scan prepares the file even with unchanged size and mtime -- and only then.
"""

from __future__ import annotations

import copy
import hashlib
import io
import os
import time
import zipfile
from pathlib import Path

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.core import database
from backend.app.core.config import settings
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile, LibraryFolder
from backend.app.models.library_scan import LibraryScanJob
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer_queue import PrinterQueue
from backend.app.models.queue_source import QueueSource
from backend.app.services import queue_sources, swap_compatibility as sc
from backend.app.services.library_scan import run_scan
from backend.app.services.queue_source_capture import capture_staged, plan_capture
from backend.tests.fixtures.filament_routing_cases import write_routing_3mf

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]

_PLATE = {1: [{"id": 1, "type": "PLA", "color": "#FFFFFF", "used_g": "1"}]}


# --- fixtures and helpers -------------------------------------------------------------------------------------------


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
    factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr(database, "async_session", factory)
    return factory


@pytest.fixture
async def mount(db_session: AsyncSession, tmp_path):
    root = tmp_path / "nas"
    root.mkdir()
    folder = LibraryFolder(name="NAS", is_external=True, external_path=str(root), external_show_hidden=False)
    db_session.add(folder)
    await db_session.commit()
    await db_session.refresh(folder)
    return root, folder


@pytest.fixture
def worker_calls(monkeypatch):
    """What the scan asked of the file worker: every full preparation and every hash, by file name."""
    from backend.app.services import library_file_runtime

    worker = library_file_runtime.runtime
    calls: dict[str, list[str]] = {"prepare": [], "hash": []}
    real_prepare, real_hash = worker.prepare, worker.hash

    async def prepare(path, *, root, filename=None):
        calls["prepare"].append(Path(path).name)
        return await real_prepare(path, root=root, filename=filename)

    async def hash_(path, *, root):
        calls["hash"].append(Path(path).name)
        return await real_hash(path, root=root)

    monkeypatch.setattr(worker, "prepare", prepare)
    monkeypatch.setattr(worker, "hash", hash_)
    return calls


def a_3mf(path: Path, tag: str) -> bytes:
    """A real sliced 3MF whose bytes are its own: ``tag`` makes every door's content distinct."""
    path.parent.mkdir(parents=True, exist_ok=True)
    write_routing_3mf(path, _PLATE)
    with zipfile.ZipFile(path, "a") as zf:
        zf.writestr("Metadata/tag.txt", tag)
    return path.read_bytes()


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


async def row_of(db: AsyncSession, content: bytes) -> LibraryFile:
    """The one row of these bytes, read fresh: the doors wrote from their own sessions."""
    stmt = select(LibraryFile).where(LibraryFile.file_hash == sha(content)).execution_options(populate_existing=True)
    return (await db.execute(stmt)).scalar_one()


async def rows_of(db: AsyncSession, content: bytes) -> int:
    return (await db.execute(select(func.count()).where(LibraryFile.file_hash == sha(content)))).scalar_one()


async def fresh(db: AsyncSession, row_id: int) -> LibraryFile:
    return await db.get(LibraryFile, row_id, populate_existing=True)


def library_dir_files() -> set[str]:
    from backend.app.api.routes.library import get_library_files_dir

    directory = get_library_files_dir()
    return {p.name for p in directory.iterdir()} if directory.exists() else set()


async def via_upload(client, name: str, content: bytes) -> None:
    response = await client.post("/api/v1/library/files", files={"file": (name, content, "application/octet-stream")})
    assert response.status_code == 200, response.text


async def via_zip(client, members: dict[str, bytes], *, outer: str = "bundle.zip") -> dict:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        for member, content in members.items():
            zf.writestr(member, content)
    response = await client.post(
        "/api/v1/library/files/extract-zip",
        files={"file": (outer, buffer.getvalue(), "application/zip")},
        params={"preserve_structure": "true"},
    )
    assert response.status_code == 200, response.text
    assert not response.json()["errors"], response.json()
    return response.json()


async def via_scan(db: AsyncSession, folder: LibraryFolder) -> None:
    job = LibraryScanJob(folder_id=folder.id, status="queued")
    db.add(job)
    await db.commit()
    await run_scan(job.id)
    await db.refresh(job)
    assert job.status == "finished", job.error


def a_vp(tmp_path: Path, test_engine):
    from backend.app.services.virtual_printer.manager import VirtualPrinterInstance

    return VirtualPrinterInstance(
        vp_id=1,
        name="Synthetic",
        mode="file_manager",
        model="C11",
        access_code="00000000",
        serial_suffix="000000001",
        base_dir=tmp_path,
        session_factory=async_sessionmaker(test_engine, expire_on_commit=False),
    )


async def via_vp(tmp_path: Path, test_engine, name: str, content: bytes) -> LibraryFile:
    staged = tmp_path / "vp-in" / name
    staged.parent.mkdir(parents=True, exist_ok=True)
    staged.write_bytes(content)
    row = await a_vp(tmp_path, test_engine)._save_to_library(staged, "127.0.0.1")
    assert row is not None
    return row


async def a_queue(db: AsyncSession, printer_factory) -> PrinterQueue:
    printer = await printer_factory()
    queue = await db.get(PrinterQueue, printer.id)
    if queue is None:
        queue = PrinterQueue(id=printer.id, printer_id=printer.id, status="idle")
        db.add(queue)
        await db.commit()
    return queue


async def a_captured_job(sessions, db: AsyncSession, queue: PrinterQueue, library_file: LibraryFile) -> PrintQueueItem:
    staged = await capture_staged(plan_capture(library_file=library_file))
    created: list[int] = []

    async def attach(session: AsyncSession, source: QueueSource) -> None:
        item = PrintQueueItem(
            queue_id=queue.id,
            status="pending",
            position=1,
            library_file_id=library_file.id,
            queue_source_id=source.id,
            source_snapshot=queue_sources.snapshot_for(staged.receipt, source),
        )
        session.add(item)
        await session.flush()
        created.append(item.id)

    await queue_sources.publish(staged.receipt, attach, session_factory=sessions)
    return await db.get(PrintQueueItem, created[0], populate_existing=True)


def touch_later(path: Path) -> None:
    """Move the mtime forward, so the scan sees a change it has to look at."""
    stat = path.stat()
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 10_000_000_000))


# --- every door that takes a NEW external file in classifies its basename the same way ------------------------------


@pytest.mark.parametrize(
    ("name", "declared"),
    [
        ("Plate.Swap.3mf", True),
        ("plate.SWAPS.gcode.3mf", True),
        ("plate.3mf", False),
        ("myswaps.3mf", False),
        ("plate.swapsy.3mf", False),
    ],
)
async def test_upload_zip_scan_and_vp_have_same_initial_classifier(
    name, declared, committing_client, db_session, mount, tmp_path, test_engine
):
    root, folder = mount
    uploaded = a_3mf(tmp_path / "src" / "upload.3mf", "upload")
    zipped = a_3mf(tmp_path / "src" / "zip.3mf", "zip")
    scanned = a_3mf(root / name, "scan")
    received = a_3mf(tmp_path / "src" / "vp.3mf", "vp")

    await via_upload(committing_client, name, uploaded)
    await via_zip(committing_client, {f"models/{name}": zipped})
    await via_scan(db_session, folder)
    await via_vp(tmp_path, test_engine, name, received)

    by_door = {
        door: (await row_of(db_session, content)).swap_compatible
        for door, content in (("upload", uploaded), ("zip", zipped), ("scan", scanned), ("vp", received))
    }
    assert by_door == dict.fromkeys(by_door, declared)
    # The tags follow the fact the row was written with.
    for content in (uploaded, zipped, scanned, received):
        assert ("swap" in (await row_of(db_session, content)).file_tags) is declared


async def test_zip_uses_member_basename_not_outer_name(committing_client, db_session, tmp_path):
    in_marked_dir = a_3mf(tmp_path / "a.3mf", "directory marker only")
    marked_member = a_3mf(tmp_path / "b.3mf", "member marker")

    await via_zip(
        committing_client,
        {"kit.swap.parts/plate.3mf": in_marked_dir, "sub/plate.swaps.3mf": marked_member},
        outer="bundle.swaps.zip",
    )

    assert (await row_of(db_session, in_marked_dir)).swap_compatible is False
    assert (await row_of(db_session, marked_member)).swap_compatible is True


# --- a rename and a same-hash ingest are not a new declaration ------------------------------------------------------


async def test_same_hash_ingest_and_rename_preserve_fact(committing_client, db_session, mount, tmp_path, test_engine):
    plain = a_3mf(tmp_path / "src" / "plain.3mf", "plain")
    await via_upload(committing_client, "plate.3mf", plain)
    row = await row_of(db_session, plain)
    response = await committing_client.put(f"/api/v1/library/files/{row.id}", json={"filename": "plate.swap.3mf"})
    assert response.status_code == 200, response.text
    assert (await fresh(db_session, row.id)).swap_compatible is False, "a display rename re-declares nothing"
    await via_upload(committing_client, "plate.swaps.3mf", plain)
    await via_vp(tmp_path, test_engine, "plate.swaps.3mf", plain)
    assert await rows_of(db_session, plain) == 1
    assert (await fresh(db_session, row.id)).swap_compatible is False, "a same-hash re-ingest is not a repair"

    marked = a_3mf(tmp_path / "src" / "marked.3mf", "marked")
    await via_upload(committing_client, "b.swap.3mf", marked)
    marked_row = await row_of(db_session, marked)
    assert marked_row.swap_compatible is True
    response = await committing_client.put(f"/api/v1/library/files/{marked_row.id}", json={"filename": "b.3mf"})
    assert response.status_code == 200, response.text
    await via_upload(committing_client, "b.3mf", marked)
    assert (await fresh(db_session, marked_row.id)).swap_compatible is True

    # A scanned row: the bytes it holds keep its declaration across a rename and a re-scan of the same content.
    root, folder = mount
    on_share = root / "s.swap.3mf"
    shared = a_3mf(on_share, "shared")
    await via_scan(db_session, folder)
    scanned = await row_of(db_session, shared)
    scanned.swap_compatible = False  # the row's own (historical) declaration -- not what the name says today
    scanned.filename = "s.3mf"
    await db_session.commit()
    touch_later(on_share)
    await via_scan(db_session, folder)
    assert (await fresh(db_session, scanned.id)).swap_compatible is False


# --- a scan publishes a new identity's declaration with it, and a failed one changes nothing ------------------------


async def test_scan_new_identity_updates_fact_but_not_captured_job(db_session, mount, printer_factory, sessions):
    root, folder = mount
    on_share = root / "plate.swap.3mf"
    first = a_3mf(on_share, "v1")
    await via_scan(db_session, folder)
    row = await row_of(db_session, first)
    # What a scan before this fix left: False whatever the name -- and a display rename on top.
    row.swap_compatible = False
    row.filename = "plate.3mf"
    await db_session.commit()
    job = await a_captured_job(sessions, db_session, await a_queue(db_session, printer_factory), row)
    # That default False is no declaration: an external row is classified by its name on the share (T9 §8, C),
    # never by the display rename.
    assert sc.snapshot_fact(job.source_snapshot) == sc.SourceFact(True)
    captured = copy.deepcopy(job.source_snapshot)

    second = a_3mf(on_share, "v2")
    touch_later(on_share)
    await via_scan(db_session, folder)

    refreshed = await fresh(db_session, row.id)
    assert refreshed.file_hash == sha(second)
    assert refreshed.swap_compatible is True, "the share's own entry name, not the display rename"
    assert refreshed.filename == "plate.3mf"
    assert "swap" in refreshed.file_tags
    job = await db_session.get(PrintQueueItem, job.id, populate_existing=True)
    assert job.source_snapshot == captured, "a captured job keeps its own snapshot, fact included"


async def test_failed_scan_preserves_last_good_identity_tuple(db_session, mount):
    root, folder = mount
    on_share = root / "plate.3mf"
    a_3mf(on_share, "v1")
    await via_scan(db_session, folder)
    stmt = select(LibraryFile).where(LibraryFile.filename == "plate.3mf")
    row = (await db_session.execute(stmt)).scalar_one()
    row.swap_compatible = True  # a declaration the name would not give: a failed refresh must not re-derive it
    await db_session.commit()
    before = (row.file_hash, copy.deepcopy(row.file_metadata), row.thumbnail_path, row.swap_compatible)

    on_share.write_bytes(b"incomplete copy")
    touch_later(on_share)
    await via_scan(db_session, folder)

    row = await fresh(db_session, row.id)
    assert (row.file_hash, row.file_metadata, row.thumbnail_path, row.swap_compatible) == before


# --- what BamDude generates itself is False whatever it is called ---------------------------------------------------


class _Request:
    """The slice request as the persisters read it once the slicer is stubbed out."""

    plate = 1

    def model_copy(self, update=None):  # noqa: ARG002
        return self


async def test_generated_source_ignores_cosmetic_swap_name(
    db_session, tmp_path, monkeypatch, archive_factory, printer_factory, sessions
):
    from backend.app.api.routes import library as library_routes
    from backend.app.services import calibration_service
    from backend.app.services.calibration_service import _persist_calibration_slice_to_library
    from backend.app.services.slicer_api import SliceResult

    sliced = a_3mf(tmp_path / "out" / "sliced.gcode.3mf", "sliced output")

    async def slicer(db, **_kwargs):
        return SliceResult(content=sliced, print_time_seconds=60, filament_used_g=1.0, filament_used_mm=10.0), False

    async def no_preview(db, content, **_kwargs):
        return content

    monkeypatch.setattr(library_routes, "_run_slicer_with_fallback", slicer)
    monkeypatch.setattr(library_routes, "sliced_preview", no_preview)
    monkeypatch.setattr(calibration_service, "async_session", sessions)  # bound at import, not through database

    await library_routes.slice_and_persist(
        db_session,
        model_bytes=b"model",
        model_filename="plate.swap.3mf",
        folder_id=None,
        extra_metadata=None,
        request=_Request(),
        current_user_id=None,
    )
    assert (await row_of(db_session, sliced)).swap_compatible is False

    calibration = a_3mf(tmp_path / "out" / "cal.gcode.3mf", "calibration output")
    file_id = await _persist_calibration_slice_to_library(
        content=calibration,
        filename="flow.swaps.gcode.3mf",
        user_id=None,
        print_time_seconds=None,
        filament_used_g=None,
        filament_used_mm=None,
    )
    assert (await fresh(db_session, file_id)).swap_compatible is False

    # A re-slice of an archive that declares its own swap sequence: the new archive is our output, declared False,
    # never the source's record copied along with its metadata.
    printer = await printer_factory()
    source_path = settings.base_dir / "archive" / "src" / "plate.swap.3mf"
    a_3mf(source_path, "re-slice source")
    source = await archive_factory(
        printer.id, filename="plate.swap.3mf", file_path="archive/src/plate.swap.3mf", extra_data={"keep": 1}
    )
    sc.write_archive_fact(source, True)
    await db_session.commit()
    resliced = a_3mf(tmp_path / "out" / "resliced.gcode.3mf", "re-sliced output")

    async def reslicer(db, **_kwargs):
        return SliceResult(content=resliced, print_time_seconds=60, filament_used_g=1.0, filament_used_mm=10.0), False

    monkeypatch.setattr(library_routes, "_run_slicer_with_fallback", reslicer)
    answer = await library_routes.slice_and_persist_as_archive(
        db_session,
        model_bytes=b"model",
        model_filename="plate.swap.3mf",
        request=_Request(),
        source_archive=source,
        current_user_id=None,
    )
    new_archive = await db_session.get(PrintArchive, answer.archive_id, populate_existing=True)
    assert sc.archive_fact(new_archive) == sc.ArchiveFact(False, pending_external=False, recorded=True)
    assert new_archive.extra_data["keep"] == 1


# --- save archive to library: a transfer of the archive's own fact --------------------------------------------------


async def an_archive_file(db, archive_factory, printer_id: int, name: str, tag: str, *, record, hashed: bool = True):
    """An archive whose file is really on disk. ``record`` is its declaration (``...`` for none at all)."""
    relative = f"archive/{printer_id}/{tag}/{name}"
    content = a_3mf(settings.base_dir / relative, tag)
    columns = {"source_content_hash": sha(content)} if hashed else {}
    archive = await archive_factory(printer_id, filename=name, file_path=relative, **columns)
    if record is not ...:
        await declare(db, archive, record)
    return archive, content


async def declare(db: AsyncSession, archive: PrintArchive, value) -> None:
    sc.write_archive_fact(archive, value)
    await db.commit()


async def test_save_archive_to_library_copies_known_fact_not_display_name(
    committing_client, db_session, archive_factory, printer_factory
):
    printer = await printer_factory()
    named_swap, plain_bytes = await an_archive_file(
        db_session, archive_factory, printer.id, "plate.swap.3mf", "a", record=False
    )
    named_plain, marked_bytes = await an_archive_file(
        db_session, archive_factory, printer.id, "plate.3mf", "b", record=True
    )

    for archive in (named_swap, named_plain):
        response = await committing_client.post(f"/api/v1/archives/{archive.id}/save-to-library")
        assert response.status_code == 200, response.text

    assert (await row_of(db_session, plain_bytes)).swap_compatible is False
    assert (await row_of(db_session, marked_bytes)).swap_compatible is True


async def test_save_unknown_or_changed_archive_is_refused_without_partial_write(
    committing_client, db_session, archive_factory, printer_factory
):
    printer = await printer_factory()
    legacy, _ = await an_archive_file(db_session, archive_factory, printer.id, "legacy.swap.3mf", "legacy", record=...)
    unknown, _ = await an_archive_file(db_session, archive_factory, printer.id, "unknown.3mf", "unknown", record=None)
    changed, _ = await an_archive_file(db_session, archive_factory, printer.id, "changed.3mf", "changed", record=True)
    changed.source_content_hash = "0" * 64  # the record speaks for other bytes than the file now holds
    unhashed, _ = await an_archive_file(
        db_session, archive_factory, printer.id, "unhashed.3mf", "unhashed", record=False, hashed=False
    )
    await db_session.commit()
    before = library_dir_files()

    for archive in (legacy, unknown, changed, unhashed):
        response = await committing_client.post(f"/api/v1/archives/{archive.id}/save-to-library")
        assert response.status_code == 409, (archive.filename, response.text)
        assert response.json()["detail"]["error"] == "swap_source_unknown"

    assert (await db_session.execute(select(func.count()).select_from(LibraryFile))).scalar_one() == 0
    assert library_dir_files() == before, "nothing is written before the refusal"
    for archive in (legacy, unknown, changed, unhashed):
        assert await db_session.get(PrintArchive, archive.id) is not None, "the archive itself stays"


async def test_save_archive_dedup_requires_same_declaration(
    committing_client, db_session, archive_factory, printer_factory
):
    from backend.app.api.routes.library import to_absolute_path

    printer = await printer_factory()
    archive, content = await an_archive_file(db_session, archive_factory, printer.id, "x.3mf", "x", record=False)
    await via_upload(committing_client, "x.swap.3mf", content)
    existing = await row_of(db_session, content)
    assert existing.swap_compatible is True
    stored_path = existing.file_path
    before = library_dir_files()

    response = await committing_client.post(f"/api/v1/archives/{archive.id}/save-to-library")
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["error"] == "swap_source_conflict"
    existing = await fresh(db_session, existing.id)
    assert (existing.swap_compatible, existing.file_path) == (True, stored_path)
    assert library_dir_files() == before, "the copy written for the comparison is removed"

    # The library row is missing its bytes: the conflict still refuses, and the row is not re-pointed.
    to_absolute_path(existing.file_path).unlink()
    before = library_dir_files()
    response = await committing_client.post(f"/api/v1/archives/{archive.id}/save-to-library")
    assert response.status_code == 409, response.text
    existing = await fresh(db_session, existing.id)
    assert (existing.swap_compatible, existing.file_path) == (True, stored_path)
    assert library_dir_files() == before

    # The same declaration is an ordinary dedup.
    await declare(db_session, archive, True)
    response = await committing_client.post(f"/api/v1/archives/{archive.id}/save-to-library")
    assert response.status_code == 200, response.text
    assert response.json()["already_in_library"] is True
    assert await rows_of(db_session, content) == 1


# --- R2-3: a row without a valid hash is not complete, and the next ordinary scan repairs it -----------------------


async def a_scanned_row(db: AsyncSession, mount, name: str = "plate.3mf") -> tuple[LibraryFile, bytes]:
    root, folder = mount
    content = a_3mf(root / name, "scanned")
    await via_scan(db, folder)
    return await row_of(db, content), content


async def with_hash(db: AsyncSession, row: LibraryFile, value: str | None) -> None:
    """The stored digest -- and the extraction's -- set to ``value``, as an older writer may have left them."""
    metadata = copy.deepcopy(row.file_metadata)
    metadata["_library_extraction"]["hash"] = value
    row.file_hash = value
    row.file_metadata = metadata
    await db.commit()


async def test_scan_null_hash_current_extraction_is_not_complete(db_session, mount, worker_calls):
    row, content = await a_scanned_row(db_session, mount)
    row.swap_compatible = True  # the row's own declaration; a repair keeps it, the name would not give it
    await with_hash(db_session, row, None)
    assert sc.library_fact(row) is None
    worker_calls["prepare"].clear()

    await via_scan(db_session, mount[1])  # size and mtime unchanged

    assert worker_calls["prepare"] == ["plate.3mf"]
    row = await fresh(db_session, row.id)
    assert row.file_hash == sha(content)
    assert row.file_metadata["_library_extraction"]["hash"] == sha(content)
    assert sc.library_fact(row) is True


async def test_scan_equal_invalid_hashes_are_not_complete(db_session, mount, worker_calls):
    row, content = await a_scanned_row(db_session, mount)
    await with_hash(db_session, row, "not-a-digest")
    worker_calls["prepare"].clear()

    await via_scan(db_session, mount[1])

    assert worker_calls["prepare"] == ["plate.3mf"]
    row = await fresh(db_session, row.id)
    assert row.file_hash == sha(content)
    assert sc.library_fact(row) is False


async def test_repaired_scan_is_a_noop_next_time(db_session, mount, worker_calls):
    row, content = await a_scanned_row(db_session, mount)
    await with_hash(db_session, row, None)
    await via_scan(db_session, mount[1])
    assert (await fresh(db_session, row.id)).file_hash == sha(content)
    worker_calls["prepare"].clear()
    worker_calls["hash"].clear()

    await via_scan(db_session, mount[1])

    assert worker_calls == {"prepare": [], "hash": []}, "a repaired, unchanged row is not read again"


async def test_failed_null_hash_refresh_keeps_row_unknown(db_session, mount, monkeypatch):
    from backend.app.services import library_file_runtime

    row, _content = await a_scanned_row(db_session, mount)
    row.swap_compatible = True
    await with_hash(db_session, row, None)
    before = copy.deepcopy(row.file_metadata)

    async def unreadable(path, *, root, filename=None):  # noqa: ARG001
        raise OSError("the share stalled")

    monkeypatch.setattr(library_file_runtime.runtime, "prepare", unreadable)
    await via_scan(db_session, mount[1])

    row = await fresh(db_session, row.id)
    assert row.file_hash is None
    assert row.file_metadata == before
    assert row.swap_compatible is True
    assert sc.library_fact(row) is None, "only a successful refresh makes the declaration count"


@pytest.mark.parametrize(("name", "declared"), [("plate.swaps.3mf", True), ("plate.3mf", False)])
async def test_automated_ingest_classifies_the_new_files_basename(name, declared, db_session, tmp_path):
    """MakerWorld import and a file saved off a printer's card arrive through the in-memory helper with no
    declaration of their own: they are new external files, classified like any other."""
    from backend.app.api.routes.library import save_3mf_bytes_to_library

    content = a_3mf(tmp_path / "src" / "automated.3mf", "automated")
    result = await save_3mf_bytes_to_library(db_session, content=content, filename=name, source_type="makerworld")

    assert result.outcome == "created"
    assert (await fresh(db_session, result.file.id)).swap_compatible is declared
