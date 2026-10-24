"""Configured G-code snippets reach the plate that prints (issue #96; spec gh96 G01–G08).

``BackgroundDispatchService._build_injection_spec`` read the ``gcode_snippets`` setting through
``self._session_factory`` — an attribute the service never had. The ``except Exception`` around it
turned the AttributeError into "skipping", so every dispatch with injection on printed without the
operator's snippets and only a warning said so. The patcher's own tests never entered the resolver.

Everything here runs the REAL resolver against the test database, and the dispatch cases run the
real runners, the real patcher and the real archive service; only FTP, MQTT, heating and macros
are fakes. What is checked is the file the upload would have sent, not a call to a helper.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
import time
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

import backend.app.services.background_dispatch as bd
from backend.app.core import database
from backend.app.core.config import settings
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.settings import Settings
from backend.app.services import gcode_patcher, queue_sources
from backend.app.services.background_dispatch import BackgroundDispatchService, PrintDispatchJob
from backend.app.services.gcode_patcher import GcodeInjectionSpec
from backend.app.services.printer_manager import printer_manager
from backend.tests.fixtures.filament_routing_cases import write_routing_3mf
from backend.tests.integration.test_dispatch_without_original import dispatch_mocks
from backend.tests.integration.test_filament_routing_dispatch import setup_source

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]

LOGGER = "backend.app.services.background_dispatch"
SECRET = "SECRET-7f3a91"


# --------------------------------------------------------------------------- #
# Resolver harness
# --------------------------------------------------------------------------- #


class CountingSessions:
    """The module's session factory, counting what it opened and what is still open."""

    def __init__(self, inner):
        self.inner = inner
        self.opened = 0
        self.live = 0

    @asynccontextmanager
    async def __call__(self):
        self.opened += 1
        self.live += 1
        try:
            async with self.inner() as session:
                yield session
        finally:
            self.live -= 1


@pytest.fixture
def resolver_sessions(test_engine, monkeypatch) -> CountingSessions:
    """Only the module's session factory is replaced — never the resolver."""
    sessions = CountingSessions(async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False))
    monkeypatch.setattr(bd, "async_session", sessions)
    return sessions


async def store_snippets(db, value: str | None) -> None:
    row = await db.scalar(select(Settings).where(Settings.key == "gcode_snippets"))
    if value is None:
        if row is not None:
            await db.delete(row)
    elif row is None:
        db.add(Settings(key="gcode_snippets", value=value))
    else:
        row.value = value
    await db.commit()


def a_job(*, injection: bool = True) -> PrintDispatchJob:
    return PrintDispatchJob(
        id=4242,
        kind="print_library_file",
        source_id=None,
        source_name="part.gcode.3mf",
        printer_id=1,
        printer_name="P1",
        options={"gcode_injection": injection},
    )


async def resolve(model: str | None = "P1S", *, plate_id: int = 2, injection: bool = True):
    return await BackgroundDispatchService()._build_injection_spec(
        job=a_job(injection=injection), printer_model=model, plate_id=plate_id
    )


# --------------------------------------------------------------------------- #
# G01–G05, G07 — the resolver
# --------------------------------------------------------------------------- #


async def test_the_configured_snippets_of_the_printers_model_are_resolved(db_session, resolver_sessions, caplog):
    """G01: the real resolver over the real setting answers a spec, and closes its session first (G2)."""
    caplog.set_level(logging.DEBUG, logger=LOGGER)
    await store_snippets(db_session, json.dumps({"P1S": {"start_gcode": " M117 hi \n", "end_gcode": "G28 X"}}))

    spec = await resolve("P1S", plate_id=2)

    assert spec == GcodeInjectionSpec(plate_id=2, start_gcode="M117 hi", end_gcode="G28 X")
    assert (resolver_sessions.opened, resolver_sessions.live) == (1, 0)
    assert "skipped" not in caplog.text and "failed" not in caplog.text


