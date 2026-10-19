"""The Windows installer build reads its text files as UTF-8, never in the machine's locale.

`installers/windows/build.py` runs on a Windows runner whose locale encoding is cp1252. `config.py` carries a
U+FE0F (in a "⚠️"), whose UTF-8 bytes include 0x8f -- a byte cp1252 does not map -- so a bare `read_text()`
failed the whole build on its last step (E7 acceptance, 2026-10-12). A locale-dependent read passes on Linux
and fails only on the release runner, so this is a scan of the source, not a run."""

import ast
from pathlib import Path

BUILD = Path(__file__).resolve().parents[3] / "installers" / "windows" / "build.py"


def _unencoded_text_reads(tree: ast.AST) -> list[int]:
    lines = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute | ast.Name):
            continue
        name = node.func.attr if isinstance(node.func, ast.Attribute) else node.func.id
        keywords = {k.arg for k in node.keywords}
        if name in ("read_text", "write_text") and "encoding" not in keywords:
            lines.append(node.lineno)
        if name == "open" and "encoding" not in keywords:
            mode = (
                node.args[1] if len(node.args) > 1 else next((k.value for k in node.keywords if k.arg == "mode"), None)
            )
            binary = isinstance(mode, ast.Constant) and isinstance(mode.value, str) and "b" in mode.value
            if not binary:
                lines.append(node.lineno)
    return sorted(lines)


def test_every_text_read_of_the_installer_build_names_its_encoding():
    assert _unencoded_text_reads(ast.parse(BUILD.read_text(encoding="utf-8"))) == []


def test_the_scan_sees_a_bare_read():
    assert _unencoded_text_reads(
        ast.parse("p.read_text()\nopen(f)\nopen(f, 'rb')\np.read_text(encoding='utf-8')\n")
    ) == [1, 2]
