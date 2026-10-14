"""What the API says about a source's swap declaration -- swap-source-lifecycle spec r4 §9, plan T6.

Every archive, library and queue copy-source answer carries the old bool and a required
``swap_compatibility_known``, both from the reader: True -> (true, true), False -> (false, true), unknown ->
(false, false). The archive's internal record is removed from the COPY of ``extra_data`` an answer carries; the
row keeps it, and every other key is returned as is. A library row without a valid content hash is unknown,
answered without reading the file. A queue job's copy source answers with the job's own captured fact, whatever
its display name says and whatever happened to the live row since.
"""

from __future__ import annotations

import hashlib
import time
import zipfile
from pathlib import Path

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.core import database
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer_queue import PrinterQueue
from backend.app.models.queue_source import QueueSource
from backend.app.services import queue_sources, swap_compatibility as sc
from backend.app.services.queue_source_capture import capture_staged, plan_capture
from backend.tests.fixtures.filament_routing_cases import write_routing_3mf

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]

KNOWN = "swap_compatibility_known"


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


def make_3mf(path: Path, tag: str) -> bytes:
    """A real sliced 3MF whose bytes are its own."""
    path.parent.mkdir(parents=True, exist_ok=True)
    write_routing_3mf(path, {1: [{"id": 1, "type": "PLA", "color": "#FFFFFF", "used_g": "1"}]})
    with zipfile.ZipFile(path, "a") as zf:
        zf.writestr("Metadata/tag.txt", tag)
    return path.read_bytes()


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def wire(body: dict) -> tuple[bool, bool]:
    return body["swap_compatible"], body[KNOWN]


# --- archives -------------------------------------------------------------------------------------------------------


async def an_archive(db, archive_factory, printer_id: int, *, record, column: bool = False, **columns) -> PrintArchive:
    """``record``: True / False / None is a written declaration, ``...`` none at all (a row from before the fix)."""
    archive = await archive_factory(printer_id, print_name="Swap probe", **columns)
    if record is ...:
        archive.swap_compatible = column
    else:
        sc.write_archive_fact(archive, record)
    await db.commit()
    return archive


@pytest.mark.parametrize(
    ("record", "column", "expected"),
    [
        (True, False, (True, True)),
        (False, False, (False, True)),
        (None, False, (False, False)),
        (..., False, (False, False)),  # D1: a legacy False is unknown
        (..., True, (True, True)),  # a legacy strict True survives
    ],
)
async def test_archive_api_all_serializers_project_fact(
    record, column, expected, committing_client, db_session, archive_factory, printer_factory
):
    printer = await printer_factory()
    archive = await an_archive(db_session, archive_factory, printer.id, record=record, column=column)

    listed = await committing_client.get("/api/v1/archives/")
    assert listed.status_code == 200, listed.text
    (row,) = [a for a in listed.json()["data"] if a["id"] == archive.id]
    detail = await committing_client.get(f"/api/v1/archives/{archive.id}")
    found = await committing_client.get("/api/v1/archives/search", params={"q": "Swap probe"})
    written = await committing_client.patch(f"/api/v1/archives/{archive.id}", json={"notes": "checked"})
    favorite = await committing_client.post(f"/api/v1/archives/{archive.id}/favorite")
    for response in (detail, found, written, favorite):
        assert response.status_code == 200, response.text
    (searched,) = [a for a in found.json() if a["id"] == archive.id]

    answers = {
        "list": wire(row),
        "detail": wire(detail.json()),
        "search": wire(searched),
        "write": wire(written.json()),
        "favorite": wire(favorite.json()),
    }
    assert answers == dict.fromkeys(answers, expected)


async def test_api_hides_only_internal_carrier_without_mutation(
    committing_client, db_session, archive_factory, printer_factory
):
    printer = await printer_factory()
    archive = await an_archive(
        db_session, archive_factory, printer.id, record=True, extra_data={"keep": 1, "nested": {"a": [1, 2]}}
    )

    listed = await committing_client.get("/api/v1/archives/")
    (row,) = [a for a in listed.json()["data"] if a["id"] == archive.id]
    detail = await committing_client.get(f"/api/v1/archives/{archive.id}")
    found = await committing_client.get("/api/v1/archives/search", params={"q": "Swap probe"})
    (searched,) = [a for a in found.json() if a["id"] == archive.id]
    written = await committing_client.patch(f"/api/v1/archives/{archive.id}", json={"notes": "checked"})
    favorite = await committing_client.post(f"/api/v1/archives/{archive.id}/favorite")

    for body in (row, detail.json(), searched, written.json(), favorite.json()):
        assert body["extra_data"] == {"keep": 1, "nested": {"a": [1, 2]}}
    stored = await db_session.get(PrintArchive, archive.id, populate_existing=True)
    assert stored.extra_data[sc.CARRIER_KEY] == {"version": 1, "value": True, "pending_external": False}
    assert stored.extra_data["keep"] == 1
    assert sc.archive_fact(stored).value is True


# --- library --------------------------------------------------------------------------------------------------------


async def a_library_file(db, path: Path, *, declared: bool, file_hash: str | None) -> LibraryFile:
    row = LibraryFile(
        filename=path.name,
        file_path=str(path),
        file_type="3mf",
        file_size=1,
        file_hash=file_hash,
        swap_compatible=declared,
    )
    db.add(row)
    await db.commit()
    return row


