"""Publication of a library preview (spec §5, §4.3; plan A5) on a file-backed database: a typed attach result, the
file type inside the CAS, the authority asked again inside the attach session, the digest bound for STEP, a
publication lease taken in the same synchronous step as the hand-off, a source ENOENT that alone is file_missing,
and a restore that may replace files only after every library preview writer is proven quiet."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

import pytest
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.core.config import settings
from backend.app.models.library import LibraryFile
from backend.app.services import library_preview
from backend.app.services.library_preview import Source, attach, attach_result
from backend.tests.integration.test_library_preview_publication import png, publication_db  # noqa: F401

pytestmark = pytest.mark.integration


async def seed(factory, **changes):
    values = {
        "filename": "part.step",
        "file_path": "library/part.step",
        "file_type": "step",
        "file_size": 1000,
        "file_hash": "a" * 64,
        "thumbnail_path": "library/old.png",
    }
    values.update(changes)
    async with factory() as db:
        row = LibraryFile(**values)
        db.add(row)
        await db.commit()
        return Source.capture(row)


def _pngs():
    return list((settings.library_dir / "thumbnails").glob("*.png"))


# --- the typed attach result ----------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_clean_attach_is_attached_and_the_bool_wrapper_still_answers(publication_db, tmp_path):
    source = await seed(publication_db)
    async with publication_db() as db:
        assert await attach_result(db, source, png(tmp_path)) == "attached"
    second = await seed(publication_db, file_path="library/other.step", file_hash="c" * 64)
    async with publication_db() as db:
        assert await attach(db, second, png(tmp_path)) is True


@pytest.mark.parametrize(
    "change",
    [
        {"deleted_at": datetime(2026, 10, 16)},
        {"file_hash": "b" * 64},
        {"thumbnail_path": "newer.png"},
        {"file_path": "replacement.step"},
        {"file_type": "stl"},  # a type mismatch is a different source, whatever the bytes
        {"purge": True},
    ],
)
@pytest.mark.asyncio
async def test_a_changed_source_is_superseded_and_leaves_no_png(publication_db, tmp_path, change):
    source = await seed(publication_db)
    async with publication_db() as db:
        if change.get("purge"):
            await db.execute(delete(LibraryFile).where(LibraryFile.id == source.id))
        else:
            await db.execute(update(LibraryFile).where(LibraryFile.id == source.id).values(**change))
        await db.commit()
    async with publication_db() as db:
        assert await attach_result(db, source, png(tmp_path)) == "superseded"
    assert not _pngs()


@pytest.mark.asyncio
async def test_an_uncertain_commit_is_unavailable_and_keeps_a_possibly_referenced_png(
    publication_db, tmp_path, monkeypatch
):
    source = await seed(publication_db)

    class LostAck(AsyncSession):
        async def commit(self):
            await super().commit()
            raise OSError("lost commit acknowledgement")

    maker = async_sessionmaker
    monkeypatch.setattr(library_preview, "async_sessionmaker", lambda bind, **kw: maker(bind, class_=LostAck, **kw))
    async with publication_db() as db:
        assert await attach_result(db, source, png(tmp_path)) == "unavailable"
    async with publication_db() as db:
        path = await db.scalar(select(LibraryFile.thumbnail_path).where(LibraryFile.id == source.id))
    assert path != source.thumbnail_path and (settings.base_dir / path).is_file()  # referenced: kept


@pytest.mark.asyncio
async def test_a_png_that_cannot_be_written_is_unavailable_never_file_missing(publication_db, tmp_path):
    source = await seed(publication_db)
    settings.library_dir.mkdir(parents=True, exist_ok=True)
    (settings.library_dir / "thumbnails").write_text("a file where the folder should be", encoding="utf-8")
    async with publication_db() as db:
        assert await attach_result(db, source, png(tmp_path)) == "unavailable"
    async with publication_db() as db:
        row = await db.get(LibraryFile, source.id)
    assert row.thumbnail_path == source.thumbnail_path  # the old picture stays


# --- the authority inside the attach session -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_authority_is_asked_inside_the_attach_transaction_before_the_write(publication_db, tmp_path):
    source = await seed(publication_db)
    seen = {}

    async def authorize(session):
        seen["session"] = session
        seen["thumbnail_then"] = await session.scalar(
            select(LibraryFile.thumbnail_path).where(LibraryFile.id == source.id)
        )
        return True

    async with publication_db() as db:
        assert await attach_result(db, source, png(tmp_path), authorize=authorize) == "attached"
    assert isinstance(seen["session"], AsyncSession)
    assert seen["thumbnail_then"] == source.thumbnail_path  # asked before the row was written


@pytest.mark.asyncio
async def test_an_authority_gone_at_the_attach_writes_nothing_and_leaves_no_png(publication_db, tmp_path):
    source = await seed(publication_db)

    async def refuse(session):
        return False

    async with publication_db() as db:
        assert await attach_result(db, source, png(tmp_path), authorize=refuse) == "authority_missing"
    async with publication_db() as db:
        row = await db.get(LibraryFile, source.id)
    assert row.thumbnail_path == source.thumbnail_path and not _pngs()


# --- generate(): the kind from the type, the digest for STEP ---------------------------------------------------


def _fake_attempt(outcome="render_failed", digest=None, preview: Path | None = None):
    calls = []

    @asynccontextmanager
    async def attempt(inputs, **kwargs):
        from backend.app.services.preview_runtime import PreviewResult

        calls.append((inputs, kwargs))
        result = PreviewResult(outcome=outcome)
        if preview is not None:
            result.files["preview"] = preview
        if digest is not None:
            result.input_digests["mesh"] = digest
        yield result

    return attempt, calls


@pytest.mark.parametrize(("filename", "file_type"), [("renamed.stl", "step"), ("no-extension", "obj")])
@pytest.mark.asyncio
async def test_generate_takes_the_kind_from_the_file_type_never_from_the_name(
    publication_db, monkeypatch, filename, file_type
):
    attempt, calls = _fake_attempt()
    monkeypatch.setattr(library_preview, "preview_attempt", attempt)
    source = await seed(publication_db, filename=filename, file_type=file_type)
    async with publication_db() as db:
        assert await library_preview.generate(db, source) is False
    (inputs, kwargs) = calls[0]
    assert inputs["mesh"][1] == file_type
    assert kwargs.get("publication") is library_preview.publication  # every library attach takes a lease


@pytest.mark.parametrize(("file_hash", "digest"), [("a" * 64, "b" * 64), (None, "a" * 64)])
@pytest.mark.asyncio
async def test_a_step_result_is_attached_only_against_its_own_hash(
    publication_db, tmp_path, monkeypatch, file_hash, digest
):
    attempt, _ = _fake_attempt(outcome="ok", digest=digest, preview=png(tmp_path))
    monkeypatch.setattr(library_preview, "preview_attempt", attempt)
    source = await seed(publication_db, file_hash=file_hash)
    async with publication_db() as db:
        assert await library_preview.generate(db, source) is False  # never attached without equality
    async with publication_db() as db:
        row = await db.get(LibraryFile, source.id)
    assert row.thumbnail_path == source.thumbnail_path and not _pngs()


# --- the publication lease on the real chain (STL) --------------------------------------------------------------


def _box() -> bytes:
    import trimesh

    return trimesh.creation.box().export(file_type="stl")


@pytest.fixture
async def runtime(tmp_path):
    from backend.app.services.preview_runtime import PreviewRuntime

    rt = PreviewRuntime(tmp_path / "preview")
    await rt.start()
    assert rt.ready
    try:
        yield rt
    finally:
        await rt.stop()


@pytest.mark.asyncio
async def test_a_closed_gate_revokes_the_result_at_its_hand_off(runtime):
    from backend.app.services.library_preview import PublicationGate

    gate = PublicationGate()
    gate.close()
    async with runtime.attempt({"mesh": (_box(), "stl")}, publication=gate) as result:
        assert result.outcome == "preempted" and not result.files  # nothing to publish, nothing published
    assert gate.leases == 0


@pytest.mark.asyncio
async def test_a_lease_is_held_through_the_callers_publication_and_released_after(runtime):
    from backend.app.services.library_preview import PublicationGate

    gate = PublicationGate()
    async with runtime.attempt({"mesh": (_box(), "stl")}, publication=gate) as result:
        assert result.outcome == "ok" and gate.leases == 1
    assert gate.leases == 0


@pytest.mark.asyncio
async def test_a_lease_never_outlives_a_hand_off_the_revoke_won(runtime, monkeypatch):
    from backend.app.services.library_preview import PublicationGate

    gate = PublicationGate()
    monkeypatch.setattr(runtime.slot, "hand_off", lambda ticket: False)  # the revoke came first
    async with runtime.attempt({"mesh": (_box(), "stl")}, publication=gate) as result:
        assert result.outcome == "preempted"
        assert gate.leases == 0


@pytest.mark.asyncio
async def test_drain_waits_for_a_publication_in_flight_and_times_out_without_proof(runtime):
    from backend.app.services.library_preview import PublicationGate

    gate = PublicationGate()
    publishing, release = asyncio.Event(), asyncio.Event()

    async def publish():
        async with runtime.attempt({"mesh": (_box(), "stl")}, publication=gate) as result:
            assert result.outcome == "ok"
            publishing.set()
            await release.wait()

    task = asyncio.create_task(publish())
    await publishing.wait()
    gate.close()
    assert await gate.drain(timeout=0.3) is False  # the lease is still held: no proof
    drained = asyncio.create_task(gate.drain(timeout=30))
    await asyncio.sleep(0.1)
    assert not drained.done()
    release.set()
    await task
    assert await drained is True


# --- ENOENT: only the source itself is file_missing -------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_source_gone_before_its_snapshot_is_file_missing(runtime, tmp_path):
    async with runtime.attempt({"mesh": (tmp_path / "gone.stl", "stl")}) as result:
        assert result.outcome == "file_missing"


def test_a_staging_enoent_or_an_unreadable_source_is_not_file_missing(tmp_path):
    import time

    from backend.app.services.preview_artifacts import snapshot
    from backend.app.services.preview_protocol import PreviewError

    source = tmp_path / "part.stl"
    source.write_bytes(b"solid x\nendsolid x\n")
    deadline = time.monotonic_ns() + int(30e9)
    with pytest.raises(FileNotFoundError):  # the staging side: an ordinary failure, never file_missing
        snapshot(source, tmp_path / "no-such-dir" / "mesh.stl", deadline)
    with pytest.raises(Exception) as unreadable:
        snapshot(tmp_path, tmp_path / "mesh.stl", deadline)  # a directory where a file should be
    assert not (isinstance(unreadable.value, PreviewError) and unreadable.value.outcome == "file_missing")


def test_the_jobs_name_only_a_positive_source_enoent_file_missing(tmp_path, monkeypatch):
    import os

    from backend.app.services.library_preview_jobs import source_state

    present = tmp_path / "part.step"
    present.write_bytes(b"ISO-10303-21;")
    assert source_state(present) is None
    assert source_state(tmp_path / "gone.step") == "file_missing"
    real_stat = os.stat

    def denied(path, *args, **kwargs):
        if Path(path) == present:
            raise PermissionError(13, "denied")
        return real_stat(path, *args, **kwargs)

    monkeypatch.setattr(os, "stat", denied)
    assert source_state(present) == "unavailable"  # a permission error is not a missing file


# --- restore ----------------------------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_quiesce_closes_publication_stops_the_jobs_with_a_new_epoch_and_proves_it():
    from backend.app.services import library_preview_jobs as jobs_module
    from backend.app.services.library_preview_jobs import (
        Authority,
        EpochExpired,
        StepSource,
        quiesce_library_previews_for_restore,
    )

    hold = asyncio.Event()

    async def perform(source, *, order, wait_seconds, on_admit, on_hand_off, before_attach):
        on_admit()
        await hold.wait()
        return "succeeded"

    service = jobs_module.start_library_preview_jobs(perform=perform)
    source = StepSource(1, "p.step", "step", "library/p.step", "a" * 64, None, None)
    receipt = service.enqueue(source, Authority.user(1), "manual")
    old_epoch = service.epoch
    assert await quiesce_library_previews_for_restore() is True
    assert receipt.state == "canceled" and not library_preview.publication.open
    assert service.epoch != old_epoch
    with pytest.raises(EpochExpired):
        service.lookup(old_epoch, receipt.id)  # the old epoch answers 410
    assert library_preview.publication.acquire() is None  # closed until the process restarts


@pytest.mark.asyncio
async def test_quiesce_without_proof_is_refused():
    from backend.app.services.library_preview_jobs import quiesce_library_previews_for_restore

    lease = library_preview.publication.acquire()  # a publication that never ends
    assert lease is not None
    assert await quiesce_library_previews_for_restore(drain_seconds=0.2) is False
    lease.release()


@pytest.mark.asyncio
async def test_the_restore_gate_answers_409_when_previews_cannot_prove_quiet(monkeypatch):
    from fastapi import HTTPException

    from backend.app.api.routes import settings as settings_routes
    from backend.app.services import library_preview_jobs as jobs_module

    async def unproven(**kwargs):
        return False

    monkeypatch.setattr(jobs_module, "quiesce_library_previews_for_restore", unproven)
    with pytest.raises(HTTPException) as refused:
        await settings_routes._quiesce_library_previews()
    assert refused.value.status_code == 409 and refused.value.detail["error"] == "preview_quiesce_unproven"


def test_the_restore_quiesces_previews_before_the_storage_guard_and_any_file_work():
    import inspect

    from backend.app.api.routes import settings as settings_routes

    source = inspect.getsource(settings_routes._restore_backup)
    gate = source.index("await _quiesce_library_previews()")
    assert source.index("await _quiesce_part_render()") < gate
    assert gate < source.index("queue_sources.storage_mutation()") < source.index("files.prepare")
    assert gate < source.index("files.apply")


@pytest.mark.asyncio
async def test_a_legacy_publication_in_flight_finishes_before_the_quiesce_and_none_starts_after(
    publication_db, runtime, tmp_path, monkeypatch
):
    """The barrier restore needs: an attach already handed off completes; any result reaching its hand-off after
    the quiesce publishes nothing — legacy STL/OBJ included, not only the STEP jobs."""
    from backend.app.services import preview_runtime as preview_runtime_module
    from backend.app.services.library_preview_jobs import quiesce_library_previews_for_restore

    monkeypatch.setattr(preview_runtime_module, "runtime", runtime)
    settings.library_dir.mkdir(parents=True, exist_ok=True)
    (settings.library_dir / "cube.stl").write_bytes(_box())
    source = await seed(
        publication_db, filename="cube.stl", file_path="library/cube.stl", file_type="stl", file_hash=None
    )
    attaching, release = asyncio.Event(), asyncio.Event()
    real = library_preview.attach_result

    async def held(db, src, out, **kwargs):
        attaching.set()
        await release.wait()
        return await real(db, src, out, **kwargs)

    monkeypatch.setattr(library_preview, "attach_result", held)

    async def legacy():
        async with publication_db() as db:
            return await library_preview.generate(db, source)

    task = asyncio.create_task(legacy())
    await attaching.wait()
    quiet = asyncio.create_task(quiesce_library_previews_for_restore())
    await asyncio.sleep(0.2)
    assert not quiet.done()  # waits for the owned publication
    release.set()
    assert await task is True and await quiet is True
    async with publication_db() as db:
        row = await db.get(LibraryFile, source.id)
    assert row.thumbnail_path != source.thumbnail_path
    later = await seed(
        publication_db, filename="later.stl", file_path="library/cube.stl", file_type="stl", file_hash=None
    )
    async with publication_db() as db:
        assert await library_preview.generate(db, later) is False  # after the quiesce: nothing more


@pytest.mark.asyncio
async def test_the_real_step_attempt_asks_the_authority_inside_its_attach(publication_db, tmp_path, monkeypatch):
    """perform_step hands the jobs' recheck to attach_result: a right gone at the attach writes nothing."""
    from backend.app.core import database
    from backend.app.services import preview_runtime as preview_runtime_module
    from backend.app.services.library_preview_jobs import StepSource, perform_step

    settings.library_dir.mkdir(parents=True, exist_ok=True)
    (settings.library_dir / "part.step").write_bytes(b"ISO-10303-21;")
    source = await seed(publication_db)
    attempt, _ = _fake_attempt(outcome="ok", digest=source.file_hash, preview=png(tmp_path))
    monkeypatch.setattr(preview_runtime_module, "preview_attempt", attempt)
    monkeypatch.setattr(database, "async_session", publication_db)
    asked = []

    async def before_attach(session=None):
        asked.append(session)
        return False  # the actor lost its right

    step_source = StepSource(
        source.id, source.filename, "step", source.file_path, source.file_hash, None, source.thumbnail_path
    )
    outcome = await perform_step(
        step_source,
        order=1,
        wait_seconds=1,
        on_admit=lambda: None,
        on_hand_off=lambda: None,
        before_attach=before_attach,
    )
    assert outcome == "authority_missing"
    assert asked and isinstance(asked[0], AsyncSession)  # asked with the attach's own session
    async with publication_db() as db:
        row = await db.get(LibraryFile, source.id)
    assert row.thumbnail_path == source.thumbnail_path and not _pngs()


