"""A job with no captured source copies it at dispatch -- swap-source-lifecycle spec r4 §6, plan T2.5-T2.8.

A pre-m173 job and a calibration print have no descriptor. Their absence of one is not a known False: right
after the claim and the routing are read, and before any archive, macro or preheat, the dispatcher captures the
UNPATCHED source into staging -- with no transaction open -- and every later read of this attempt (patch,
archive, upload) uses that one copy. The declaration is proved by the hash the worker computed, for calibration
too. A refusal of the copy is answered by its class, never by a string: a busy spool sends a queued job back to
pending, everything else fails before dispatch with a manual Retry, and a timeout is never retried by itself.

Everything here drives the real scheduler, the real runners and the real capture worker; only device I/O is
mocked. A hung NAS read is a ``threading.Event`` the test releases.
"""

from __future__ import annotations

import asyncio
import hashlib
import threading
import time
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.core.config import settings
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer_queue import PrinterQueue
from backend.app.services import queue_sources, swap_compatibility as sc
from backend.app.services.filament_intake import routing_detail
from backend.tests.integration.test_dispatch_without_original import (
    a_sliced_file,
    an_archive_source,
    dispatch_mocks,
    drain,
    forbid_reads,
    scheduler_with_captured_dispatch,
)
from backend.tests.integration.test_filament_routing_dispatch import setup_source

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def clean_spool_state():
    from backend.app.services.printer_manager import printer_manager

    queue_sources._reset_state()
    # Same as the sibling dispatch suite: a run binding left by an earlier test's synthetic dispatch would veto
    # this one's for the wrong reason.
    for attribute in (
        "_print_run_bindings",
        "_print_run_finishing_bindings",
        "_print_start_resolutions",
        "_pending_print_terminals",
    ):
        registry = getattr(printer_manager, attribute, None)
        if isinstance(registry, dict):
            registry.clear()
    # A plate-clear gate another module armed on the process-wide manager would park these printers.
    printer_manager._awaiting_plate_clear.clear()
    gates: list[threading.Event] = []
    yield gates
    for gate in gates:
        gate.set()
    deadline = time.monotonic() + 10
    while queue_sources.active_captures() and time.monotonic() < deadline:  # pragma: no cover - drain
        time.sleep(0.01)
    queue_sources._reset_state()


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def staged_parts() -> list[Path]:
    root = queue_sources.staging_root()
    return sorted(root.glob("*.part")) if root.exists() else []


