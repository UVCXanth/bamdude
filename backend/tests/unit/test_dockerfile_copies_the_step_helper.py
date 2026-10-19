"""The Docker image installs the STEP-preview CAD component BEFORE the backend is copied (Dockerfile, plan A7): the
helper and its catalog are copied on their own. Every module the helper imports — transitively, lazy imports
included — and its two catalog files must be in that early COPY list, or the build fails at install (or, worse, a
smoke imports a stale module). The list is read from the Dockerfile itself."""

from __future__ import annotations

import ast
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DOCKERFILE = ROOT / "Dockerfile"
ENTRY = ("backend/app/step_runtime.py", "backend/app/step_preview_probe.py")


def _early_copies() -> set[str]:
    text = DOCKERFILE.read_text(encoding="utf-8").replace("\\\n", " ")
    early = text.split("python -m backend.app.step_runtime install", 1)[0]
    copied = set()
    for line in early.splitlines():
        parts = line.split()
        if parts[:1] == ["COPY"] and not any(p.startswith("--from") for p in parts):
            copied.update(p for p in parts[1:-1] if p.startswith("backend/"))
    return copied


def _module_file(module: str) -> str | None:
    path = ROOT / Path(*module.split("."))
    if path.with_suffix(".py").is_file():
        return path.with_suffix(".py").relative_to(ROOT).as_posix()
    if (path / "__init__.py").is_file():
        return (path / "__init__.py").relative_to(ROOT).as_posix()
    return None


def _closure() -> set[str]:
    needed, todo = set(), list(ENTRY)
    while todo:
        rel = todo.pop()
        if rel in needed:
            continue
        needed.add(rel)
        parts = Path(rel).parts
        for i in range(1, len(parts)):  # every package on the way
            init = Path(*parts[:i], "__init__.py").as_posix()
            if (ROOT / init).is_file():
                needed.add(init)
        for node in ast.walk(ast.parse((ROOT / rel).read_text(encoding="utf-8"))):
            names = []
            if isinstance(node, ast.ImportFrom) and node.module and node.module.startswith("backend"):
                names = [node.module] + [f"{node.module}.{alias.name}" for alias in node.names]
            elif isinstance(node, ast.Import):
                names = [alias.name for alias in node.names if alias.name.startswith("backend")]
            for name in names:
                found = _module_file(name)
                if found:
                    todo.append(found)
    return needed


def test_every_module_the_helper_imports_is_copied_before_the_install():
    missing = sorted(_closure() - _early_copies())
    assert missing == []


def test_the_catalog_is_copied_before_the_install():
    copied = _early_copies()
    for name in ("step_runtime_manifest.json", "step_runtime_closure.json"):
        assert f"backend/app/data/{name}" in copied


def test_the_install_runs_in_the_layer_that_removes_pip():
    text = DOCKERFILE.read_text(encoding="utf-8").replace("\\\n", " ")
    (layer,) = [line for line in text.splitlines() if "backend.app.step_runtime install" in line]
    assert layer.lstrip().startswith("RUN") and re.search(r"step_runtime install.*pip uninstall --yes pip", layer)