@pytest.mark.parametrize(
    ("declared", "hashed", "expected"),
    [
        (True, True, (True, True)),
        (False, True, (False, True)),
        (True, False, (False, False)),
        (False, False, (False, False)),
    ],
)
async def test_library_null_hash_is_unknown_without_filesystem_read(
    declared, hashed, expected, committing_client, db_session, tmp_path, monkeypatch
):
    from backend.app.services import library_file_runtime

    def no_read(*_args, **_kwargs):
        raise AssertionError("the answer reads no file")

    monkeypatch.setattr(library_file_runtime.runtime, "hash", no_read)
    monkeypatch.setattr(library_file_runtime.runtime, "prepare", no_read)
    # The file is not even there: whatever the answer is, it comes off the row.
    row = await a_library_file(
        db_session, tmp_path / "gone" / "x.3mf", declared=declared, file_hash=("ab" * 32) if hashed else None
    )

    listed = await committing_client.get("/api/v1/library/files")
    assert listed.status_code == 200, listed.text
    (item,) = [f for f in listed.json() if f["id"] == row.id]
    detail = await committing_client.get(f"/api/v1/library/files/{row.id}")
    assert detail.status_code == 200, detail.text

    assert (wire(item), wire(detail.json())) == (expected, expected)


# --- queue copy source ----------------------------------------------------------------------------------------------


async def a_queue(db, printer_factory) -> PrinterQueue:
    printer = await printer_factory()
    queue = await db.get(PrinterQueue, printer.id)
    if queue is None:
        queue = PrinterQueue(id=printer.id, printer_id=printer.id, status="idle")
        db.add(queue)
        await db.commit()
    return queue


async def a_captured_job(sessions, db, queue: PrinterQueue, *, library_file=None, archive=None) -> PrintQueueItem:
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


async def test_copy_source_returns_own_fact_for_edit(
    committing_client, db_session, tmp_path, printer_factory, archive_factory, sessions
):
    queue = await a_queue(db_session, printer_factory)
    # A file whose name says swap and whose declaration says no: the job captured the declaration.
    path = tmp_path / "lib" / "plate.swap.3mf"
    raw = make_3mf(path, "declared-false")
    source = await a_library_file(db_session, path, declared=False, file_hash=sha(raw))
    job = await a_captured_job(sessions, db_session, queue, library_file=source)

    answer = await committing_client.get(f"/api/v1/queue/{job.id}/copy-source")
    assert answer.status_code == 200, answer.text
    assert wire(answer.json()) == (False, True)

    # The live row changes its answer, then goes: the job's copy source does not follow.
    source.swap_compatible = True
    await db_session.commit()
    assert wire((await committing_client.get(f"/api/v1/queue/{job.id}/copy-source")).json()) == (False, True)
    await db_session.delete(source)
    await db_session.commit()
    assert wire((await committing_client.get(f"/api/v1/queue/{job.id}/copy-source")).json()) == (False, True)

    # A job captured from an archive with no declaration is unknown, not False.
    archived = tmp_path / "arc" / "plain.3mf"
    archived_raw = make_3mf(archived, "unknown")
    printer = await printer_factory()
    archive = await archive_factory(
        printer.id, filename=archived.name, file_path=str(archived), source_content_hash=sha(archived_raw)
    )
    unknown_job = await a_captured_job(sessions, db_session, queue, archive=archive)
    answer = await committing_client.get(f"/api/v1/queue/{unknown_job.id}/copy-source")
    assert answer.status_code == 200, answer.text
    assert wire(answer.json()) == (False, False)


# --- what the operator sees of a refusal before dispatch ------------------------------------------------------------


async def test_unknown_refusal_is_visible_and_only_retry_returns_the_job(
    committing_client, db_session, printer_factory, archive_factory, tmp_path, sessions
):
    from datetime import datetime, timezone

    from backend.app.services.filament_deferred import DISPOSITION_FAILED, defer_claim
    from backend.app.services.filament_intake import routing_detail

    queue = await a_queue(db_session, printer_factory)
    path = tmp_path / "arc" / "unknown.3mf"
    raw = make_3mf(path, "refused")
    printer = await printer_factory()
    archive = await archive_factory(printer.id, filename=path.name, file_path=str(path), source_content_hash=sha(raw))
    job = await a_captured_job(sessions, db_session, queue, archive=archive)
    started = datetime.now(timezone.utc)
    job.status, job.started_at = "printing", started
    await db_session.commit()
    assert await defer_claim(
        db_session,
        item_id=job.id,
        started_at=started,
        reason=sc.UNKNOWN_SOURCE_REASON,
        disposition=DISPOSITION_FAILED,
    )
    await db_session.commit()

    shown = (await committing_client.get(f"/api/v1/queue/{job.id}")).json()
    assert shown["status"] == "failed"
    assert shown["error_message"] == routing_detail(sc.UNKNOWN_SOURCE_REASON)["message"]
    # Saving a field is no Retry: a failed job is not edited back into the queue.
    edited = await committing_client.patch(f"/api/v1/queue/{job.id}", json={"manual_start": True})
    assert edited.status_code == 400, edited.text
    assert (await committing_client.get(f"/api/v1/queue/{job.id}")).json()["status"] == "failed"
    # The existing Retry is the one door back.
    retried = await committing_client.post(f"/api/v1/queue/{job.id}/retry")
    assert retried.status_code == 200, retried.text
    assert retried.json()["status"] == "pending"


@pytest.mark.parametrize(
    ("lang", "sentence"),
    [
        ("en", "Copying the source timed out. Check that its storage is available before retrying."),
        ("uk", "Копіювання джерела перевищило час очікування. Перевірте доступність сховища перед повторною спробою."),
    ],
)
async def test_timeout_reason_says_what_r3_1_says(lang, sentence):
    """The reason a timed-out copy fails with claims nothing about the reader having ended (spec r4 §6 R3-1)."""
    from backend.app.i18n import t

    assert t(lang, "filament_routing", "source_copy_timeout") == sentence
