"""A source's declaration on the wire, in a git backup and through save-to-library (swap-source-declaration spec r3
§7, §9; plan T9.5).

The archive answer keeps its historical pair -- what the executed run was -- and adds the SOURCE pair a future
reprint reads, with the declaration's metadata; neither falls back to the other. A git backup carries the
declaration portably: its id, value, hash, time and the actor's label -- never a local user id, so a restore never
credits whoever has the same id here -- and a restore records itself as one. A backup from before the field says
nothing (no override on insert, the local one kept on overwrite); an explicit null or malformed one is a tombstone
the reader answers unknown, with no fallback to the run's fact. Save-to-library takes the source reader's answer,
the operator's declaration included, as a transferred carrier of the very bytes saved.
"""

from __future__ import annotations

import uuid
from datetime import datetime

import pytest
from sqlalchemy import select

from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.swap_source_declaration_audit import SwapSourceDeclarationAudit
from backend.app.services import swap_compatibility as sc
from backend.tests.integration.test_swap_archive_backup import backed_up, by_name, restore

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]

SHA = "ab" * 32


def a_row(name: str, **columns) -> PrintArchive:
    columns.setdefault("status", "completed")
    columns.setdefault("started_at", datetime(2026, 10, 1, 12, 0, 0))
    columns.setdefault("source_content_hash", SHA)
    return PrintArchive(filename=f"{name}.gcode.3mf", file_path="", file_size=1, print_name=name, **columns)


def declared(row: PrintArchive, value: bool, *, actor_id: int | None = 7, label: str = "operator") -> dict:
    sc.write_source_declaration(
        row,
        value=value,
        sha256=SHA,
        origin="operator",
        operator={
            "declaration_id": str(uuid.uuid4()),
            "declared_at": "2026-10-14T10:00:00+00:00",
            "actor_id": actor_id,
            "actor_label": label,
            "actor_kind": "user",
        },
    )
    return dict(row.swap_source_declaration)


# --- the archive answer ----------------------------------------------------------------------------------------------


async def test_the_archive_answer_keeps_the_runs_pair_and_adds_the_sources(committing_client, db_session):
    run_true = a_row("run-true")
    sc.write_archive_fact(run_true, True)
    record = declared(run_true, False)
    unknown = a_row("unknown")
    tombstoned = a_row("tombstoned")
    sc.write_archive_fact(tombstoned, True)
    tombstoned.swap_source_declaration = dict(sc.INVALID_DECLARATION)
    db_session.add_all([run_true, unknown, tombstoned])
    await db_session.commit()

    answers = {
        row.print_name: (await committing_client.get(f"/api/v1/archives/{row.id}")).json()
        for row in (run_true, unknown, tombstoned)
    }

    first = answers["run-true"]
    assert (first["swap_compatible"], first["swap_compatibility_known"]) == (True, True)  # what the run was
    assert (first["source_swap_compatible"], first["source_swap_compatibility_known"]) == (False, True)
    meta = first["source_swap_declaration"]
    assert meta["declaration_id"] == record["declaration_id"] and meta["value"] is False
    assert "actor_id" not in meta  # a local user id is no one's business on the wire
    assert (answers["unknown"]["source_swap_compatible"], answers["unknown"]["source_swap_compatibility_known"]) == (
        False,
        False,
    )
    last = answers["tombstoned"]
    assert (last["source_swap_compatible"], last["source_swap_compatibility_known"]) == (False, False)
    assert last["source_swap_declaration"] is None


# --- a git backup ----------------------------------------------------------------------------------------------------


async def test_a_git_roundtrip_carries_the_declaration_and_credits_no_local_user(db_session):
    row = a_row("declared")
    record = declared(row, True, actor_id=1, label="alice")
    entries = await backed_up(db_session, [row])
    entry = entries[0]
    assert entry[sc.DECLARATION_COLUMN]["declaration_id"] == record["declaration_id"]
    assert "actor_id" not in entry[sc.DECLARATION_COLUMN]
    await db_session.delete(row)
    await db_session.commit()

    await restore(db_session, entries)

    restored = (await by_name(db_session))["declared"]
    declaration = sc.current_declaration(restored)
    assert declaration.value is True and declaration.sha256 == SHA
    assert declaration.operator["declaration_id"] == record["declaration_id"]
    assert declaration.operator["actor_id"] is None  # never whoever has id 1 here
    assert declaration.operator["actor_kind"] == "restored" and declaration.operator["actor_label"] == "alice"
    assert sc.archive_source(restored)[0] == sc.SourceFact(True)
    [line] = (await db_session.execute(select(SwapSourceDeclarationAudit))).scalars().all()
    assert (line.action, line.declaration_id, line.source_id, line.actor_id) == (
        "restore",
        record["declaration_id"],
        restored.id,
        None,
    )


async def test_a_backup_from_before_the_field_says_nothing(db_session):
    row = a_row("kept")
    local = declared(row, False)
    entries = await backed_up(db_session, [row])
    for entry in entries:
        entry.pop(sc.DECLARATION_COLUMN, None)  # what an older backup holds

    await restore(db_session, entries, overwrite=True)
    assert (await by_name(db_session))["kept"].swap_source_declaration == local  # overwrite keeps the local one

    await db_session.delete((await by_name(db_session))["kept"])
    await db_session.commit()
    await restore(db_session, entries)
    assert (await by_name(db_session))["kept"].swap_source_declaration is None  # insert creates no override


@pytest.mark.parametrize(
    "carried",
    [None, {"version": 1, "value": "true"}, {"version": 2, "value": True}, "yes", {"invalid": True, "version": 1}],
)
async def test_a_null_or_malformed_declaration_is_a_tombstone_with_no_fallback(carried, db_session):
    row = a_row("broken")
    sc.write_archive_fact(row, True)  # the run's fact must not stand in for it
    declared(row, False)
    entries = await backed_up(db_session, [row])
    entries[0][sc.DECLARATION_COLUMN] = carried

    await restore(db_session, entries, overwrite=True)

    restored = (await by_name(db_session))["broken"]
    assert restored.swap_source_declaration == sc.INVALID_DECLARATION
    assert sc.archive_source(restored)[0].value is None
    assert sc.archive_fact(restored).value is True  # the historical run is untouched


# --- save-to-library -------------------------------------------------------------------------------------------------


async def test_save_to_library_transfers_the_operators_declaration_of_the_saved_bytes(
    committing_client, db_session, archive_factory, printer_factory
):
    from backend.tests.integration.test_swap_library_ingest import an_archive_file, row_of

    printer = await printer_factory()
    archive, raw = await an_archive_file(db_session, archive_factory, printer.id, "plate.3mf", "op", record=None)
    assert sc.archive_source(archive)[0].value is None  # unknown: save-to-library would refuse it
    sc.write_source_declaration(
        archive,
        value=True,
        sha256=sc_sha(raw),
        origin="operator",
        operator={
            "declaration_id": str(uuid.uuid4()),
            "declared_at": "2026-10-14T10:00:00+00:00",
            "actor_id": None,
            "actor_label": "admin",
            "actor_kind": "user",
        },
    )
    await db_session.commit()

    response = await committing_client.post(f"/api/v1/archives/{archive.id}/save-to-library")

    assert response.status_code == 200, response.text
    saved: LibraryFile = await row_of(db_session, raw)
    assert saved.swap_source_declaration == {
        "version": 1,
        "value": True,
        "sha256": saved.file_hash,
        "origin": "transferred",
    }


def sc_sha(raw: bytes) -> str:
    import hashlib

    return hashlib.sha256(raw).hexdigest()