async def wait_for(predicate, *, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:  # pragma: no cover - a failed wait fails the test below
            raise AssertionError("condition never became true")
        await asyncio.sleep(0.005)


async def a_library_file(db, tmp_path, *, name="legacy.gcode.3mf", declared=False, hashed=True, **columns):
    path = a_sliced_file(tmp_path / name)
    row = LibraryFile(
        filename=path.name,
        file_path=str(path),
        file_size=path.stat().st_size,
        file_type="gcode",
        file_hash=sha(path) if hashed else None,
        swap_compatible=declared,
        **columns,
    )
    db.add(row)
    await db.commit()
    return row


async def a_legacy_job(db, queue, *, printer_id, library_file=None, archive=None, **columns) -> PrintQueueItem:
    """A row from before m173: it names its original and owns no captured bytes."""
    from backend.app.services.filament_policy_write import prepare_routing

    routing, plate = await prepare_routing(
        db,
        printer_id=printer_id,
        library_file_id=library_file.id if library_file is not None else None,
        archive_id=archive.id if archive is not None else None,
    )
    item = PrintQueueItem(
        queue_id=queue.id,
        library_file_id=library_file.id if library_file is not None else None,
        archive_id=archive.id if archive is not None else None,
        filament_routing=routing,
        plate_id=plate,
        status="pending",
        **{"position": 1, **columns},
    )
    db.add(item)
    await db.commit()
    assert item.queue_source_id is None
    return item


class Harness:
    """The real scheduler and dispatcher with device I/O mocked, and probes on the capture."""

    def __init__(self, monkeypatch, test_engine, *, upload=None):
        import backend.app.services.background_dispatch as bd

        self.bd = bd
        self.factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
        self.uploads: list[tuple[str, str]] = []
        self.upload_paths: list[Path] = []
        self.upload_hook = None

        async def recording_upload(ip_address, access_code, path, remote_filename, *args, **kwargs):
            self.uploads.append((sha(Path(path)), remote_filename))
            self.upload_paths.append(Path(path))
            if self.upload_hook is not None:
                await self.upload_hook(Path(path))
            return True

        self.service = dispatch_mocks(monkeypatch, self.factory, upload=upload or recording_upload)
        self.sources: list = []
        real_step = self.service._capture_descriptorless_source

        async def recording_step(db, job, pins):
            await real_step(db, job, pins)
            self.sources.append(job.source)

        monkeypatch.setattr(self.service, "_capture_descriptorless_source", recording_step)
        self.captures: list[Path] = []
        self.after_capture = None
        real_capture = queue_sources.capture

        async def recording_capture(request):
            self.captures.append(request.path)
            receipt = await real_capture(request)
            if self.after_capture is not None:
                await self.after_capture(request, receipt)
            return receipt

        monkeypatch.setattr(queue_sources, "capture", recording_capture)
        self.scheduler, self.spawned = scheduler_with_captured_dispatch(monkeypatch)

    async def tick(self) -> int:
        await self.scheduler.check_queue()
        return await drain(self.spawned)


def gate_reads_of(monkeypatch, gates: list[threading.Event], path: Path) -> threading.Event:
    """Every read of ``path`` by a capture worker hangs until the returned event is set -- a dead NAS."""
    release = threading.Event()
    gates.append(release)
    real_open = queue_sources._open_source
    target = str(path)

    class Hung:
        def __init__(self, inner):
            self.inner = inner

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            self.inner.close()

        def read(self, size):
            release.wait(30)
            return self.inner.read(size)

    monkeypatch.setattr(
        queue_sources,
        "_open_source",
        lambda candidate: Hung(real_open(candidate)) if str(candidate) == target else real_open(candidate),
    )
    return release


async def reload(db, item) -> PrintQueueItem:
    return await db.get(PrintQueueItem, item.id, populate_existing=True)


async def queue_row(db, queue) -> PrinterQueue:
    return await db.get(PrinterQueue, queue.id, populate_existing=True)


# --- one copy for every reader of the attempt (§6) ------------------------------------------------------------------


@pytest.mark.parametrize("kind", ["library", "archive"])
async def test_transient_capture_is_the_only_source_of_archive_and_upload(
    kind, db_session, test_engine, tmp_path, printer_factory, monkeypatch
):
    _unused, printer, queue, mqtt = await setup_source(db_session, tmp_path, printer_factory, monkeypatch)
    settings.archive_dir.mkdir(parents=True, exist_ok=True)
    if kind == "library":
        source = await a_library_file(db_session, tmp_path)
        original = Path(source.file_path)
        item = await a_legacy_job(db_session, queue, printer_id=printer.id, library_file=source)
    else:
        source = await an_archive_source(db_session, tmp_path, printer.id)
        original = settings.base_dir / source.file_path
        item = await a_legacy_job(db_session, queue, printer_id=printer.id, archive=source)
    captured_hash = sha(original)
    harness = Harness(monkeypatch, test_engine)
    touched: list[str] = []

    async def replace_original_then_forbid_it(request, receipt):
        # The share changes the instant the copy is taken; from here on, nothing may read it -- not the
        # patcher, the archive, the upload, nor the routing guard's own re-probe.
        a_sliced_file(original.with_name("other.gcode.3mf")).replace(original)
        touched.extend(forbid_reads(monkeypatch, original))

    if kind == "library":
        harness.after_capture = replace_original_then_forbid_it
    # An archive's own file is the archive store, which ``archive_print`` reuses by hash on purpose; what this
    # attempt READS is still the copy.

    assert await harness.tick() == 1

    assert harness.captures == [original]
    assert touched == []
    assert harness.uploads and harness.uploads[0][0] == captured_hash
    assert all(path != original for path in harness.upload_paths)
    item = await reload(db_session, item)
    archive = await db_session.get(PrintArchive, item.archive_id)
    assert archive.source_content_hash == captured_hash
    assert sha(settings.base_dir / archive.file_path) == captured_hash
    assert not archive.file_path.endswith(".part")  # stored under the human name, not the staging token
    assert staged_parts() == []
    mqtt._client.publish.assert_called()


async def test_descriptorless_missing_hash_is_unknown(db_session, test_engine, tmp_path, printer_factory, monkeypatch):
    _unused, printer, queue, mqtt = await setup_source(db_session, tmp_path, printer_factory, monkeypatch)
    settings.archive_dir.mkdir(parents=True, exist_ok=True)
    source = await a_library_file(db_session, tmp_path, declared=False, hashed=False)
    await a_legacy_job(db_session, queue, printer_id=printer.id, library_file=source)
    harness = Harness(monkeypatch, test_engine)

    assert await harness.tick() == 1

    # No hash, no proof: the absence of a descriptor is not a known False -- and it does not stop the print.
    assert [source.swap_fact for source in harness.sources] == [sc.SourceFact(None, "hash_missing")]
    mqtt._client.publish.assert_called()


@pytest.mark.parametrize("tampered", [False, True])
async def test_calibration_proves_generated_false_by_hash(
    tampered, db_session, test_engine, tmp_path, printer_factory, monkeypatch
):
    _unused, printer, queue, mqtt = await setup_source(db_session, tmp_path, printer_factory, monkeypatch)
    settings.archive_dir.mkdir(parents=True, exist_ok=True)
    # What calibration_service writes: a sliced row of BamDude's own, False, with its hash.
    generated = await a_library_file(db_session, tmp_path, name="cali.gcode.3mf", declared=False, source_type="sliced")
    if tampered:
        generated.file_hash = "0" * 64
        await db_session.commit()
    await a_legacy_job(db_session, queue, printer_id=printer.id, library_file=generated, is_calibration=True)
    harness = Harness(monkeypatch, test_engine)

    assert await harness.tick() == 1

    expected = sc.SourceFact(None, "hash_mismatch") if tampered else sc.SourceFact(False)
    assert [source.swap_fact for source in harness.sources] == [expected]


# --- the staged copy's owner (§6) -----------------------------------------------------------------------------------


async def test_transient_capture_releases_after_readers_on_failure_and_cancel(
    db_session, test_engine, tmp_path, printer_factory, monkeypatch
):
    _unused, printer, queue, mqtt = await setup_source(db_session, tmp_path, printer_factory, monkeypatch)
    settings.archive_dir.mkdir(parents=True, exist_ok=True)
    source = await a_library_file(db_session, tmp_path)
    await a_legacy_job(db_session, queue, printer_id=printer.id, library_file=source)
    harness = Harness(monkeypatch, test_engine)
    seen_during_upload: list[bool] = []

    async def failing_upload(path):
        seen_during_upload.append(path.exists())
        raise RuntimeError("the printer dropped the connection")

    harness.upload_hook = failing_upload
    await harness.tick()

    assert seen_during_upload == [True]  # the readers had the copy for as long as they read
    assert staged_parts() == []
    assert queue_sources.pinned_staging_paths() == frozenset()

    # And cancelled in the middle of a reader: the stack still owns, and drops, the copy.
    second = await a_library_file(db_session, tmp_path, name="second.gcode.3mf")
    item = (await db_session.execute(select(PrintQueueItem))).scalar_one()
    await db_session.delete(item)
    await db_session.commit()
    queue_now = await queue_row(db_session, queue)
    queue_now.status, queue_now.current_item_id = "idle", None
    await db_session.commit()
    await a_legacy_job(db_session, queue, printer_id=printer.id, library_file=second)
    reading = asyncio.Event()

    async def hanging_upload(path):
        reading.set()
        await asyncio.Event().wait()

    harness.upload_hook = hanging_upload
    await harness.scheduler.check_queue()
    tasks = [asyncio.ensure_future(coroutine) for coroutine in harness.spawned]
    harness.spawned.clear()
    await asyncio.wait_for(reading.wait(), 10)
    assert len(staged_parts()) == 1
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)

    await wait_for(lambda: staged_parts() == [])
    assert queue_sources.pinned_staging_paths() == frozenset()


