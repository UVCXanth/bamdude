"""Start-up, health and rendering never install anything (spec stage C R10; plan Task 4): the CAD component is
installed or chosen only by its helper's own CLI and by the in-app update, never by the code that serves STEP
previews, the System page or the app's start."""

from __future__ import annotations

import ast
from pathlib import Path

APP = Path(__file__).resolve().parents[2] / "app"
ALLOWED = {APP / "step_runtime.py", APP / "api" / "routes" / "updates.py"}
CAD_CALLS = {"install", "write_choice"}
CAD_WORDS = {"--if-enabled", "choose"}


def _offenders(path: Path) -> list[str]:
    found = []
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            owner = node.func.value
            if node.func.attr in CAD_CALLS and isinstance(owner, ast.Name) and owner.id in {"step_runtime", "sr"}:
                found.append(f"{path.name}:{node.lineno}: step_runtime.{node.func.attr}()")
        if isinstance(node, ast.List):
            words = {e.value for e in node.elts if isinstance(e, ast.Constant) and isinstance(e.value, str)}
            if "backend.app.step_runtime" in words and words & (CAD_WORDS | {"install"}):
                found.append(f"{path.name}:{node.lineno}: a step_runtime install/choose command")
    return found


def test_nothing_installs_cad_at_runtime():
    offenders = []
    for path in sorted(APP.rglob("*.py")):
        if path not in ALLOWED:
            offenders += _offenders(path)
    assert offenders == []


def test_the_scan_sees_an_install_where_it_must_not_be(tmp_path):
    sample = tmp_path / "x.py"
    sample.write_text(
        "from backend.app import step_runtime\n"
        "step_runtime.install(app)\n"
        "cmd = [sys.executable, '-m', 'backend.app.step_runtime', 'install', '--if-enabled']\n",
        encoding="utf-8",
    )
    assert len(_offenders(sample)) == 2
