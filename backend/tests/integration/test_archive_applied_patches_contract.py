"""``applied_patches`` over HTTP: a list of identifiers AND descriptor objects (issue #97, PR #98; spec gh97 A01–A06).

The dispatch writes a mixed JSON array into the TEXT column — ``"mesh_mode_fast_check_off"`` beside
``{"name": "gcode_injection", "plate_id": N}`` — and the response typed it ``list[str]``, so one injected print
answered 500 to the whole archive list. The list and the detail now return exactly what was stored: strings and
objects in order, every key kept. What the parser already refuses (NULL, an empty string, broken or non-array JSON)
stays ``None``. The column, the hashes and the chain of custody are untouched.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import zipfile
from pathlib import Path

import pytest

from backend.app.services.archive import ArchiveService
from backend.app.services.gcode_patcher import GcodeInjectionSpec, apply_3mf_transforms

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]

MIXED = ["mesh_mode_fast_check_off", {"name": "gcode_injection", "plate_id": 2}]
NESTED = [
    {"name": "gcode_injection", "plate_id": 1, "detail": {"start": ["G28", "M400"], "meta": {"k": 1}}, "extra": None}
]


async def _archives(async_client, **params) -> list[dict]:
    response = await async_client.get("/api/v1/archives/", params={"per_page": 100, **params})
    assert response.status_code == 200, response.text
    return response.json()["data"]


async def test_a_mixed_archive_no_longer_breaks_the_list_and_keeps_its_payload(
    async_client, printer_factory, archive_factory
):
    """A01 + A02: two ordinary archives and a mixed one — the list answers all three, the detail the same value."""
    printer = await printer_factory()
    plain = [await archive_factory(printer.id, print_name=f"plain {n}") for n in range(2)]
    mixed = await archive_factory(printer.id, print_name="injected", applied_patches=json.dumps(MIXED))
    rows = {row["id"]: row for row in await _archives(async_client)}
    assert {a.id for a in [*plain, mixed]} <= set(rows)
    assert rows[mixed.id]["applied_patches"] == MIXED
    assert all(rows[a.id]["applied_patches"] is None for a in plain)
    detail = await async_client.get(f"/api/v1/archives/{mixed.id}")
    assert detail.status_code == 200, detail.text
    assert detail.json()["applied_patches"] == MIXED


async def test_a_page_and_a_filter_that_hold_the_mixed_archive_answer(async_client, printer_factory, archive_factory):
    """A01: the row is really inside the paged, filtered answer — not merely outside the page that broke."""
    printer, other = await printer_factory(), await printer_factory()
    await archive_factory(other.id, print_name="elsewhere")
    mixed = await archive_factory(printer.id, print_name="injected", applied_patches=json.dumps(MIXED))
    rows = await _archives(async_client, printer_id=printer.id, per_page=1, page=1)
    assert [(row["id"], row["applied_patches"]) for row in rows] == [(mixed.id, MIXED)]


@pytest.mark.parametrize(
    "stored,answered",
    [
        (json.dumps(["mesh_mode_fast_check_off"]), ["mesh_mode_fast_check_off"]),
        (json.dumps([{"name": "gcode_injection", "plate_id": 1}]), [{"name": "gcode_injection", "plate_id": 1}]),
        (json.dumps(MIXED), MIXED),
        (json.dumps(NESTED), NESTED),
        ("[]", []),
        (None, None),
        ("", None),
        ("{not json", None),
        (json.dumps({"name": "gcode_injection"}), None),
        (json.dumps("mesh_mode_fast_check_off"), None),
    ],
    ids=["strings", "objects", "mixed", "nested", "empty-array", "null", "empty-text", "broken", "object", "string"],
)
async def test_every_stored_form_answers_as_it_did_or_as_it_was_written(
    async_client, printer_factory, archive_factory, stored, answered
):
    """A03-A05: each valid array returns exactly as stored; what the parser refuses stays None."""
    printer = await printer_factory()
    archive = await archive_factory(printer.id, applied_patches=stored)
    detail = await async_client.get(f"/api/v1/archives/{archive.id}")
    assert detail.status_code == 200, detail.text
    assert detail.json()["applied_patches"] == answered
    assert [row["applied_patches"] for row in await _archives(async_client)] == [answered]


_PLATE = """; HEADER_BLOCK_START
; max_z_height: 16.00
; HEADER_BLOCK_END
M104 S220
M970.3 P1 ; vibration check
; MACHINE_START_GCODE_END
G1 X10 Y10 F3000
"""


def _three_mf(path: Path) -> Path:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", "<Types/>")
        for plate in (1, 2):
            zf.writestr(f"Metadata/plate_{plate}.gcode", _PLATE)
            zf.writestr(f"Metadata/plate_{plate}.gcode.md5", "deadbeef")
    return path


async def test_the_patcher_output_reaches_the_archive_and_the_answer_unchanged(
    async_client, db_session, printer_factory, tmp_path
):
    """A06: the real transforms of a two-plate 3MF, archived by the real service, answered by the real route —
    the descriptor and the hashes agree, and the original bytes never change."""
    source = _three_mf(tmp_path / "design.3mf")
    original = source.read_bytes()
    source_hash = hashlib.sha256(original).hexdigest()
    patched, applied = apply_3mf_transforms(
        source,
        mesh_mode_fast_check_off=True,
        gcode_injection=GcodeInjectionSpec(plate_id=2, start_gcode="; HELLO", end_gcode=None),
    )
    try:
        assert (
            patched != source and any(isinstance(p, dict) for p in applied) and any(isinstance(p, str) for p in applied)
        )
        printer = await printer_factory()
        archive = await ArchiveService(db_session).archive_print(
            printer_id=printer.id,
            source_file=patched,
            original_filename="design.3mf",
            source_content_hash=source_hash,
            applied_patches=applied,
        )
        assert archive is not None
    finally:
        shutil.rmtree(patched.parent, ignore_errors=True)
    assert source.read_bytes() == original  # the original 3MF is never patched in place
    detail = await async_client.get(f"/api/v1/archives/{archive.id}")
    assert detail.status_code == 200, detail.text
    body = detail.json()
    assert body["applied_patches"] == applied
    assert body["source_content_hash"] == source_hash
    assert body["content_hash"] != source_hash and body["effective_hash"] == source_hash