@pytest.mark.parametrize("change", ["cancelled", "repointed"])
async def test_claim_or_source_change_during_capture_cannot_dispatch(
    change, db_session, test_engine, tmp_path, printer_factory, monkeypatch
):
    _unused, printer, queue, mqtt = await setup_source(db_session, tmp_path, printer_factory, monkeypatch)
    settings.archive_dir.mkdir(parents=True, exist_ok=True)
    source = await a_library_file(db_session, tmp_path)
    other = await a_library_file(db_session, tmp_path, name="other.gcode.3mf")
    item = await a_legacy_job(db_session, queue, printer_id=printer.id, library_file=source)
    harness = Harness(monkeypatch, test_engine)

    async def operator_acts(request, receipt):
        async with harness.factory() as db:
            row = await db.get(PrintQueueItem, item.id)
            if change == "cancelled":
                row.status = "cancelled"
            else:
                row.library_file_id = other.id
            await db.commit()

    harness.after_capture = operator_acts
    await harness.tick()

    assert harness.uploads == []
    mqtt._client.publish.assert_not_called()
    assert (await db_session.execute(select(PrintArchive))).scalars().all() == []
    assert staged_parts() == []
    row = await reload(db_session, item)
    if change == "cancelled":
        assert row.status == "cancelled"  # the CAS never writes over the operator's cancellation


# --- what a refused copy does (§6 table) ----------------------------------------------------------------------------