@pytest.mark.parametrize("injection,model", [(False, "P1S"), (True, None)], ids=["injection-off", "no-model"])
async def test_nothing_is_read_when_injection_is_off_or_the_model_is_unknown(
    db_session, resolver_sessions, injection, model
):
    """G02: no settings session is opened for a job that cannot inject."""
    await store_snippets(db_session, json.dumps({"P1S": {"start_gcode": "M117 hi"}}))

    assert await resolve(model, injection=injection) is None
    assert resolver_sessions.opened == 0


@pytest.mark.parametrize(
    "stored",
    [
        None,
        "",
        json.dumps({}),
        json.dumps({"X1C": {"start_gcode": "M117 other"}}),
        json.dumps({"P1S": {}}),
        json.dumps({"P1S": {"start_gcode": "  \n", "end_gcode": ""}}),
        json.dumps({"P1S": {"start_gcode": None, "end_gcode": None}}),
        json.dumps(["P1S"]),
    ],
    ids=["no-row", "empty-text", "empty-object", "other-model-only", "empty-model", "blank", "nulls", "not-an-object"],
)
async def test_a_setting_with_nothing_for_this_model_is_a_silent_no_op(db_session, resolver_sessions, caplog, stored):
    """G03: the setting is read, and nothing to inject is no spec and no warning."""
    caplog.set_level(logging.DEBUG, logger=LOGGER)
    await store_snippets(db_session, stored)

    assert await resolve("P1S") is None
    assert (resolver_sessions.opened, resolver_sessions.live) == (1, 0)
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]


async def test_start_only_end_only_and_both_resolve_and_models_never_mix(db_session, resolver_sessions):
    """G04: each model gets exactly its own halves."""
    await store_snippets(
        db_session,
        json.dumps(
            {
                "P1S": {"start_gcode": "M117 start-p1s"},
                "X1C": {"end_gcode": "M117 end-x1c"},
                "A1": {"start_gcode": "M117 start-a1", "end_gcode": "M117 end-a1"},
            }
        ),
    )

    assert await resolve("P1S", plate_id=1) == GcodeInjectionSpec(1, "M117 start-p1s", None)
    assert await resolve("X1C", plate_id=3) == GcodeInjectionSpec(3, None, "M117 end-x1c")
    assert await resolve("A1", plate_id=2) == GcodeInjectionSpec(2, "M117 start-a1", "M117 end-a1")


async def test_every_attempt_reads_the_setting_as_it_is_now(db_session, resolver_sessions):
    """G05: a changed setting is what the next dispatch injects — nothing is cached."""
    await store_snippets(db_session, json.dumps({"P1S": {"start_gcode": "M117 first"}}))
    assert await resolve("P1S") == GcodeInjectionSpec(2, "M117 first", None)

    await store_snippets(db_session, json.dumps({"P1S": {"end_gcode": "M117 second"}}))
    assert await resolve("P1S") == GcodeInjectionSpec(2, None, "M117 second")

    await store_snippets(db_session, None)
    assert await resolve("P1S") is None
    assert (resolver_sessions.opened, resolver_sessions.live) == (3, 0)


def _sole_warning(caplog) -> logging.LogRecord:
    warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert len(warnings) == 1, caplog.text
    return warnings[0]


@pytest.mark.parametrize(
    "stored,error_class",
    [
        ('{"P1S": {"start_gcode": "M117 ' + SECRET + '"', "JSONDecodeError"),
        (json.dumps({"P1S": SECRET}), "AttributeError"),
    ],
    ids=["malformed-json", "model-entry-not-an-object"],
)
async def test_an_unreadable_setting_skips_injection_with_a_closed_reason(
    db_session, resolver_sessions, caplog, stored, error_class
):
    """G07: fail-open, and the warning names the job, the reason and the class — never the setting's text.

    Every logger at DEBUG is checked, from the resolver's call on: the test's own INSERT of the
    setting is logged by aiosqlite with its parameters, and that write is not the resolver's."""
    caplog.set_level(logging.DEBUG)
    await store_snippets(db_session, stored)
    caplog.clear()

    assert await resolve("P1S") is None

    warning = _sole_warning(caplog)
    message = warning.getMessage()
    assert "4242" in message and "injection_settings_failed" in message and error_class in message
    assert SECRET not in caplog.text
    assert resolver_sessions.live == 0


