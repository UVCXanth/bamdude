"""Direct writes of the stand seed — only what a printer or a file gives birth to (spec C2).

Runs as a child of ``stand.py`` with the stand environment and its guard, and is
the one module of the stand that imports ``backend``. Everything with an API is
written through the API by ``seed_http.py``; here, only:

- ``Printer`` + its ``PrinterQueue`` (``POST /printers`` probes MQTT first), the
  queue through ``printer_queues.ensure_printer_queue`` — the one creator;
- ``LibraryFile`` with ``file_metadata`` AND real bytes: a 3MF written by
  ``write_routing_3mf`` from the same plate / model / time / material / colour
  values the metadata holds, so the queue's capture reads a real source; a file
  spec with ``thumbnail`` (an RGB colour) also carries a real PNG per plate in
  ``Metadata/plate_N.png`` — the picture ``plate-thumbnail`` serves (WS-13 E5-V03);
  the row's ``file_tags`` come from the app's own writer, ``compute_file_tags``;
- ``PrintArchive`` + ``PrintArchivePart``: prints a printer would have reported.

    python -c "import seed_direct; seed_direct.main(['files', in.json, out.json])"
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import struct
import sys
import zipfile
import zlib
from datetime import datetime
from pathlib import Path

from backend.app.api.routes.library import get_library_dir, to_absolute_path, to_relative_path
from backend.app.core import database
from backend.app.models.archive import PrintArchive
from backend.app.models.archive_part import PrintArchivePart
from backend.app.models.library import LibraryFile
from backend.app.models.printer import Printer
from backend.app.services.library_helpers import compute_file_tags
from backend.app.services.printer_queues import ensure_printer_queue
from backend.tests.fixtures.filament_routing_cases import write_routing_3mf

# Every model is registered before the first mapper is configured — the list lives in one place.
database.import_all_models()

# The slicer's printer_model_id for each farm model (utils/printer_models.PRINTER_MODEL_ID_MAP).
MODEL_CODES = {"P1S": "C12", "X1C": "BL-P001", "A1 Mini": "N1", "H2D": "O1D", "X1E": "C13"}
# H2D prints from two nozzles: the file must say which filament group each one takes.
DUAL_SETTINGS = {
    "physical_extruder_map": ["1", "0"],
    "filament_nozzle_map": ["0", "0"],
    "nozzle_diameter": ["0.4", "0.4"],
}


def _dt(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


def plate_png(rgb: list[int], width: int = 160, height: int = 120) -> bytes:
    """A real PNG (stdlib only): bands of the colour and a lighter shade, so a picture that
    loaded is told from a blank box by eye too."""
    light = bytes(min(255, c + 90) for c in rgb)
    rows = []
    for y in range(height):
        rows.append(b"\x00" + (bytes(rgb) if (y // 20) % 2 == 0 else light) * width)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(b"".join(rows)))
        + chunk(b"IEND", b"")
    )


def _write_bytes(spec: dict, target: Path) -> None:
    """The file's bytes, from the same values its metadata carries."""
    if not spec["sliced"]:
        # An unsliced model (Q4 / an STL in a product): no plate a printer can run.
        target.write_text("solid ws13\nendsolid ws13\n", encoding="ascii")
        return
    model = spec["model"]
    plates = {}
    prediction = {}
    for plate in spec["plates"]:
        plates[plate["index"]] = [
            {
                "id": slot,
                "type": f["type"],
                "color": f["color"],
                "used_g": f"{plate['grams'] / max(1, len(plate['filaments'])):.2f}",
                "group_id": 0,
            }
            for slot, f in enumerate(plate["filaments"], start=1)
        ]
        prediction[plate["index"]] = plate["minutes"] * 60
    write_routing_3mf(
        target,
        plates,
        model=MODEL_CODES[model],
        settings=DUAL_SETTINGS if model == "H2D" else None,
        prediction=prediction,
    )
    if spec.get("thumbnail"):
        with zipfile.ZipFile(target, "a") as zf:
            for plate in spec["plates"]:
                zf.writestr(f"Metadata/plate_{plate['index']}.png", plate_png(spec["thumbnail"]))


def _metadata(spec: dict) -> dict | None:
    if not spec["sliced"]:
        return {"has_sliced_gcode": False, "plates": []}
    plates = []
    for plate in spec["plates"]:
        objects = {}
        n = 0
        for name, count in plate["objects"].items():
            for _ in range(count):
                n += 1
                objects[str(n)] = name
        plates.append(
            {
                "index": plate["index"],
                "printable_objects": objects,
                "filaments": [{"type": f["type"], "color": f["color"]} for f in plate["filaments"]],
                "print_time_seconds": plate["minutes"] * 60,
                "filament_used_grams": float(plate["grams"]),
                "has_thumbnail": bool(spec.get("thumbnail")),
            }
        )
    return {
        "sliced_for_model": spec["model"],
        "has_sliced_gcode": True,
        "print_time_seconds": sum(p["print_time_seconds"] for p in plates),
        "plates": plates,
    }