CAPTURE_REFUSALS = [
    (queue_sources.QueueSourceBusy, "pending"),
    (queue_sources.StorageReplaced, "pending"),
    (queue_sources.CaptureTimeout, "failed"),
    (queue_sources.SourceUnreadable, "failed"),
    (queue_sources.SourceChanged, "failed"),
    (queue_sources.SourceInvalid, "failed"),
    (queue_sources.NoSpace, "failed"),
    (queue_sources.WriteFailed, "failed"),
    (queue_sources.QueueSourceError, "failed"),
]


@pytest.mark.parametrize(("error", "status"), CAPTURE_REFUSALS, ids=lambda value: getattr(value, "__name__", value))
async def test_dispatch_capture_error_dispositions(
    error, status, db_session, test_engine, tmp_path, printer_factory, monkeypatch
):
    _unused, printer, queue, mqtt = await setup_source(db_session, tmp_path, printer_factory, monkeypatch)
    settings.archive_dir.mkdir(parents=True, exist_ok=True)
    source = await a_library_file(db_session, tmp_path)
    item = await a_legacy_job(db_session, queue, printer_id=printer.id, library_file=source)
    harness = Harness(monkeypatch, test_engine)

    async def refused(request):
        raise error("synthetic")

    monkeypatch.setattr(queue_sources, "capture", refused)
    await harness.tick()

    row = await reload(db_session, item)
    message = routing_detail(error.reason)["message"]
    assert row.status == status
    assert row.started_at is None
    if status == "pending":
        assert row.waiting_reason_code == "source_capture"
        assert row.waiting_reason == message
        assert row.error_message is None
    else:
        assert row.error_message == message
        assert row.gate_acknowledged is True  # no physical failure for the next job's gate
        assert row.waiting_reason is None and row.waiting_reason_code is None
    assert row.library_file_id == source.id  # bytes, source and options untouched
    claim = await queue_row(db_session, queue)
    # A copy that will be retried later leaves the queue to the jobs behind it; one that ENDED the
    # claimed attempt halts the printer's queue until Resume (post-rebuild D-R4).
    assert claim.status == ("idle" if status == "pending" else "error") and claim.current_item_id is None
    if status == "pending":
        assert row.dispatch_attempts == 0  # a refusal before publish gives its attempt back
    else:
        assert row.error_code == "dispatchSourceUnavailable"
    assert (await db_session.execute(select(PrintArchive))).scalars().all() == []
    mqtt._client.publish.assert_not_called()


@pytest.mark.parametrize(("error", "status"), CAPTURE_REFUSALS, ids=lambda value: getattr(value, "__name__", value))
def test_a_direct_job_never_waits_for_its_copy(error, status):
    """Direct (and calibration direct) answer every refused copy with a failure and a manual Retry.

    Every direct print is captured at submit, so no direct job reaches the runner without a descriptor today;
    the mapping is pinned here so that one that ever does is not retried by itself.
    """
    from backend.app.services.filament_deferred import DISPOSITION_FAILED, DISPOSITION_RETRY_LATER, capture_refusal

    assert capture_refusal(error("x"), queued=False).disposition == DISPOSITION_FAILED
    queued = capture_refusal(error("x"), queued=True)
    assert queued.reason == error.reason
    assert queued.disposition == (DISPOSITION_RETRY_LATER if status == "pending" else DISPOSITION_FAILED)


@pytest.mark.parametrize(
    ("error", "status"), [(queue_sources.QueueSourceBusy, "pending"), (queue_sources.NoSpace, "failed")]
)
async def test_calibration_capture_busy_and_no_space_release_own_claim(
    error, status, db_session, test_engine, tmp_path, printer_factory, monkeypatch
):
    _unused, printer, queue, mqtt = await setup_source(db_session, tmp_path, printer_factory, monkeypatch)
    settings.archive_dir.mkdir(parents=True, exist_ok=True)
    other_printer = await printer_factory(model="P1P")
    other_queue = PrinterQueue(
        id=other_printer.id, printer_id=other_printer.id, status="printing", current_item_id=None
    )
    db_session.add(other_queue)
    await db_session.commit()
    generated = await a_library_file(db_session, tmp_path, name="cali.gcode.3mf", source_type="sliced")
    item = await a_legacy_job(db_session, queue, printer_id=printer.id, library_file=generated, is_calibration=True)
    harness = Harness(monkeypatch, test_engine)

    async def refused(request):
        raise error("synthetic")

    monkeypatch.setattr(queue_sources, "capture", refused)
    await harness.tick()

    assert (await reload(db_session, item)).status == status
    assert (await queue_row(db_session, queue)).status == ("idle" if status == "pending" else "error")
    assert (await queue_row(db_session, other_queue)).status == "printing"  # only its own claim