async def test_a_failing_settings_read_is_reported_without_its_text(db_session, resolver_sessions, monkeypatch, caplog):
    """G07: a database error's message (SQL parameters, credentials) never reaches the log."""
    caplog.set_level(logging.DEBUG)

    async def refuse(_db, _key):
        raise RuntimeError(f"connection failed: password={SECRET}")

    monkeypatch.setattr("backend.app.api.routes.settings.get_setting", refuse)

    assert await resolve("P1S") is None

    message = _sole_warning(caplog).getMessage()
    assert "4242" in message and "injection_settings_failed" in message and "RuntimeError" in message
    assert SECRET not in caplog.text
    assert resolver_sessions.live == 0


async def test_a_cancelled_dispatch_is_not_turned_into_a_no_op(db_session, resolver_sessions, monkeypatch, caplog):
    """G07: cancellation while the setting is read propagates, and closes the session."""
    caplog.set_level(logging.DEBUG, logger=LOGGER)

    async def cancelled(_db, _key):
        raise asyncio.CancelledError

    monkeypatch.setattr("backend.app.api.routes.settings.get_setting", cancelled)

    with pytest.raises(asyncio.CancelledError):
        await resolve("P1S")
    assert (resolver_sessions.opened, resolver_sessions.live) == (1, 0)
    assert "injection" not in caplog.text


# --------------------------------------------------------------------------- #
# G06, G08 — both runners, the file the upload would have sent
# --------------------------------------------------------------------------- #

PLATE = 2
START = "M117 BAMDUDE-START {max_z_height}"
END = "M117 BAMDUDE-END"
FILAMENTS = [{"id": 3, "type": "PLA", "color": "#FF0000", "used_g": "0.0001"}]


def plate_gcode(plate: int) -> bytes:
    return (
        "; HEADER_BLOCK_START\n"
        "; max_z_height: 16.00\n"
        "; HEADER_BLOCK_END\n"
        f"; plate {plate}\n"
        "M970.3 Q1 A7 ; vibration check\n"
        "; MACHINE_START_GCODE_END\n"
        f"G1 X10 Y10 F3000 ; plate-{plate}-body\n"
        "; EXECUTABLE_BLOCK_END\n"
    ).encode()


def md5_of(data: bytes) -> bytes:
    return hashlib.md5(data, usedforsecurity=False).hexdigest().upper().encode("ascii")


def a_two_plate_3mf(path: Path) -> Path:
    """Two sliced plates with md5 sidecars — plate 1 is the control the injection must not touch."""
    plain = write_routing_3mf(path.with_suffix(".plain.3mf"), {1: FILAMENTS, PLATE: FILAMENTS})
    with zipfile.ZipFile(plain) as src, zipfile.ZipFile(path, "w") as dst:
        for info in src.infolist():
            if not info.filename.endswith(".gcode"):
                dst.writestr(info.filename, src.read(info.filename))
        for plate in (1, PLATE):
            dst.writestr(f"Metadata/plate_{plate}.gcode", plate_gcode(plate))
            dst.writestr(f"Metadata/plate_{plate}.gcode.md5", md5_of(plate_gcode(plate)))
    plain.unlink()
    return path


