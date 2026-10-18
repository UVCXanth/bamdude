"""The staged Windows payload itself (spec stage B R11, R12, R14; plan Task 6): its embedded Python verifies and
renders with no developer PATH, from a Cyrillic install and data path, refuses a bundle with a missing DLL without
a window, and the payload is exactly what the inventory expects. Nothing is installed: these run the staged tree
that build.py leaves under installers/windows/build/staging, named by BAMDUDE_WINDOWS_STAGING."""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
STAGING = Path(os.environ["BAMDUDE_WINDOWS_STAGING"]) if os.environ.get("BAMDUDE_WINDOWS_STAGING") else None
pytestmark = pytest.mark.skipif(
    os.name != "nt" or STAGING is None or not (STAGING / "python" / "python.exe").is_file(),
    reason="named skip: set BAMDUDE_WINDOWS_STAGING to a built installers/windows/build/staging (run build.py)",
)


def _env(temp: Path) -> dict[str, str]:
    """Nothing of a developer's machine: the system root, a temp dir, and System32 alone on PATH."""
    root = os.environ["SYSTEMROOT"]
    temp.mkdir(parents=True, exist_ok=True)
    return {"SystemRoot": root, "TEMP": str(temp), "TMP": str(temp), "PATH": str(Path(root) / "System32")}


def _helper(python: Path, *args, env: dict, cwd: Path, timeout: float = 600) -> subprocess.CompletedProcess:
    return subprocess.run(
        [str(python), "-m", *args], cwd=str(cwd), env=env, capture_output=True, text=True, timeout=timeout
    )


def _answer(p: subprocess.CompletedProcess) -> dict:
    return json.loads(p.stdout.strip().splitlines()[-1])


def _app_dir_limit() -> int:
    import re

    text = (STAGING / "version.iss").read_text(encoding="utf-8")
    return int(re.search(r"#define StepMaxAppDirLen (\d+)", text).group(1))


@pytest.fixture(scope="module")
def cyrillic_tree():
    """The staged tree in a Cyrillic install directory with a space, EXACTLY at StepMaxAppDirLen — as the installer
    acceptance's S1 lays it down: a limit one unit too generous fails there and nowhere shorter."""
    root = Path(tempfile.mkdtemp(prefix="bd"))  # short, like a real install root
    head = str(root / "Програми BamDude ")
    room = _app_dir_limit() - len(head)
    assert room >= 1, (len(head), _app_dir_limit())
    tree = Path(head + "я" * room)
    assert len(str(tree)) == _app_dir_limit()
    try:
        shutil.copytree(STAGING / "python", tree / "python")
        shutil.copytree(STAGING / "app", tree / "app")
        yield tree
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_the_staged_python_verifies_its_bundle_without_a_dev_path(tmp_path):
    app = STAGING / "app"
    p = _helper(
        STAGING / "python" / "python.exe",
        "backend.app.step_runtime",
        "verify",
        "--app-dir",
        str(app),
        env=_env(tmp_path / "temp"),
        cwd=app,
    )
    assert p.returncode == 0, p.stdout[-2000:]
    assert _answer(p)["ok"] is True


def test_the_staged_tree_renders_a_step_from_a_cyrillic_directory(cyrillic_tree):
    python, app = cyrillic_tree / "python" / "python.exe", cyrillic_tree / "app"
    env = _env(cyrillic_tree / "дані" / "temp")  # a Cyrillic data path too: the probe's work dir lives under TEMP
    verify = _helper(python, "backend.app.step_runtime", "verify", "--app-dir", str(app), env=env, cwd=app)
    assert verify.returncode == 0, verify.stdout[-2000:]
    probe = _helper(python, "backend.app.step_render_probe", "--app-dir", str(app), env=env, cwd=app)
    assert probe.returncode == 0, probe.stdout[-2000:]
    report = _answer(probe)
    assert report["ok"] is True and report["step"]["outcome"] == "ok" and report["step"]["png"] is True