# --- bounded waiting: the deadline, the hung reader, no automatic retry (§6, R3-1) ----------------------------------


async def test_dispatch_capture_has_wall_clock_deadline_without_open_transaction(
    db_session, test_engine, tmp_path, printer_factory, monkeypatch, clean_spool_state
):
    import backend.app.services.background_dispatch as bd
    import backend.app.services.print_scheduler as ps

    _unused, printer, queue, mqtt = await setup_source(db_session, tmp_path, printer_factory, monkeypatch)
    settings.archive_dir.mkdir(parents=True, exist_ok=True)
    source = await a_library_file(db_session, tmp_path)
    item = await a_legacy_job(db_session, queue, printer_id=printer.id, library_file=source)
    harness = Harness(monkeypatch, test_engine)
    opened: list[AsyncSession] = []

    def recording_factory():
        session = harness.factory()
        opened.append(session)
        return session

    monkeypatch.setattr(bd, "async_session", recording_factory)
    monkeypatch.setattr(ps, "async_session", recording_factory)
    monkeypatch.setattr(bd, "DISPATCH_CAPTURE_DEADLINE_SECONDS", 0.3)
    gate_reads_of(monkeypatch, clean_spool_state, Path(source.file_path))
    open_during_capture: list[bool] = []
    real_capture = queue_sources.capture

    async def watching(request):
        open_during_capture.append(any(session.in_transaction() for session in opened))
        return await real_capture(request)

    monkeypatch.setattr(queue_sources, "capture", watching)
    started = time.monotonic()
    await harness.tick()

    assert time.monotonic() - started < 10  # the deadline, not the 60 s no-progress bound
    assert open_during_capture == [False]
    row = await reload(db_session, item)
    assert row.status == "failed"
    assert row.error_message == routing_detail("source_copy_timeout")["message"]


async def test_timed_out_capture_keeps_worker_slot_but_releases_printer_claim(
    db_session, test_engine, tmp_path, printer_factory, monkeypatch, clean_spool_state
):
    import backend.app.services.background_dispatch as bd

    _unused, printer, queue, mqtt = await setup_source(db_session, tmp_path, printer_factory, monkeypatch)
    settings.archive_dir.mkdir(parents=True, exist_ok=True)
    source = await a_library_file(db_session, tmp_path)
    item = await a_legacy_job(db_session, queue, printer_id=printer.id, library_file=source)
    harness = Harness(monkeypatch, test_engine)
    preheat = AsyncMock()
    monkeypatch.setattr("backend.app.services.preheat.preheat_and_soak", preheat)
    monkeypatch.setattr(bd, "DISPATCH_CAPTURE_DEADLINE_SECONDS", 0.3)
    release = gate_reads_of(monkeypatch, clean_spool_state, Path(source.file_path))

    await harness.tick()

    row = await reload(db_session, item)
    assert row.status == "failed" and row.gate_acknowledged is True
    # The claimed attempt ended: the printer's queue waits for Resume (post-rebuild D-R4).
    assert (await queue_row(db_session, queue)).status == "error"
    # The hung reader is not declared finished: it keeps its slot and its staging.
    assert queue_sources.active_captures() == 1
    assert len(staged_parts()) == 1
    mqtt._client.publish.assert_not_called()
    preheat.assert_not_called()
    assert (await db_session.execute(select(PrintArchive))).scalars().all() == []

    release.set()
    await wait_for(lambda: queue_sources.active_captures() == 0)
    assert staged_parts() == []  # the late result was cleaned up by its own worker
    assert queue_sources.pinned_staging_paths() == frozenset()
    assert (await reload(db_session, item)).status == "failed"