@pytest.mark.asyncio
@pytest.mark.skipif(not __import__("os").environ.get("PREVIEW_TEST_PG_DSN"), reason="disposable PostgreSQL only")
async def test_the_typed_cas_on_a_disposable_postgres(tmp_path, monkeypatch):
    """The CAS SQL changed (the file type joined it): the same answers on PostgreSQL, in a fresh schema owned by
    this run alone and dropped after it."""
    import os
    import uuid

    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    from backend.app.core.database import Base, import_all_models

    schema = "step_cas_" + uuid.uuid4().hex
    engine = create_async_engine(
        os.environ["PREVIEW_TEST_PG_DSN"], execution_options={"schema_translate_map": {None: schema}}
    )
    import_all_models()
    try:
        async with engine.begin() as conn:
            await conn.execute(text(f'CREATE SCHEMA "{schema}"'))
            await conn.run_sync(Base.metadata.create_all)
        monkeypatch.setattr(settings, "base_dir", tmp_path)
        monkeypatch.setattr(settings, "library_dir", tmp_path / "library")
        factory = async_sessionmaker(engine, expire_on_commit=False)
        clean = await seed(factory)
        async with factory() as db:
            assert await attach_result(db, clean, png(tmp_path)) == "attached"
        typed = await seed(factory, file_path="library/typed.step", file_hash="d" * 64)
        async with factory() as db:
            await db.execute(update(LibraryFile).where(LibraryFile.id == typed.id).values(file_type="stl"))
            await db.commit()
        async with factory() as db:
            assert await attach_result(db, typed, png(tmp_path)) == "superseded"
        refused = await seed(factory, file_path="library/refused.step", file_hash="e" * 64)

        async def refuse(session):
            return False

        async with factory() as db:
            assert await attach_result(db, refused, png(tmp_path), authorize=refuse) == "authority_missing"
        async with factory() as db:
            row = await db.get(LibraryFile, refused.id)
        assert row.thumbnail_path == refused.thumbnail_path
    finally:
        async with engine.begin() as conn:
            await conn.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        await engine.dispose()


