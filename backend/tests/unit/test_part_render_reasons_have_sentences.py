"""Every reason the part render worker can report has a sentence on the System page, in both languages.

The page shows `system.partRenderWorker.reasons.<code>` beside the raw code; a reason without a sentence shows the
code alone (plan E7 D1). The list the frontend test keeps is written by hand -- `circuit_open` was missing from it --
so this reads the reasons out of the runtime's own assignments (final review, 2026-10-12)."""

import ast
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
RUNTIME = ROOT / "backend" / "app" / "services" / "part_render_runtime.py"
REASON_NAMES = {"reason", "node_reason"}


def _name(node: ast.AST) -> str | None:
    return node.attr if isinstance(node, ast.Attribute) else node.id if isinstance(node, ast.Name) else None


def _strings(node: ast.AST) -> set[str]:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return {node.value}
    if isinstance(node, ast.BoolOp):  # self.reason or "worker_restarting"
        return set().union(*(_strings(v) for v in node.values))
    return set()


def runtime_reasons(source: str) -> set[str]:
    found: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Tuple) and isinstance(node.value, ast.Tuple):
                    for elt, value in zip(target.elts, node.value.elts, strict=False):
                        if _name(elt) in REASON_NAMES:
                            found |= _strings(value)
                elif _name(target) in REASON_NAMES:
                    found |= _strings(node.value)
        elif isinstance(node, ast.Dict):  # the not-started health: {"state": ..., "reason": "not_started"}
            for key, value in zip(node.keys, node.values, strict=False):
                if isinstance(key, ast.Constant) and key.value == "reason":
                    found |= _strings(value)
    return found


def locale_reasons(path: Path) -> set[str]:
    text = path.read_text(encoding="utf-8")
    worker = text[text.index("    partRenderWorker: {") :]
    start = worker.index("      reasons: {") + len("      reasons: {")
    block = worker[start : worker.index("\n      },", start)]
    return set(re.findall(r"^\s+([a-z_]+):\s", block, flags=re.M))


def test_the_scan_reads_the_runtimes_reasons():
    reasons = runtime_reasons(RUNTIME.read_text(encoding="utf-8"))
    assert {
        "runtime_missing",
        "no_runtime",
        "ownership_uncertain",
        "circuit_open",
        "not_started",
        "staging_full",
    } <= reasons
    assert None not in reasons and "unavailable" not in reasons  # states are not reasons


def test_every_reason_has_a_sentence_in_both_languages():
    reasons = runtime_reasons(RUNTIME.read_text(encoding="utf-8"))
    for lang in ("en", "uk"):
        missing = reasons - locale_reasons(ROOT / "frontend" / "src" / "i18n" / "locales" / f"{lang}.ts")
        assert not missing, f"{lang}: no sentence for {sorted(missing)}"