async def test_capture_cancel_does_not_join_blocked_reader_or_revive_cancelled_job(
    db_session, test_engine, tmp_path, printer_factory, monkeypatch, clean_spool_state
):
    import backend.app.services.background_dispatch as bd

    _unused, printer, queue, mqtt = await setup_source(db_session, tmp_path, printer_factory, monkeypatch)
    settings.archive_dir.mkdir(parents=True, exist_ok=True)
    source = await a_library_file(db_session, tmp_path)
    item = await a_legacy_job(db_session, queue, printer_id=printer.id, library_file=source)
    harness = Harness(monkeypatch, test_engine)
    monkeypatch.setattr(bd, "DISPATCH_CAPTURE_DEADLINE_SECONDS", 0.5)
    release = gate_reads_of(monkeypatch, clean_spool_state, Path(source.file_path))

    # A shutdown cancels the dispatch while the reader hangs: it returns at once and leaves the reader alone.
    await harness.scheduler.check_queue()
    tasks = [asyncio.ensure_future(coroutine) for coroutine in harness.spawned]
    harness.spawned.clear()
    await wait_for(lambda: queue_sources.active_captures() == 1)
    started = time.monotonic()
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    assert time.monotonic() - started < 2
    assert queue_sources.active_captures() == 1

    # The operator cancelled the job while a second attempt's copy hung; the timeout must not revive it.
    release.set()
    await wait_for(lambda: queue_sources.active_captures() == 0)
    async with harness.factory() as db:
        row = await db.get(PrintQueueItem, item.id)
        row.status, row.started_at = "pending", None
        claim = await db.get(PrinterQueue, queue.id)
        claim.status, claim.current_item_id = "idle", None
        await db.commit()
    second_release = gate_reads_of(monkeypatch, clean_spool_state, Path(source.file_path))
    await harness.scheduler.check_queue()
    dispatch = [asyncio.ensure_future(coroutine) for coroutine in harness.spawned]
    harness.spawned.clear()
    await wait_for(lambda: queue_sources.active_captures() == 1)
    async with harness.factory() as db:
        row = await db.get(PrintQueueItem, item.id)
        row.status = "cancelled"
        await db.commit()
    await asyncio.gather(*dispatch)
    assert (await reload(db_session, item)).status == "cancelled"
    second_release.set()
    await wait_for(lambda: queue_sources.active_captures() == 0)
    assert (await reload(db_session, item)).status == "cancelled"
    mqtt._client.publish.assert_not_called()


async def test_capture_timeout_never_auto_retries_or_exhausts_other_slot(
    db_session, test_engine, tmp_path, printer_factory, monkeypatch, clean_spool_state
):
    import backend.app.services.background_dispatch as bd

    _unused, printer, queue, mqtt = await setup_source(db_session, tmp_path, printer_factory, monkeypatch)
    settings.archive_dir.mkdir(parents=True, exist_ok=True)
    hung = await a_library_file(db_session, tmp_path, name="on-the-dead-nas.gcode.3mf")
    item = await a_legacy_job(db_session, queue, printer_id=printer.id, library_file=hung)
    harness = Harness(monkeypatch, test_engine)
    monkeypatch.setattr(bd, "DISPATCH_CAPTURE_DEADLINE_SECONDS", 0.3)
    gate_reads_of(monkeypatch, clean_spool_state, Path(hung.file_path))

    await harness.tick()
    assert (await reload(db_session, item)).status == "failed"
    for _ in range(3):  # well past any cooldown: a failed job is not picked up again
        await harness.tick()
    assert harness.captures.count(Path(hung.file_path)) == 1
    assert queue_sources.active_captures() == 1  # the first reader still hangs, in ONE slot

    # An unrelated job on another printer copies through the second slot meanwhile.
    from backend.app.services.printer_manager import printer_manager

    second_printer = await printer_factory(model="P1P")
    second_queue = PrinterQueue(id=second_printer.id, printer_id=second_printer.id, auto_distribute_eligible=True)
    db_session.add(second_queue)
    await db_session.commit()
    monkeypatch.setitem(printer_manager._clients, second_printer.id, mqtt)
    monkeypatch.setitem(printer_manager._models, second_printer.id, "P1P")
    healthy = await a_library_file(db_session, tmp_path, name="healthy.gcode.3mf")
    other = await a_legacy_job(db_session, second_queue, printer_id=second_printer.id, library_file=healthy)

    await harness.tick()

    assert harness.captures.count(Path(healthy.file_path)) == 1
    assert (await reload(db_session, other)).status == "printing"
    assert harness.captures.count(Path(hung.file_path)) == 1
    assert (await reload(db_session, item)).status == "failed"


async def test_capture_timeout_stays_failed_after_scheduler_restart_until_retry(
    db_session, test_engine, tmp_path, printer_factory, monkeypatch, clean_spool_state
):
    import backend.app.services.background_dispatch as bd
    from backend.app.api.routes.print_queue import retry_failed_item

    _unused, printer, queue, mqtt = await setup_source(db_session, tmp_path, printer_factory, monkeypatch)
    settings.archive_dir.mkdir(parents=True, exist_ok=True)
    source = await a_library_file(db_session, tmp_path)
    item = await a_legacy_job(db_session, queue, printer_id=printer.id, library_file=source)
    harness = Harness(monkeypatch, test_engine)
    monkeypatch.setattr(bd, "DISPATCH_CAPTURE_DEADLINE_SECONDS", 0.3)
    release = gate_reads_of(monkeypatch, clean_spool_state, Path(source.file_path))
    await harness.tick()
    assert (await reload(db_session, item)).status == "failed"
    release.set()
    await wait_for(lambda: queue_sources.active_captures() == 0)

    # A restarted scheduler has no memory of the timeout, and needs none: the row itself is failed.
    harness.scheduler, harness.spawned = scheduler_with_captured_dispatch(monkeypatch)
    await harness.tick()
    assert (await reload(db_session, item)).status == "failed"
    assert len(harness.captures) == 1

    # Only the operator's Retry brings it back -- and the queue's Resume lets it go: a Retry alone
    # leaves the halted queue halted (owner, post-rebuild D-R4).
    await retry_failed_item(item.id, db=db_session, _=None)
    await harness.tick()
    assert len(harness.captures) == 1
    assert (await reload(db_session, item)).status == "pending"
    halted = await queue_row(db_session, queue)
    assert halted.status == "error"
    halted.status = "idle"
    await db_session.commit()
    await harness.tick()
    assert len(harness.captures) == 2
    assert (await reload(db_session, item)).status == "printing"
    mqtt._client.publish.assert_called()