def test_one_unit_past_the_limit_the_bundle_does_not_load(cyrillic_tree):
    """The limit is the loader's, and tight: the same tree one unit longer no longer imports its bundle (a DLL past
    250 units, ERROR_FILENAME_EXCED_RANGE). Should this pass, the limit is stricter than it must be."""
    longer = cyrillic_tree.with_name(cyrillic_tree.name + "я")
    os.rename(cyrillic_tree, longer)
    try:
        python, app = longer / "python" / "python.exe", longer / "app"
        verify = _helper(
            python, "backend.app.step_runtime", "verify", "--app-dir", str(app), env=_env(longer / "t"), cwd=app
        )
        assert verify.returncode == 1 and "smoke_failed:import" in _answer(verify)["problems"], verify.stdout[-2000:]
    finally:
        os.rename(longer, cyrillic_tree)


def test_a_missing_dll_fails_verify_without_a_window(tmp_path):
    """A copy of the bundle without one DLL of its closure: the full verify names it, and the import of that bundle
    — the DLL loader's own path, past the rehash — ends with an error, never a dialog that would hang a hidden
    install-service.bat (both bounded by a timeout)."""
    from backend.app import step_runtime as sr

    staged = STAGING / "app"
    found = sr.locate(staged)
    assert found.ok, found.reason
    fake = Path(tempfile.mkdtemp(prefix="bd"))
    try:
        target = sr.bundle_root(fake) / found.bundle.relative_to(sr.bundle_root(staged))
        shutil.copytree(found.bundle, target)
        dll = next(p for p in (target / "site").rglob("*.dll") if p.name.lower().startswith("tk"))
        dll.unlink()
        env = _env(tmp_path / "temp")
        python = STAGING / "python" / "python.exe"
        verify = _helper(
            python, "backend.app.step_runtime", "verify", "--app-dir", str(fake), env=env, cwd=staged, timeout=300
        )
        assert verify.returncode == 1 and any(p.startswith("closure_missing:") for p in _answer(verify)["problems"])
        imported = _helper(
            python, "backend.app.step_preview_probe", "--site", str(target / "site"), env=env, cwd=staged, timeout=120
        )
        assert imported.returncode != 0  # the loader failed and said so; the process ended on its own
    finally:
        shutil.rmtree(fake, ignore_errors=True)


def test_the_built_payload_is_exact():
    spec = importlib.util.spec_from_file_location("bamdude_windows_build", ROOT / "installers" / "windows" / "build.py")
    build = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(build)
    assert build.step_payload_problems(STAGING / "app") == []


ISCC = Path(
    os.environ.get("BAMDUDE_ISCC") or Path(os.environ.get("LOCALAPPDATA", "")) / "Programs/Inno Setup 6/ISCC.exe"
)
ISS = ROOT / "installers" / "windows" / "bamdude.iss"


@pytest.mark.skipif(not ISCC.is_file(), reason="named skip: no ISCC.exe (BAMDUDE_ISCC or the per-user Inno Setup 6)")
def test_iscc_compiles_the_installer_script_against_the_built_payload():
    """A syntax and [Code] check of the real script with the generated define (/O-: no output written)."""
    p = subprocess.run([str(ISCC), "/O-", "/Q", str(ISS)], capture_output=True, text=True, timeout=600)
    assert p.returncode == 0, (p.stdout + p.stderr)[-2000:]


@pytest.mark.skipif(not ISCC.is_file(), reason="named skip: no ISCC.exe (BAMDUDE_ISCC or the per-user Inno Setup 6)")
def test_iscc_refuses_the_script_without_the_generated_limit(tmp_path):
    copy = tmp_path / "bamdude.iss"
    shutil.copyfile(ISS, copy)  # no build\staging\version.iss beside it: no StepMaxAppDirLen
    p = subprocess.run([str(ISCC), "/O-", "/Q", str(copy)], capture_output=True, text=True, timeout=120)
    assert p.returncode != 0 and "StepMaxAppDirLen" in (p.stdout + p.stderr)