def members(data: bytes) -> dict[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        return {name: zf.read(name) for name in zf.namelist()}


@pytest.fixture
def clean_dispatch_state(test_engine, monkeypatch):
    """A fresh server's spool and run registries, and the spool's sessions on the test engine."""
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
    factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr(database, "async_session", factory)
    yield factory
    deadline = time.monotonic() + 10
    while queue_sources.active_captures() and time.monotonic() < deadline:  # pragma: no cover - drain
        time.sleep(0.01)
    queue_sources._reset_state()


async def a_source(db, tmp_path, printer_id: int, kind: str) -> tuple[int, str, Path]:
    if kind == "library":
        path = a_two_plate_3mf(tmp_path / "bracket.gcode.3mf")
        row = LibraryFile(
            filename=path.name,
            file_path=str(path),
            file_size=path.stat().st_size,
            file_type="gcode",
            file_hash=hashlib.sha256(path.read_bytes()).hexdigest(),
        )
    else:
        folder = settings.archive_dir / "source"
        folder.mkdir(parents=True, exist_ok=True)
        path = a_two_plate_3mf(folder / "bracket.gcode.3mf")
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        row = PrintArchive(
            printer_id=printer_id,
            filename=path.name,
            file_path=str(path.relative_to(settings.base_dir)),
            file_size=path.stat().st_size,
            content_hash=digest,
            source_content_hash=digest,
            status="completed",
            plate_index=PLATE,
        )
    db.add(row)
    await db.commit()
    return row.id, path.name, path


async def dispatch(service, kind: str, source_id: int, name: str, printer, options: dict) -> PrintDispatchJob:
    common = {
        "printer_id": printer.id,
        "printer_name": printer.name,
        "options": {"plate_id": PLATE, **options},
        "requested_by_user_id": None,
        "requested_by_username": None,
    }
    if kind == "library":
        await service.dispatch_print_library_file(file_id=source_id, filename=name, **common)
    else:
        await service.dispatch_reprint_archive(archive_id=source_id, archive_name=name, **common)
    job = service._queued_jobs[0]
    await service._run_active_job(job)
    return job


async def run_dispatch(db, tmp_path, printer_factory, monkeypatch, factory, *, kind: str, options: dict):
    """One direct print through the real runner; returns what was uploaded, the source and the job."""
    _unused, printer, _queue, mqtt = await setup_source(db, tmp_path, printer_factory, monkeypatch)
    settings.archive_dir.mkdir(parents=True, exist_ok=True)
    source_id, name, path = await a_source(db, tmp_path, printer.id, kind)
    original = path.read_bytes()

    sent: list[bytes] = []

    async def upload(_ip, _code, local_path, _remote, **_kwargs):
        sent.append(Path(local_path).read_bytes())
        return True

    service = dispatch_mocks(monkeypatch, factory, upload=AsyncMock(side_effect=upload))
    # The runners import the patcher lazily, so a wrapper on the module is what they call.
    passes: list[dict] = []
    real_transforms = gcode_patcher.apply_3mf_transforms

    def counted(*args, **kwargs):
        passes.append(kwargs)
        return real_transforms(*args, **kwargs)

    monkeypatch.setattr(gcode_patcher, "apply_3mf_transforms", counted)

    job = await dispatch(service, kind, source_id, name, printer, options)
    assert job.outcome["success"] is True, job.outcome
    mqtt._client.publish.assert_called_once()
    assert len(sent) == 1
    return {"sent": sent[0], "original": original, "path": path, "job": job, "passes": passes}


@pytest.mark.parametrize("kind", ["library", "archive"])
async def test_the_chosen_plate_of_the_uploaded_file_carries_the_snippets(
    async_client, db_session, tmp_path, printer_factory, monkeypatch, clean_dispatch_state, kind
):
    """G06: plate 2 gets both snippets with a matching md5; plate 1, the source and the hashes hold."""
    await store_snippets(db_session, json.dumps({"P1P": {"start_gcode": START, "end_gcode": END}}))

    ran = await run_dispatch(
        db_session,
        tmp_path,
        printer_factory,
        monkeypatch,
        clean_dispatch_state,
        kind=kind,
        options={"gcode_injection": True, "mesh_mode_fast_check": True},
    )

    sent, original = ran["sent"], ran["original"]
    uploaded, before = members(sent), members(original)
    target = uploaded[f"Metadata/plate_{PLATE}.gcode"].decode()
    assert "M117 BAMDUDE-START 16.00\n; MACHINE_START_GCODE_END" in target
    assert "plate-2-body\nM117 BAMDUDE-END\n; EXECUTABLE_BLOCK_END" in target
    assert uploaded[f"Metadata/plate_{PLATE}.gcode.md5"] == md5_of(uploaded[f"Metadata/plate_{PLATE}.gcode"])
    # The control plate, and every member that is not plate 2, leave exactly as they came.
    changed = {name for name in before if uploaded[name] != before[name]}
    assert changed == {f"Metadata/plate_{PLATE}.gcode", f"Metadata/plate_{PLATE}.gcode.md5"}
    assert ran["path"].read_bytes() == original

    archive = await db_session.get(PrintArchive, ran["job"].outcome["archive_id"])
    assert archive.source_content_hash == hashlib.sha256(original).hexdigest()
    assert archive.content_hash == hashlib.sha256(sent).hexdigest()
    detail = await async_client.get(f"/api/v1/archives/{archive.id}")
    assert detail.status_code == 200, detail.text
    assert detail.json()["applied_patches"] == [{"name": "gcode_injection", "plate_id": PLATE}]


async def test_an_unreadable_setting_still_prints_the_file_as_it_came(
    db_session, tmp_path, printer_factory, monkeypatch, clean_dispatch_state, caplog
):
    """G07 at dispatch: injection is skipped, the print is not — the source bytes go out unchanged."""
    caplog.set_level(logging.WARNING, logger=LOGGER)
    await store_snippets(db_session, '{"P1P": {"start_gcode": "M117 ' + SECRET + '"')

    ran = await run_dispatch(
        db_session,
        tmp_path,
        printer_factory,
        monkeypatch,
        clean_dispatch_state,
        kind="library",
        options={"gcode_injection": True, "mesh_mode_fast_check": True},
    )

    assert ran["sent"] == ran["original"] and ran["passes"] == []
    archive = await db_session.get(PrintArchive, ran["job"].outcome["archive_id"])
    assert archive.applied_patches is None
    assert "injection_settings_failed" in caplog.text and SECRET not in caplog.text


@pytest.mark.parametrize("kind", ["library", "archive"])
async def test_the_vibration_patch_and_the_snippets_share_one_pass(
    async_client, db_session, tmp_path, printer_factory, monkeypatch, clean_dispatch_state, kind
):
    """G08: both transforms in one open/write; M970 off on every plate, snippets on plate 2 only."""
    await store_snippets(db_session, json.dumps({"P1P": {"start_gcode": START}}))

    ran = await run_dispatch(
        db_session,
        tmp_path,
        printer_factory,
        monkeypatch,
        clean_dispatch_state,
        kind=kind,
        options={"gcode_injection": True, "mesh_mode_fast_check": False},
    )

    assert len(ran["passes"]) == 1
    assert ran["passes"][0]["mesh_mode_fast_check_off"] is True
    assert ran["passes"][0]["gcode_injection"] == GcodeInjectionSpec(PLATE, START, None)
    uploaded = members(ran["sent"])
    for plate in (1, PLATE):
        gcode = uploaded[f"Metadata/plate_{plate}.gcode"]
        assert b"\nM970.3 Q1 A7" not in gcode
        assert uploaded[f"Metadata/plate_{plate}.gcode.md5"] == md5_of(gcode)
        assert (b"M117 BAMDUDE-START 16.00" in gcode) is (plate == PLATE)
    assert ran["path"].read_bytes() == ran["original"]

    archive = await db_session.get(PrintArchive, ran["job"].outcome["archive_id"])
    assert archive.content_hash == hashlib.sha256(ran["sent"]).hexdigest()
    assert archive.source_content_hash == hashlib.sha256(ran["original"]).hexdigest()
    detail = await async_client.get(f"/api/v1/archives/{archive.id}")
    assert detail.status_code == 200, detail.text
    assert detail.json()["applied_patches"] == [
        "mesh_mode_fast_check_off",
        {"name": "gcode_injection", "plate_id": PLATE},
    ]