async def test_a_copy_of_another_revision_than_preflight_read_is_a_changed_source(
    db_session, test_engine, tmp_path, printer_factory, monkeypatch
):
    """The plan was made from the original as preflight read it. A copy of a later revision is other bytes."""
    _unused, printer, queue, mqtt = await setup_source(db_session, tmp_path, printer_factory, monkeypatch)
    settings.archive_dir.mkdir(parents=True, exist_ok=True)
    source = await a_library_file(db_session, tmp_path)
    original = Path(source.file_path)
    item = await a_legacy_job(db_session, queue, printer_id=printer.id, library_file=source)
    harness = Harness(monkeypatch, test_engine)
    real_capture = queue_sources.capture

    async def changed_before_the_copy(request):
        harness.captures.append(request.path)
        a_sliced_file(original.with_name("newer.gcode.3mf")).replace(original)
        return await real_capture(request)

    monkeypatch.setattr(queue_sources, "capture", changed_before_the_copy)
    await harness.tick()

    assert harness.uploads == []
    mqtt._client.publish.assert_not_called()
    row = await reload(db_session, item)
    assert row.status == "pending"  # planned again next time, from the bytes that are there now
    assert row.waiting_reason == routing_detail("source_changed")["message"]
    assert staged_parts() == []


async def test_an_archive_of_a_staged_copy_still_refuses_a_corrupted_store_copy(
    db_session, printer_factory, monkeypatch
):
    """The staged copy is ``<token>.part``; the ZIP check after the archive copy reads the name it is stored under."""
    import backend.app.services.archive as archive_module
    from backend.app.services.archive import ArchiveService

    printer = await printer_factory()
    settings.archive_dir.mkdir(parents=True, exist_ok=True)
    staging = queue_sources.staging_root()
    staging.mkdir(parents=True, exist_ok=True)
    part = a_sliced_file(staging / "0123456789abcdef.gcode.3mf").rename(staging / "0123456789abcdef.part")

    def truncating_copy(source, destination):
        Path(destination).write_bytes(b"PK\x03\x04 truncated")

    monkeypatch.setattr(archive_module, "_copy_and_fsync", truncating_copy)
    archive = await ArchiveService(db_session).archive_print(
        printer_id=printer.id,
        source_file=part,
        original_filename="lamp.gcode.3mf",
        stored_filename="lamp.gcode.3mf",
        source_content_hash=sha(part),
        print_data={"status": "printing"},
    )

    assert archive is None
    assert (await db_session.execute(select(PrintArchive))).scalars().all() == []


# --- a busy spool: the bounded, in-memory retry of a queued job (§6, T4.6a) -----------------------------------------


def busy_for(monkeypatch, harness, path: Path):
    """Every copy of ``path`` finds the spool busy; anything else copies normally."""
    real = queue_sources.capture

    async def maybe_busy(request):
        if request.path == path:
            harness.captures.append(request.path)
            raise queue_sources.QueueSourceBusy("synthetic")
        return await real(request)

    monkeypatch.setattr(queue_sources, "capture", maybe_busy)


async def test_capture_retry_cooldown_is_respected_by_tick_and_final_claim(
    db_session, test_engine, tmp_path, printer_factory, monkeypatch
):
    _unused, printer, queue, mqtt = await setup_source(db_session, tmp_path, printer_factory, monkeypatch)
    settings.archive_dir.mkdir(parents=True, exist_ok=True)
    first = await a_library_file(db_session, tmp_path, name="first.gcode.3mf")
    second = await a_library_file(db_session, tmp_path, name="second.gcode.3mf")
    stuck = await a_legacy_job(db_session, queue, printer_id=printer.id, library_file=first)
    behind = await a_legacy_job(db_session, queue, printer_id=printer.id, library_file=second, position=2)
    harness = Harness(monkeypatch, test_engine)
    busy_for(monkeypatch, harness, Path(first.file_path))

    await harness.tick()
    row = await reload(db_session, stuck)
    assert row.status == "pending" and row.waiting_reason_code == "source_capture"

    # Within the cooldown the stuck job is passed over -- by the selection AND by the final first-runnable
    # check under the claim, or its neighbour would be refused as "not first" -- and the neighbour starts.
    await harness.tick()
    assert harness.captures.count(Path(first.file_path)) == 1
    assert (await reload(db_session, behind)).status == "printing"