def test_a_source_changed_while_it_was_read_is_source_changed_not_a_render_failure(tmp_path, monkeypatch):
    """The bytes moved under the snapshot: the truthful answer is that the source changed (a STEP job ends
    'superseded'), never 'could not be converted' (review A-m2)."""
    import time as _time

    from backend.app.services import preview_artifacts
    from backend.app.services.preview_protocol import PreviewError

    source = tmp_path / "part.step"
    source.write_bytes(b"x" * 10)
    real = preview_artifacts._source_signature
    calls = []

    def moving(path):
        calls.append(path)
        if len(calls) > 1:
            path.write_bytes(b"y" * 20)  # a writer replaced it while the copy ran
        return real(path)

    monkeypatch.setattr(preview_artifacts, "_source_signature", moving)
    with pytest.raises(PreviewError) as changed:
        preview_artifacts.snapshot(source, tmp_path / "copy", _time.monotonic_ns() + 10**10)
    assert changed.value.outcome == "source_changed"


@pytest.mark.asyncio
async def test_a_step_job_whose_source_changed_mid_read_ends_superseded(monkeypatch, tmp_path):
    from contextlib import asynccontextmanager

    from backend.app.services import library_preview_jobs as jobs_module, preview_runtime as preview_runtime_module
    from backend.app.services.preview_runtime import PreviewResult

    @asynccontextmanager
    async def changed(*args, **kwargs):
        yield PreviewResult(outcome="source_changed", kind="step")

    monkeypatch.setattr(preview_runtime_module, "preview_attempt", changed)
    monkeypatch.setattr(jobs_module, "source_state", lambda path: None)
    step = tmp_path / "part.step"
    step.write_bytes(b"x")
    monkeypatch.setattr(settings, "base_dir", tmp_path)
    source = jobs_module.StepSource(
        id=1,
        filename="part.step",
        file_type="step",
        file_path="part.step",
        file_hash="a" * 64,
        thumbnail_path=None,
        fs_modified_at=None,
    )
    outcome = await jobs_module.perform_step(
        source, order=0, wait_seconds=1, on_admit=None, on_hand_off=None, before_attach=None
    )
    assert outcome == "superseded"


