"""A scan's refresh and an operator's declaration of one library row never interleave (swap-source-declaration spec r3
§5; plan T9.3).

Both take the row under one write protocol -- SQLite's writer before the authoritative read, PostgreSQL's row lock --
so whichever reaches the row second decides against what the first one committed. Declaration first: the scan waits
at the row, reads the operator's carrier and, for new bytes on the share, replaces it with the classifier's carrier of
those bytes. Scan first: the declaration of the old bytes waits at the row, then finds them gone and writes nothing.
Two independent sessions on a file database; each side is held at a named point while the other is watched.
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select

from backend.app.core import database
from backend.app.models.library import LibraryFile, LibraryFolder
from backend.app.models.library_scan import LibraryScanJob
from backend.app.models.swap_source_declaration_audit import SwapSourceDeclarationAudit
from backend.app.services import library_scan, swap_compatibility as sc, swap_source_declarations as decl
from backend.app.services.library_scan import run_scan
from backend.tests.integration.test_swap_declaration_service import (  # noqa: F401 -- fixtures
    ALL,
    a_3mf,
    a_user,
    actor_of,
    clean_spool_state,
    declare,
    factory,
    sha,
)
from backend.tests.integration.test_swap_library_ingest import touch_later

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]

WAIT = 20


async def a_share(factory, tmp_path):
    root = tmp_path / "nas"
    root.mkdir()
    async with factory() as db:
        folder = LibraryFolder(name="NAS", is_external=True, external_path=str(root), external_show_hidden=False)
        db.add(folder)
        await db.commit()
        return root, folder.id


async def scan(factory, folder_id: int) -> None:
    async with factory() as db:
        job = LibraryScanJob(folder_id=folder_id, status="queued")
        db.add(job)
        await db.commit()
        job_id = job.id
    await run_scan(job_id)
    async with factory() as db:
        job = await db.get(LibraryScanJob, job_id)
        assert job.status == "finished", job.error


async def the_row(factory) -> LibraryFile:
    async with factory() as db:
        return (await db.execute(select(LibraryFile))).scalar_one()


async def audit_lines(factory) -> int:
    async with factory() as db:
        return (await db.execute(select(func.count()).select_from(SwapSourceDeclarationAudit))).scalar_one()


async def a_scanned_row(factory, tmp_path):
    root, folder_id = await a_share(factory, tmp_path)
    on_share = root / "plate.gcode.3mf"
    a_3mf(on_share, "v1")
    await scan(factory, folder_id)
    row = await the_row(factory)
    user = await a_user(factory)
    seen = await decl.inspect("library", row.id, actor=actor_of(user), rights=ALL)
    return on_share, folder_id, row.id, user, seen


def classifier_of(raw: bytes, value: bool) -> dict:
    return {"version": 1, "value": value, "sha256": sha(raw), "origin": "classifier"}


async def test_a_declaration_holding_the_row_is_what_the_scan_decides_against(factory, tmp_path, monkeypatch):
    on_share, folder_id, row_id, user, seen = await a_scanned_row(factory, tmp_path)

    # The declaration copies the inspected bytes first and is held before it writes; the scan then walks the new
    # bytes and is held with no transaction open, just before it writes its batch -- so what it wrote before (its job
    # row) is not what puts it behind the declaration.
    declaration_verified, enter_row = asyncio.Event(), asyncio.Event()
    real_write = decl._write

    async def write_when_released(*args, **kwargs):
        declaration_verified.set()
        await enter_row.wait()
        return await real_write(*args, **kwargs)

    declaration_holds, release_declaration = asyncio.Event(), asyncio.Event()
    real_rights = decl._fresh_rights

    async def rights_while_the_row_is_held(*args, **kwargs):  # the declaration's row is locked by now
        declaration_holds.set()
        await release_declaration.wait()
        return await real_rights(*args, **kwargs)

    scan_prepared, release_scan = asyncio.Event(), asyncio.Event()
    real_batch = library_scan.write_batch

    async def batch_when_released(*args, **kwargs):
        scan_prepared.set()
        await release_scan.wait()
        return await real_batch(*args, **kwargs)

    scan_at_row = asyncio.Event()
    real_lock = database.take_write_lock

    async def watched_lock(db, table, row_id_):
        if table.name == "library_files" and declaration_holds.is_set():
            scan_at_row.set()
        await real_lock(db, table, row_id_)

    decided_against: list = []
    real_decision = sc.scan_declaration

    def watched_decision(row, **kwargs):
        decided_against.append(row.swap_source_declaration)
        return real_decision(row, **kwargs)

    monkeypatch.setattr(decl, "_write", write_when_released)
    monkeypatch.setattr(decl, "_fresh_rights", rights_while_the_row_is_held)
    monkeypatch.setattr(library_scan, "write_batch", batch_when_released)
    monkeypatch.setattr(database, "take_write_lock", watched_lock)
    monkeypatch.setattr(sc, "scan_declaration", watched_decision)

    declaring = asyncio.create_task(declare("library", row_id, seen, user, value=True))
    await asyncio.wait_for(declaration_verified.wait(), WAIT)
    v2 = a_3mf(on_share, "v2")
    touch_later(on_share)
    scanning = asyncio.create_task(scan(factory, folder_id))
    await asyncio.wait_for(scan_prepared.wait(), WAIT)
    enter_row.set()
    await asyncio.wait_for(declaration_holds.wait(), WAIT)
    release_scan.set()
    await asyncio.wait_for(scan_at_row.wait(), WAIT)
    await asyncio.sleep(0.5)
    assert decided_against == []  # the scan waits at the row; it has decided nothing yet

    release_declaration.set()
    await asyncio.wait_for(declaring, WAIT)
    await asyncio.wait_for(scanning, WAIT)

    assert [record["origin"] for record in decided_against] == ["operator"]  # read after the declaration committed
    row = await the_row(factory)
    assert row.file_hash == sha(v2) and row.swap_source_declaration == classifier_of(v2, False)
    assert row.swap_compatible is False and "swap" not in row.file_tags
    assert await audit_lines(factory) == 1  # the declaration of the old bytes stands in the journal


async def test_a_scan_holding_the_row_leaves_the_declaration_of_the_old_bytes_nothing_to_write(
    factory, tmp_path, monkeypatch
):
    on_share, folder_id, row_id, user, seen = await a_scanned_row(factory, tmp_path)

    declaration_verified, release_declaration = asyncio.Event(), asyncio.Event()
    real_write = decl._write

    async def write_when_released(*args, **kwargs):  # the declaration's own copy matched what was inspected
        declaration_verified.set()
        await release_declaration.wait()
        return await real_write(*args, **kwargs)

    scan_holds, release_scan = asyncio.Event(), asyncio.Event()
    real_lock = database.take_write_lock

    async def lock_then_hold(db, table, row_id_):
        await real_lock(db, table, row_id_)
        if table.name == "library_files" and not scan_holds.is_set():
            scan_holds.set()
            await release_scan.wait()

    monkeypatch.setattr(decl, "_write", write_when_released)

    declaring = asyncio.create_task(declare("library", row_id, seen, user, value=True))
    await asyncio.wait_for(declaration_verified.wait(), WAIT)
    monkeypatch.setattr(database, "take_write_lock", lock_then_hold)
    v2 = a_3mf(on_share, "v2")
    touch_later(on_share)
    scanning = asyncio.create_task(scan(factory, folder_id))
    await asyncio.wait_for(scan_holds.wait(), WAIT)

    release_declaration.set()
    await asyncio.sleep(0.5)
    assert not declaring.done()  # the declaration waits at the row the scan holds

    release_scan.set()
    await asyncio.wait_for(scanning, WAIT)
    with pytest.raises(HTTPException) as refused:
        await asyncio.wait_for(declaring, WAIT)

    assert refused.value.status_code == 409 and refused.value.detail["error"] == "swap_source_changed"
    row = await the_row(factory)
    assert row.file_hash == sha(v2) and row.swap_source_declaration == classifier_of(v2, False)
    assert await audit_lines(factory) == 0