async def _files(payload: dict) -> dict:
    out = {"printers": {}, "files": {}}
    async with database.async_session() as db:
        for spec in payload["printers"]:
            printer = Printer(
                name=spec["name"],
                serial_number=spec["serial"],
                ip_address=spec["ip"],
                access_code="00000000",  # a TEST-NET printer that does not exist; not a secret
                model=spec["model"],
                is_active=True,
            )
            db.add(printer)
            await db.flush()
            await ensure_printer_queue(db, printer.id)
            out["printers"][spec["key"]] = printer.id
        files_dir = get_library_dir() / "files"
        files_dir.mkdir(parents=True, exist_ok=True)
        for spec in payload["files"]:
            target = files_dir / f"ws13-{spec['key'].replace(':', '-')}-{spec['filename']}"
            _write_bytes(spec, target)
            data = target.read_bytes()
            metadata = _metadata(spec)
            row = LibraryFile(
                filename=spec["filename"],
                file_path=to_relative_path(target),
                file_type=spec["file_type"],
                file_size=len(data),
                file_hash=hashlib.sha256(data).hexdigest(),
                folder_id=spec.get("folder_id"),
                file_metadata=metadata,
                # The cache every real write path fills (upload, scan, m036) — a seeded row
                # without it reads as «not sliced» to every client.
                file_tags=compute_file_tags(
                    filename=spec["filename"],
                    file_type=spec["file_type"],
                    file_metadata=metadata,
                    source_type=None,
                    swap_compatible=False,
                ),
                created_by_id=payload.get("created_by_id"),
            )
            db.add(row)
            await db.flush()
            out["files"][spec["key"]] = row.id
        await db.commit()
    return out


async def _archives(payload: dict) -> dict:
    out = {}
    async with database.async_session() as db:
        for spec in payload["archives"]:
            archive = PrintArchive(
                printer_id=spec.get("printer_id"),
                library_file_id=spec.get("library_file_id"),
                project_id=spec.get("project_id"),
                project_line_id=spec.get("project_line_id"),
                plate_index=spec.get("plate_index"),
                filename=spec["filename"],
                file_path="",
                file_size=0,
                source_content_hash=spec.get("source_hash"),
                status=spec["status"],
                quantity=1,
                started_at=_dt(spec.get("started_at")),
                completed_at=_dt(spec.get("completed_at")),
                print_time_seconds=spec.get("print_time_seconds"),
                filament_used_grams=spec.get("filament_used_grams"),
                filament_type=spec.get("filament_type"),
                filament_color=spec.get("filament_color"),
                extra_data={"ws13_stand": spec["key"]},
            )
            db.add(archive)
            await db.flush()
            for part in spec.get("parts", []):
                db.add(
                    PrintArchivePart(
                        archive_id=archive.id,
                        name=part["name"],
                        name_key=part["name"].casefold(),
                        quantity=part["quantity"],
                    )
                )
            out[spec["key"]] = archive.id
        await db.commit()
    return out


def _reader(payload: dict) -> dict:
    from backend.app.services.filament_requirements import read_print_requirements

    out = {}
    for check in payload["checks"]:
        req = read_print_requirements(to_absolute_path(check["file_path"]), check.get("plate"))
        out[check["key"]] = {
            "ok": req.status == "ok",
            "reason": req.reason,
            "plate": req.resolved_plate_id,
            "model": req.model,
            "seconds": req.print_time_seconds,
            "filaments": [[f["type"], f["color"]] for f in req.used_filaments],
        }
    return out


async def _queue_sources(payload: dict) -> dict:
    """Where each queue row's captured bytes live — the job's own source (spec C2)."""
    from sqlalchemy import text

    out = {}
    async with database.async_session() as db:
        for table, key in (("print_queue", "pq"), ("auto_queue_items", "aq")):
            for item_id in payload.get(key, []):
                row = (
                    await db.execute(
                        text(
                            f"SELECT s.relative_path, q.plate_id FROM {table} q "
                            "JOIN queue_sources s ON s.id = q.queue_source_id WHERE q.id = :id"
                        ),
                        {"id": item_id},
                    )
                ).first()
                out[f"{key}:{item_id}"] = {"file_path": row[0], "plate": row[1]} if row else None
    return out


async def _run(command: str, payload: dict) -> dict:
    try:
        if command == "files":
            return await _files(payload)
        if command == "archives":
            return await _archives(payload)
        if command == "reader":
            return _reader(payload)
        if command == "queue_sources":
            return await _queue_sources(payload)
        raise SystemExit(f"unknown command {command!r}")
    finally:
        await database.engine.dispose()


def main(argv: list[str]) -> None:
    command, source, target = argv
    payload = json.loads(Path(source).read_text(encoding="utf-8"))
    result = asyncio.run(_run(command, payload))
    Path(target).write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main(sys.argv[1:])