@pytest.mark.asyncio
async def test_on_sqlite_the_authority_is_read_holding_the_write_lock(publication_db, tmp_path):
    """pysqlite opens its transaction at the first write, so a read before it runs outside any transaction: the
    recheck must hold SQLite's write lock when it reads, or it is 'inside the transaction' in name only."""
    import sqlite3

    source = await seed(publication_db)
    seen = {}

    async def authorize(session):
        probe = sqlite3.connect(tmp_path / "publication.db", timeout=0.1)
        try:
            probe.execute("BEGIN IMMEDIATE")
            seen["another_writer"] = "got the lock"
            probe.execute("ROLLBACK")
        except sqlite3.OperationalError as exc:
            seen["another_writer"] = str(exc)
        finally:
            probe.close()
        return True

    async with publication_db() as db:
        assert await attach_result(db, source, png(tmp_path), authorize=authorize) == "attached"
    assert seen["another_writer"] == "database is locked"


@pytest.mark.asyncio
async def test_a_job_stuck_on_a_hung_share_makes_the_quiesce_unproven_not_endless(monkeypatch):
    """A STEP job reading a hung NAS cannot be cancelled out of its owned disk call: the restore must answer 409
    within its budget instead of hanging with it (review A-m9)."""
    import time as _time

    from backend.app.services import library_preview_jobs as jobs_module

    hung = asyncio.Event()

    async def stuck(cause="shutdown"):
        await hung.wait()
        return True

    monkeypatch.setattr(jobs_module, "stop_library_preview_jobs", stuck)
    started = _time.monotonic()
    try:
        assert await jobs_module.quiesce_library_previews_for_restore(drain_seconds=0.3) is False
        assert _time.monotonic() - started < 5
    finally:
        hung.set()
        await asyncio.sleep(0)  # the stop left running ends with the share


