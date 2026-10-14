"""Who may touch a source's swap declaration (swap-source-lifecycle spec r4 §3; plan T1, closed in T8).

The archive column ``swap_compatible`` is a projection of the record ``extra_data["swap_source"]``; no macro or
plate-clear gate may read it, and only ``services/swap_compatibility`` writes either. A library row's column is
written by the library ingest writers and read for display; decisions go through ``library_fact``.

The scan finds every touch of the fact in ``backend/app`` -- an attribute (ORM read, assignment, SELECT of the
column), a keyword (constructor, response), a string (``getattr`` / ``setattr`` / a dict key) -- per function.
Each one is either ALLOWED, in one of the plan's categories with its reason, or PENDING, naming the task that
replaces it. A new touch fails; a pending one that is gone fails until it leaves the list, so the list only
shrinks. T8 empties it and removes the xfail below.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
APP = ROOT / "backend" / "app"
OWNER = "backend/app/services/swap_compatibility.py"

#: Permanent touches, each in one of the plan's categories (the model and the frozen migrations are not scanned):
#: this module, a declared response transport, a library writer applying the ingest classifier. Empty until a
#: task moves a touch here with its reason.
ALLOWED: dict[tuple[str, str, str], str] = {}

#: Touches that predate the policy module. Each names the task that replaces it with the reader/writer, or moves
#: it to ALLOWED in one of the categories above.
PENDING = {
    ("backend/app/api/routes/library.py", "save_3mf_bytes_to_library", "kw"): "T5 ingest classifier",
    ("backend/app/api/routes/library.py", "store_library_upload", "kw"): "T5 ingest classifier",
    ("backend/app/api/routes/library.py", "list_files", "attr"): "T6 library known projection",
    ("backend/app/api/routes/library.py", "list_files", "kw"): "T6 library known projection",
    ("backend/app/api/routes/library.py", "get_file", "attr"): "T6 library known projection",
    ("backend/app/api/routes/library.py", "get_file", "kw"): "T6 library known projection",
    ("backend/app/api/routes/print_queue.py", "get_queue_copy_source", "kw"): "T6 copy source reads the job's fact",
    ("backend/app/main.py", "_on_print_complete_impl", "attr"): "T7 completion reader",
    ("backend/app/services/library_helpers.py", "sync_system_tags", "attr"): "T5 system tags after the fact",
    ("backend/app/services/library_helpers.py", "sync_system_tags", "kw"): "T5 system tags after the fact",
}


class _Touches(ast.NodeVisitor):
    def __init__(self, rel: str):
        self.rel = rel
        self.stack: list[str] = []
        self.found: set[tuple[str, str, str]] = set()
        self.carrier: list[str] = []

    def _scope(self, node):
        self.stack.append(node.name)
        self.generic_visit(node)
        self.stack.pop()

    visit_FunctionDef = visit_AsyncFunctionDef = visit_ClassDef = _scope

    def _add(self, kind: str) -> None:
        self.found.add((self.rel, ".".join(self.stack) or "<module>", kind))

    def visit_Attribute(self, node):
        if node.attr == "swap_compatible":
            self._add("attr")
        self.generic_visit(node)

    def visit_keyword(self, node):
        if node.arg == "swap_compatible":
            self._add("kw")
        self.generic_visit(node)

    def visit_Constant(self, node):
        if node.value == "swap_compatible":
            self._add("str")
        elif node.value == "swap_source":
            self.carrier.append(f"{self.rel}:{node.lineno}")


def _touches() -> tuple[set[tuple[str, str, str]], list[str]]:
    found: set[tuple[str, str, str]] = set()
    carrier: list[str] = []
    for path in sorted(APP.rglob("*.py")):
        rel = path.relative_to(ROOT).as_posix()
        if "/migrations/" in rel or rel == OWNER:
            continue
        visitor = _Touches(rel)
        visitor.visit(ast.parse(path.read_text(encoding="utf-8")))
        found |= visitor.found
        carrier += visitor.carrier
    return found, carrier


def test_every_touch_of_the_fact_is_allowed_or_pending():
    found, _ = _touches()
    unexpected = sorted(found - set(ALLOWED) - set(PENDING))
    assert not unexpected, f"read or write the swap fact through services/swap_compatibility: {unexpected}"


def test_a_pending_touch_that_is_gone_leaves_the_list():
    found, _ = _touches()
    stale = sorted(set(PENDING) - found)
    assert not stale, f"replaced: remove from PENDING: {stale}"


def test_an_allowed_touch_that_is_gone_leaves_the_list():
    found, _ = _touches()
    stale = sorted(set(ALLOWED) - found)
    assert not stale, f"no longer used: remove from ALLOWED: {stale}"


def test_the_reserved_record_key_is_only_the_writers():
    _, carrier = _touches()
    assert not carrier, f"extra_data['swap_source'] belongs to services/swap_compatibility: {carrier}"


@pytest.mark.xfail(strict=True, reason="T3-T7 replace the pending touches; T8 removes this mark")
def test_nothing_is_left_pending():
    assert not PENDING
