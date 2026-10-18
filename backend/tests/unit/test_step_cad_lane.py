"""The requires_cad lane and where OCP may be imported (spec §8–§9, plan A1)."""

from __future__ import annotations

import ast
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
APP = ROOT / "backend" / "app"
# The only modules that may import OCP — both run in a disposable child, never in main or the preview service.
OCP_IMPORTERS = {"step_preview_probe.py", "services/step_thumbnail.py"}


def _run_lane(tmp_path: Path, *, strict: bool) -> subprocess.CompletedProcess:
    test = tmp_path / "test_needs_cad.py"
    test.write_text("import pytest\n\n@pytest.mark.requires_cad\ndef test_geometry():\n    pass\n", encoding="utf-8")
    (tmp_path / "pytest.ini").write_text("[pytest]\n", encoding="utf-8")
    env = {**os.environ, "BAMDUDE_STEP_TEST_APP_DIR": str(tmp_path / "no-app")}
    env.pop("BAMDUDE_REQUIRE_CAD", None)
    if strict:
        env["BAMDUDE_REQUIRE_CAD"] = "1"
    return subprocess.run(
        [sys.executable, "-m", "pytest", str(test), "-c", str(tmp_path / "pytest.ini"), "-p", "backend.tests.cad_lane"]
        + ["-p", "no:cacheprovider", "-q"],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )


def test_requires_cad_without_a_bundle_is_a_named_skip(tmp_path):
    p = _run_lane(tmp_path, strict=False)
    assert p.returncode == 0, p.stdout + p.stderr
    assert "1 skipped" in p.stdout


def test_requires_cad_without_a_bundle_fails_the_strict_lane(tmp_path):
    p = _run_lane(tmp_path, strict=True)
    assert p.returncode == 1, p.stdout + p.stderr
    # a setup failure: pytest reports it as an error, and the run is red either way
    assert "1 error" in p.stdout and "requires_cad: STEP-preview bundle not usable (not_installed)" in p.stdout


@pytest.mark.requires_cad
def test_the_installed_bundle_verifies_and_imports_from_itself():
    from backend.app import step_runtime
    from backend.tests.cad_lane import located

    found = located()
    catalog = step_runtime.load_catalog()
    selection = step_runtime.select(catalog)
    assert step_runtime.verify_tree(found.site, catalog.closure["artifacts"][selection.wheel["filename"]]) == []
    assert step_runtime.smoke(found.site) == []


def test_only_child_modules_import_ocp():
    offenders = []
    for path in APP.rglob("*.py"):
        rel = path.relative_to(APP).as_posix()
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=rel)
        for node in ast.walk(tree):
            names = []
            if isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                names = [node.module]
            if any(n == "OCP" or n.startswith("OCP.") for n in names) and rel not in OCP_IMPORTERS:
                offenders.append(f"{rel}:{node.lineno}")
    assert offenders == []


def test_main_never_imports_the_probe_or_the_converter():
    """The probe/converter are child entry points; importing either in a long-lived process would load OCP."""
    offenders = []
    for path in APP.rglob("*.py"):
        rel = path.relative_to(APP).as_posix()
        if rel in OCP_IMPORTERS:
            continue
        text = path.read_text(encoding="utf-8")
        for name in ("step_preview_probe", "services.step_thumbnail"):
            if (
                f"import {name}" in text
                or f"from backend.app.{name} import" in text
                or f"backend.app.{name} import" in text
            ):
                offenders.append(f"{rel}:{name}")
    assert offenders == []


_ACTIVATE = """
import json, sys
from pathlib import Path
foreign, bundle, nofilter = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3] == "1"
sys.path.insert(0, str(foreign))  # a foreign OCP ahead of everything, as a main site-packages copy would be
from backend.app import step_preview_probe
from backend.app.step_preview_probe import BundleOriginError, activate_bundle
if nofilter:  # a path the filter does not recognise: only the origin check is left
    step_preview_probe._foreign = lambda entry, bundle: False
try:
    origin = activate_bundle(bundle)
    print(json.dumps({"origin": str(origin)}))
except (ImportError, BundleOriginError) as exc:
    print(json.dumps({"refused": type(exc).__name__}))
"""


def _activate(tmp_path: Path, bundle: Path, *, nofilter: bool = False) -> dict:
    import json

    foreign = tmp_path / "foreign"
    (foreign / "OCP").mkdir(parents=True)
    (foreign / "OCP" / "__init__.py").write_text("FOREIGN = True\n", encoding="utf-8")
    p = subprocess.run(
        [sys.executable, "-c", _ACTIVATE, str(foreign), str(bundle), "1" if nofilter else "0"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=120,
    )
    return json.loads(p.stdout.strip().splitlines()[-1])


def test_a_foreign_ocp_is_never_imported_instead_of_a_missing_bundle(tmp_path):
    empty = tmp_path / "empty-bundle"
    empty.mkdir()
    assert "refused" in _activate(tmp_path, empty)


def test_the_origin_check_refuses_a_foreign_ocp_the_path_filter_missed(tmp_path):
    empty = tmp_path / "empty-bundle"
    empty.mkdir()
    assert _activate(tmp_path, empty, nofilter=True) == {"refused": "BundleOriginError"}


@pytest.mark.requires_cad
def test_the_bundle_wins_over_a_foreign_ocp(tmp_path):
    from backend.tests.cad_lane import located

    site = located().site
    origin = Path(_activate(tmp_path, site)["origin"])
    assert site.resolve() in origin.parents
