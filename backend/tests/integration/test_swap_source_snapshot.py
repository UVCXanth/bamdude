"""A job keeps its source's swap declaration -- swap-source-lifecycle spec r4 §5-§6, plan T2.

The fact is taken once, at capture, from the row the bytes come from (an archive through its record, a library
file only with a valid hash), confirmed against the hash the worker actually computed, and written into the
job's own ``source_snapshot``. From then on the job answers for itself: a display rename, a changed library row
or a deleted original changes nothing, and the original is never opened, stat-ed or resolved to answer it.

A snapshot that predates the fix (a valid version-1 payload without the key) is the one case that may look
back, and only through the job's own live foreign key whose content hash matches the blob (§6).
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import time
import zipfile
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from backend.app.core import database, db_portable
from backend.app.core.database import Base
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.models.printer_queue import PrinterQueue
from backend.app.models.queue_source import QueueSource
from backend.app.services import queue_sources, swap_compatibility as sc
from backend.app.services.filament_intake import item_descriptor, snapshot_for_copy
from backend.app.services.queue_source_capture import capture_staged, plan_capture
from backend.app.services.queue_source_descriptor import SOURCE_SNAPSHOT_VERSION, stored_descriptor

pytestmark = pytest.mark.integration


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


def make_3mf(path: Path, *, payload: bytes = b"<model/>") -> bytes:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("3D/3dmodel.model", payload)
        zf.writestr("Metadata/plate_1.png", b"\x89PNG" + b"\x00" * 64)
    return path.read_bytes()


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


async def a_queue(db, printer_factory) -> PrinterQueue:
    printer = await printer_factory()
    queue = await db.get(PrinterQueue, printer.id)
    if queue is None:
        queue = PrinterQueue(id=printer.id, printer_id=printer.id, status="idle")
        db.add(queue)
        await db.commit()
    return queue


async def a_library_file(db, path: Path, *, declared: bool, file_hash: str | None) -> LibraryFile:
    row = LibraryFile(
        filename=path.name,
        file_path=str(path),
        file_type="3mf",
        file_size=path.stat().st_size,
        file_hash=file_hash,
        swap_compatible=declared,
    )
    db.add(row)
    await db.commit()
    return row


async def an_archive(db, archive_factory, printer_id: int, path: Path, **columns) -> PrintArchive:
    return await archive_factory(printer_id, filename=path.name, file_path=str(path), **columns)


async def a_captured_job(sessions, db, queue: PrinterQueue, *, library_file=None, archive=None) -> PrintQueueItem:
    """The production path: plan, capture, confirm, publish with the job row in the same transaction."""
    staged = await capture_staged(plan_capture(archive=archive, library_file=library_file))
    created: list[int] = []

    async def attach(session: AsyncSession, source: QueueSource) -> None:
        item = PrintQueueItem(
            queue_id=queue.id,
            status="pending",
            position=1,
            archive_id=archive.id if archive is not None else None,
            library_file_id=library_file.id if library_file is not None else None,
            queue_source_id=source.id,
            source_snapshot=queue_sources.snapshot_for(staged.receipt, source),
        )
        session.add(item)
        await session.flush()
        created.append(item.id)

    await queue_sources.publish(staged.receipt, attach, session_factory=sessions)
    return await db.get(PrintQueueItem, created[0], populate_existing=True)


async def a_job_with_snapshot(db, queue: PrinterQueue, blob: QueueSource, snapshot, **columns) -> PrintQueueItem:
    item = PrintQueueItem(
        queue_id=queue.id,
        status="pending",
        position=1,
        queue_source_id=blob.id,
        source_snapshot=snapshot,
        **columns,
    )
    db.add(item)
    await db.commit()
    return item


def old_snapshot(blob: QueueSource, kind: str | None, source_id: int | None) -> dict:
    """A version-1 payload as written before this fix: no declaration key at all."""
    provenance = {} if kind is None else {"kind": kind, "id": source_id}
    return {
        "version": SOURCE_SNAPSHOT_VERSION,
        "provenance": provenance,
        "display_filename": "lamp.gcode.3mf",
        "format": blob.format,
        "plate_fallback": None,
    }


async def a_blob(sessions, path: Path) -> QueueSource:
    async def attach(session, source):
        return None

    receipt = await queue_sources.capture(
        queue_sources.CaptureRequest(path=path, format="3mf", display_filename=path.name)
    )
    return await queue_sources.publish(receipt, attach, session_factory=sessions)


# --- capture -> receipt -> snapshot -> descriptor (§5) --------------------------------------------------------------


@pytest.mark.parametrize("declared", [True, False])
async def test_fact_and_reason_roundtrip(declared, sessions, db_session, printer_factory, tmp_path):
    queue = await a_queue(db_session, printer_factory)
    path = tmp_path / "share" / "lamp.gcode.3mf"
    raw = make_3mf(path)
    library = await a_library_file(db_session, path, declared=declared, file_hash=sha(raw))

    job = await a_captured_job(sessions, db_session, queue, library_file=library)

    assert job.source_snapshot[sc.SNAPSHOT_FACT_KEY] is declared
    assert sc.SNAPSHOT_REASON_KEY not in job.source_snapshot
    descriptor = await item_descriptor(db_session, job)
    assert descriptor.swap_fact == sc.SourceFact(declared)


async def test_unknown_fact_and_its_reason_roundtrip(sessions, db_session, printer_factory, archive_factory, tmp_path):
    queue = await a_queue(db_session, printer_factory)
    path = tmp_path / "archive" / "lamp.swap.gcode.3mf"
    raw = make_3mf(path)
    # A legacy archive's False declares nothing (D1), whatever its name says.
    archive = await an_archive(
        db_session, archive_factory, queue.printer_id, path, source_content_hash=sha(raw), swap_compatible=False
    )

    job = await a_captured_job(sessions, db_session, queue, archive=archive)

    assert job.source_snapshot[sc.SNAPSHOT_FACT_KEY] is None
    assert job.source_snapshot[sc.SNAPSHOT_REASON_KEY] == "source_unknown"
    descriptor = await item_descriptor(db_session, job)
    assert descriptor.swap_fact == sc.SourceFact(None, "source_unknown")


async def test_capture_hash_mismatch_invalidates_fact(sessions, db_session, printer_factory, tmp_path):
    queue = await a_queue(db_session, printer_factory)
    path = tmp_path / "share" / "lamp.gcode.3mf"
    make_3mf(path, payload=b"<model what='was declared'/>")
    declared_hash = sha(path.read_bytes())
    library = await a_library_file(db_session, path, declared=True, file_hash=declared_hash)
    make_3mf(path, payload=b"<model what='is there now'/>")  # the file changed after the row was hashed

    job = await a_captured_job(sessions, db_session, queue, library_file=library)

    descriptor = await item_descriptor(db_session, job)
    assert descriptor.sha256 != declared_hash
    assert descriptor.swap_fact == sc.SourceFact(None, "hash_mismatch")


async def test_missing_hash_is_not_known_false(sessions, db_session, printer_factory, archive_factory, tmp_path):
    queue = await a_queue(db_session, printer_factory)
    library_path = tmp_path / "share" / "plain.gcode.3mf"
    make_3mf(library_path)
    library = await a_library_file(db_session, library_path, declared=False, file_hash=None)
    archive_path = tmp_path / "archive" / "plain.gcode.3mf"
    make_3mf(archive_path, payload=b"<model other='1'/>")
    archive = await an_archive(db_session, archive_factory, queue.printer_id, archive_path)
    sc.write_archive_fact(archive, False)
    await db_session.commit()

    from_library = await a_captured_job(sessions, db_session, queue, library_file=library)
    from_archive = await a_captured_job(sessions, db_session, queue, archive=archive)

    assert (await item_descriptor(db_session, from_library)).swap_fact == sc.SourceFact(None, "hash_missing")
    assert (await item_descriptor(db_session, from_archive)).swap_fact == sc.SourceFact(None, "hash_missing")


async def test_archive_hash_falls_back_to_content_hash_only_without_a_source_hash(
    sessions, db_session, printer_factory, archive_factory, tmp_path
):
    queue = await a_queue(db_session, printer_factory)
    path = tmp_path / "archive" / "plain.gcode.3mf"
    raw = make_3mf(path)
    archive = await an_archive(db_session, archive_factory, queue.printer_id, path, content_hash=sha(raw))
    sc.write_archive_fact(archive, False)
    await db_session.commit()

    job = await a_captured_job(sessions, db_session, queue, archive=archive)

    assert (await item_descriptor(db_session, job)).swap_fact == sc.SourceFact(False)


# --- strict snapshot, §6 legacy resolution ---------------------------------------------------------------------------


async def test_explicit_unknown_and_invalid_version_never_fall_back(sessions, db_session, printer_factory, tmp_path):
    queue = await a_queue(db_session, printer_factory)
    path = tmp_path / "share" / "lamp.gcode.3mf"
    raw = make_3mf(path)
    blob = await a_blob(sessions, path)
    # The FK row would answer True with a matching hash -- none of these may ask it.
    library = await a_library_file(db_session, path, declared=True, file_hash=sha(raw))
    base = old_snapshot(blob, "library_file", library.id)

    cases = {
        "explicit null": ({**base, sc.SNAPSHOT_FACT_KEY: None}, sc.SourceFact(None, "source_unknown")),
        "null with reason": (
            {**base, sc.SNAPSHOT_FACT_KEY: None, sc.SNAPSHOT_REASON_KEY: "hash_mismatch"},
            sc.SourceFact(None, "hash_mismatch"),
        ),
        "string true": ({**base, sc.SNAPSHOT_FACT_KEY: "true"}, sc.SourceFact(None, "record_invalid")),
        "integer one": ({**base, sc.SNAPSHOT_FACT_KEY: 1}, sc.SourceFact(None, "record_invalid")),
        "other version": ({**base, "version": 2}, sc.SourceFact(None, "record_invalid")),
        "no snapshot": (None, sc.SourceFact(None, "record_invalid")),
        "not a dict": (["version", 1], sc.SourceFact(None, "record_invalid")),
        "missing key (control)": (base, sc.SourceFact(True)),
    }
    for label, (snapshot, expected) in cases.items():
        job = await a_job_with_snapshot(db_session, queue, blob, snapshot, library_file_id=library.id)
        assert (await item_descriptor(db_session, job)).swap_fact == expected, label


async def test_legacy_resolution_requires_live_fk_and_matching_hash(
    sessions, db_session, printer_factory, archive_factory, tmp_path
):
    queue = await a_queue(db_session, printer_factory)
    path = tmp_path / "share" / "lamp.gcode.3mf"
    raw = make_3mf(path)
    blob = await a_blob(sessions, path)
    other = tmp_path / "share" / "other.gcode.3mf"
    other_raw = make_3mf(other, payload=b"<model other='1'/>")

    declared_true = await a_library_file(db_session, path, declared=True, file_hash=sha(raw))
    declared_false = await a_library_file(db_session, path, declared=False, file_hash=sha(raw))
    wrong_bytes = await a_library_file(db_session, path, declared=True, file_hash=sha(other_raw))
    trashed = await a_library_file(db_session, path, declared=True, file_hash=sha(raw))
    trashed.deleted_at = datetime.now(timezone.utc).replace(tzinfo=None)
    legacy_archive = await an_archive(
        db_session, archive_factory, queue.printer_id, path, source_content_hash=sha(raw), swap_compatible=False
    )
    recorded_archive = await an_archive(
        db_session, archive_factory, queue.printer_id, path, source_content_hash=sha(raw)
    )
    sc.write_archive_fact(recorded_archive, False)
    await db_session.commit()

    cases = {
        "library True, matching": ({"library_file_id": declared_true.id}, "library_file", sc.SourceFact(True)),
        "library False, matching": ({"library_file_id": declared_false.id}, "library_file", sc.SourceFact(False)),
        "library hash differs": (
            {"library_file_id": wrong_bytes.id},
            "library_file",
            sc.SourceFact(None, "hash_mismatch"),
        ),
        # The row it was taken from still exists under that id, but the job's own link is gone (SET NULL):
        # provenance alone never authorises a lookup -- the id may have been reused.
        "provenance only": ({}, "library_file", sc.SourceFact(None, "source_unknown")),
        "own row in the trash": ({"library_file_id": trashed.id}, "library_file", sc.SourceFact(True)),
        "legacy archive False (D1)": (
            {"archive_id": legacy_archive.id},
            "archive",
            sc.SourceFact(None, "source_unknown"),
        ),
        "recorded archive False": ({"archive_id": recorded_archive.id}, "archive", sc.SourceFact(False)),
        "both links, no kind": (
            {"archive_id": recorded_archive.id, "library_file_id": declared_true.id},
            None,
            sc.SourceFact(None, "source_unknown"),
        ),
        "both links, kind names the library": (
            {"archive_id": recorded_archive.id, "library_file_id": declared_true.id},
            "library_file",
            sc.SourceFact(True),
        ),
    }
    for label, (links, kind, expected) in cases.items():
        source_id = links.get("library_file_id") or links.get("archive_id") or declared_true.id
        job = await a_job_with_snapshot(db_session, queue, blob, old_snapshot(blob, kind, source_id), **links)
        assert (await item_descriptor(db_session, job)).swap_fact == expected, label

    hard_deleted = await a_library_file(db_session, path, declared=True, file_hash=sha(raw))
    job = await a_job_with_snapshot(
        db_session,
        queue,
        blob,
        old_snapshot(blob, "library_file", hard_deleted.id),
        library_file_id=hard_deleted.id,
    )
    await db_session.delete(hard_deleted)
    await db_session.commit()
    job = await db_session.get(PrintQueueItem, job.id, populate_existing=True)
    assert (await item_descriptor(db_session, job)).swap_fact == sc.SourceFact(None, "source_unknown")


async def test_shared_blob_has_independent_job_facts(sessions, db_session, printer_factory, tmp_path):
    queue = await a_queue(db_session, printer_factory)
    first, second = tmp_path / "a" / "lamp.swap.gcode.3mf", tmp_path / "b" / "lamp.gcode.3mf"
    raw = make_3mf(first)
    make_3mf(second)
    assert sha(second.read_bytes()) == sha(raw)
    baked = await a_library_file(db_session, first, declared=True, file_hash=sha(raw))
    plain = await a_library_file(db_session, second, declared=False, file_hash=sha(raw))

    job_baked = await a_captured_job(sessions, db_session, queue, library_file=baked)
    job_plain = await a_captured_job(sessions, db_session, queue, library_file=plain)

    assert job_baked.queue_source_id == job_plain.queue_source_id  # one object on disk, two owners
    assert (await item_descriptor(db_session, job_baked)).swap_fact == sc.SourceFact(True)
    assert (await item_descriptor(db_session, job_plain)).swap_fact == sc.SourceFact(False)


async def test_copy_does_not_mutate_parent_snapshot(sessions, db_session, printer_factory, tmp_path):
    queue = await a_queue(db_session, printer_factory)
    path = tmp_path / "share" / "lamp.gcode.3mf"
    raw = make_3mf(path)
    blob = await a_blob(sessions, path)
    library = await a_library_file(db_session, path, declared=True, file_hash=sha(raw))
    parent = await a_job_with_snapshot(
        db_session, queue, blob, old_snapshot(blob, "library_file", library.id), library_file_id=library.id
    )
    before = json.loads(json.dumps(parent.source_snapshot))

    copied = await snapshot_for_copy(db_session, parent)

    assert copied is not parent.source_snapshot
    assert copied["provenance"] is not parent.source_snapshot["provenance"]
    assert copied[sc.SNAPSHOT_FACT_KEY] is True  # the copy records the answer it was given
    assert parent.source_snapshot == before  # the parent keeps its own payload, unanswered
    copied["provenance"]["id"] = -1
    assert parent.source_snapshot == before

    # And through a real clone, read back from the database.
    from backend.app.services.queue_ops import clone_item

    clone = await clone_item(db_session, parent.id, keep_batch=False)
    stored_parent = await db_session.get(PrintQueueItem, parent.id, populate_existing=True)
    assert clone.source_snapshot[sc.SNAPSHOT_FACT_KEY] is True
    assert sc.SNAPSHOT_FACT_KEY not in stored_parent.source_snapshot
    # The library row changing afterwards moves the parent's lookup, never the copy's recorded fact.
    library.swap_compatible = False
    await db_session.commit()
    assert (await item_descriptor(db_session, clone)).swap_fact == sc.SourceFact(True)


async def test_captured_fact_does_not_open_stat_or_resolve_original(
    sessions, db_session, printer_factory, tmp_path, monkeypatch
):
    queue = await a_queue(db_session, printer_factory)
    path = tmp_path / "share" / "lamp.gcode.3mf"
    raw = make_3mf(path)
    library = await a_library_file(db_session, path, declared=False, file_hash=sha(raw))
    job = await a_captured_job(sessions, db_session, queue, library_file=library)
    path.unlink()  # the share is gone

    touched: list[str] = []
    for name in ("stat", "exists", "resolve", "open", "is_file"):
        real = getattr(Path, name)

        def spy(self, *args, _real=real, _name=name, **kwargs):
            if self.name == path.name and self.parent == path.parent:
                touched.append(_name)
            return _real(self, *args, **kwargs)

        monkeypatch.setattr(Path, name, spy)

    descriptor = await item_descriptor(db_session, job)

    assert descriptor.swap_fact == sc.SourceFact(False)
    assert touched == []


# --- portable backup (§11) ------------------------------------------------------------------------------------------


async def test_portable_restore_keeps_job_fact_and_unknown(tmp_path):
    source_db, output = tmp_path / "farm.db", tmp_path / "backup.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{source_db}")
    snapshots = {
        1: {"version": 1, "provenance": {}, "display_filename": "a.3mf", "format": "3mf", "plate_fallback": None},
        2: {"version": 1, "display_filename": "b.3mf", "format": "3mf", sc.SNAPSHOT_FACT_KEY: True},
        3: {"version": 1, "display_filename": "c.3mf", "format": "3mf", sc.SNAPSHOT_FACT_KEY: False},
        4: {
            "version": 1,
            "display_filename": "d.3mf",
            "format": "3mf",
            sc.SNAPSHOT_FACT_KEY: None,
            sc.SNAPSHOT_REASON_KEY: "hash_mismatch",
        },
    }
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
            await conn.exec_driver_sql(
                "CREATE TABLE _migrations (id INTEGER PRIMARY KEY, version INTEGER NOT NULL UNIQUE, "
                "name VARCHAR(100) NOT NULL, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)"
            )
        factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        async with factory() as db:
            db.add(Printer(id=1, name="P", serial_number="00M09A000000001", ip_address="10.0.0.1", access_code="x"))
            db.add(PrinterQueue(id=1, printer_id=1, status="idle"))
            db.add(
                QueueSource(
                    id=1,
                    sha256="a" * 64,
                    size_bytes=1,
                    relative_path="queue-sources/objects/aa/" + "a" * 64 + ".3mf",
                    format="3mf",
                    state="ready",
                )
            )
            for item_id, snapshot in snapshots.items():
                db.add(
                    PrintQueueItem(
                        id=item_id,
                        queue_id=1,
                        status="pending",
                        position=item_id,
                        queue_source_id=1,
                        source_snapshot=snapshot,
                    )
                )
            await db.commit()
        await db_portable._export_pg_to_sqlite(engine, Base.metadata, output)
    finally:
        await engine.dispose()

    blob = QueueSource(id=1, sha256="a" * 64, size_bytes=1, relative_path="x/" + "a" * 64 + ".3mf", format="3mf")
    with closing(sqlite3.connect(output)) as conn:
        rows = dict(conn.execute("SELECT id, source_snapshot FROM print_queue"))
    facts = {item_id: stored_descriptor(blob, json.loads(raw)).swap_fact for item_id, raw in rows.items()}
    assert facts == {
        1: sc.SourceFact(None, missing=True),
        2: sc.SourceFact(True),
        3: sc.SourceFact(False),
        4: sc.SourceFact(None, "hash_mismatch"),
    }
    # The unknown keeps its reason and is not turned into a False on the way through.
    assert json.loads(rows[4])[sc.SNAPSHOT_FACT_KEY] is None
