"""Which code may ask for a STEP picture (spec §3, plan A5 negative callsites): the shared upload and the ZIP door
through ``_queue_step_thumbnail``, and the explicit button. MakerWorld's save, the archive, the printer's files,
the Virtual Printer, calibration and the scanner never do — a new caller has to be decided, not drift in."""

from __future__ import annotations

import ast
from pathlib import Path

APP = Path(__file__).resolve().parents[2] / "app"

ALLOWED_QUEUE_CALLERS = {
    ("api/routes/library.py", "store_library_upload"),
    ("api/routes/library.py", "extract_zip_file"),
}
ALLOWED_ENQUEUE_MODULES = {"api/routes/library.py", "api/routes/library_thumbnail_jobs.py"}


def _calls(name: str):
    for path in APP.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for function in ast.walk(tree):
            if not isinstance(function, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for node in ast.walk(function):
                if isinstance(node, ast.Call):
                    target = node.func
                    called = target.attr if isinstance(target, ast.Attribute) else getattr(target, "id", None)
                    if called == name:
                        yield path.relative_to(APP).as_posix(), function.name


def test_only_the_shared_upload_and_the_zip_door_ask_for_a_new_files_picture():
    assert set(_calls("_queue_step_thumbnail")) == ALLOWED_QUEUE_CALLERS


def test_only_the_doors_and_the_button_enqueue_a_step_job():
    modules = {module for module, _ in _calls("enqueue")}
    jobs_internal = {"services/library_preview_jobs.py"}
    unexpected = modules - ALLOWED_ENQUEUE_MODULES - jobs_internal - _other_enqueue_owners()
    assert not unexpected, unexpected


def _other_enqueue_owners() -> set[str]:
    """Modules whose own ``enqueue`` is a different queue (not the STEP jobs) — named, never assumed."""
    owners = set()
    for path in APP.rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        if ".enqueue(" in text and "library_preview_jobs" not in text and "_queue_step_thumbnail" not in text:
            owners.add(path.relative_to(APP).as_posix())
    return owners


def test_the_negative_doors_never_name_the_step_jobs():
    for relative in (
        "services/makerworld",
        "services/archive.py",
        "services/virtual_printer",
        "services/calibration_service.py",
        "services/library_scan.py",
    ):
        target = APP / relative
        files = [target] if target.is_file() else list(target.rglob("*.py"))
        for path in files:
            text = path.read_text(encoding="utf-8")
            assert "library_preview_jobs" not in text and "_queue_step_thumbnail" not in text, path