async def test_capture_cooldown_skips_only_own_item_and_preserves_schedule(
    db_session, test_engine, tmp_path, printer_factory, monkeypatch
):
    _unused, printer, queue, mqtt = await setup_source(db_session, tmp_path, printer_factory, monkeypatch)
    settings.archive_dir.mkdir(parents=True, exist_ok=True)
    source = await a_library_file(db_session, tmp_path)
    stuck = await a_legacy_job(
        db_session,
        queue,
        printer_id=printer.id,
        library_file=source,
        execute_swap_macros=True,
        swap_macro_events='["swap_mode_start"]',
    )
    harness = Harness(monkeypatch, test_engine)
    busy_for(monkeypatch, harness, Path(source.file_path))

    await harness.tick()

    row = await reload(db_session, stuck)
    assert row.status == "pending"
    # Nothing about the job is rewritten to wait: not its schedule, not its start mode, not what it asked for.
    assert row.scheduled_time is None and row.manual_start is False
    assert row.execute_swap_macros is True and row.swap_macro_events == '["swap_mode_start"]'
    assert row.library_file_id == source.id
    assert stuck.id in harness.scheduler._capture_cooldowns


async def test_stale_failure_cannot_cooldown_a_newer_attempt(
    db_session, test_engine, tmp_path, printer_factory, monkeypatch
):
    """The refusal arrives after the operator cancelled the attempt: the CAS fails, and no cooldown is set."""
    _unused, printer, queue, mqtt = await setup_source(db_session, tmp_path, printer_factory, monkeypatch)
    settings.archive_dir.mkdir(parents=True, exist_ok=True)
    source = await a_library_file(db_session, tmp_path)
    item = await a_legacy_job(db_session, queue, printer_id=printer.id, library_file=source)
    harness = Harness(monkeypatch, test_engine)

    async def cancelled_then_busy(request):
        async with harness.factory() as db:
            row = await db.get(PrintQueueItem, item.id)
            row.status = "cancelled"
            await db.commit()
        raise queue_sources.QueueSourceBusy("synthetic")

    monkeypatch.setattr(queue_sources, "capture", cancelled_then_busy)
    await harness.tick()

    assert (await reload(db_session, item)).status == "cancelled"
    assert harness.scheduler._capture_cooldowns == {}


async def test_capture_cooldown_cleanup_and_restart_allow_bounded_retry(
    db_session, test_engine, tmp_path, printer_factory, monkeypatch
):
    import backend.app.services.print_scheduler as ps

    _unused, printer, queue, mqtt = await setup_source(db_session, tmp_path, printer_factory, monkeypatch)
    settings.archive_dir.mkdir(parents=True, exist_ok=True)
    source = await a_library_file(db_session, tmp_path)
    stuck = await a_legacy_job(db_session, queue, printer_id=printer.id, library_file=source)
    harness = Harness(monkeypatch, test_engine)
    busy_for(monkeypatch, harness, Path(source.file_path))
    path = Path(source.file_path)

    await harness.tick()
    await harness.tick()
    assert harness.captures.count(path) == 1  # cooling down

    # Past the deadline (moved there by hand -- the loop's own clock is not ours to patch): one new attempt,
    # and the entry is renewed by that attempt, never kept as a log.
    assert harness.scheduler._capture_cooldowns[stuck.id] <= time.monotonic() + ps.CAPTURE_RETRY_COOLDOWN_SECONDS
    harness.scheduler._capture_cooldowns[stuck.id] = time.monotonic() - 1
    await harness.tick()
    assert harness.captures.count(path) == 2
    assert list(harness.scheduler._capture_cooldowns) == [stuck.id]

    # An explicit edit clears it at once.
    harness.scheduler.clear_capture_cooldown(stuck.id)
    await harness.tick()
    assert harness.captures.count(path) == 3

    # A restarted scheduler remembers nothing: one more attempt, bounded by its own new cooldown.
    harness.scheduler, harness.spawned = scheduler_with_captured_dispatch(monkeypatch)
    await harness.tick()
    await harness.tick()
    assert harness.captures.count(path) == 4