async def _entered(event, seconds: float = 5.0):
    for _ in range(int(seconds / 0.01)):
        if event.is_set():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("barrier never entered")


@pytest.mark.asyncio
async def test_a_restore_answers_in_budget_while_the_real_runtime_is_stuck_in_a_snapshot(tmp_path, monkeypatch):
    """The real runtime (broker, service, guardian) with a STEP attempt admitted and stuck in its snapshot's owned
    disk read of a hung share: the quiesce answers unproven within its budget, the reader keeps its slot, and the
    stop goes on to its own proven end once the share answers (Codex A-R2)."""
    import threading

    from backend.app.services import library_preview_jobs as jobs_module, preview_runtime as r

    runtime = r.PreviewRuntime(tmp_path / "runtime", app_dir=tmp_path / "app")
    await runtime.start()
    assert runtime.ready
    start, release = threading.Event(), threading.Event()
    real_snapshot = r.snapshot

    def hung(*args, **kwargs):
        start.set()
        assert release.wait(30)
        return real_snapshot(*args, **kwargs)

    async def descriptor():
        return {"manifest_digest": "a" * 64, "bundle_key": "win-x64-cp312"}

    monkeypatch.setattr(runtime, "cad_descriptor", descriptor)
    monkeypatch.setattr(r, "runtime", runtime)
    monkeypatch.setattr(r, "snapshot", hung)

    async def stuck():
        async with runtime.attempt({"mesh": (b"ISO-10303-21;", "step")}):
            pass

    attempt = asyncio.create_task(stuck())
    quiet = None
    try:
        await _entered(start)
        quiet = asyncio.create_task(jobs_module.quiesce_library_previews_for_restore(drain_seconds=0.2))
        done, _ = await asyncio.wait({quiet}, timeout=3)
        assert quiet in done, "the restore passed its budget, held by the runtime's stop"
        assert quiet.result() is False
        assert runtime.slot.locked()  # the unproven reader keeps its slot
        assert r.runtime is runtime  # no replacement while the old one lives
        assert await r.stop_preview_runtime_within(0.1) is False  # the same stop, not a second one
        assert len([t for t in asyncio.all_tasks() if t.get_name() == "preview-runtime-stop"]) == 1
    finally:
        release.set()
        await asyncio.gather(attempt, return_exceptions=True)
        if quiet is not None:
            await asyncio.gather(quiet, return_exceptions=True)
        assert await r.stop_preview_runtime() is True  # the share answered: the owner ends, proven
        assert r.runtime is None


@pytest.mark.asyncio
async def test_no_replacement_runtime_starts_while_the_old_one_is_still_stopping(tmp_path, monkeypatch):
    from backend.app.services import preview_runtime as r

    pending = asyncio.get_running_loop().create_future()
    monkeypatch.setattr(r, "_stopping", pending)
    with pytest.raises(RuntimeError):
        await r.start_preview_runtime(tmp_path)
    pending.cancel()
