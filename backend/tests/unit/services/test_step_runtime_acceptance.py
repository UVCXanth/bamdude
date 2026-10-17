"""An install's success, and a full verify, are a real STEP→STL→PNG with the exact bundle (spec §8, Codex A-R4).

Importing OCP and building a reader proves neither the translator nor the picture. ``smoke`` converts the shipped
probe fixture with the converter child, renders its PNG with the PNG child — the same modules and environment a
preview uses, never in this process — and checks the picture decodes and shows something. Only the Docker image's
early layer, which has no backend yet, may install with ``--import-only``; it says so, and the image's final
verify after the backend is copied is its acceptance.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from backend.app import step_runtime as sr


@pytest.fixture
def tmp_path(install_tmp_path):
    """Installs need a root as short as a real one (see ``install_tmp_path``), never pytest's deep tmp_path."""
    return install_tmp_path


WIN312 = ["cp312-cp312-win_amd64", "cp312-abi3-win_amd64", "py3-none-win_amd64", "py3-none-any"]


def test_a_reader_that_imports_but_cannot_read_step_is_no_success(tmp_path):
    site = tmp_path / "site"
    ocp = site / "OCP"
    ocp.mkdir(parents=True)
    (ocp / "__init__.py").write_text("", encoding="utf-8")
    (ocp / "STEPControl.py").write_text(
        "class STEPControl_Reader:\n    def ReadFile(self, *args):\n        raise RuntimeError('no translator')\n",
        encoding="utf-8",
    )
    assert sr.import_smoke(site) == []  # what the old smoke checked: it imports and constructs
    assert sr.smoke(site)  # the acceptance: it cannot convert a STEP


@pytest.mark.requires_cad
def test_the_installed_bundle_converts_and_renders_the_probe_fixture():
    from backend.tests.cad_lane import located

    assert sr.smoke(located().site) == []


def test_a_picture_that_shows_nothing_fails_the_acceptance(tmp_path, monkeypatch):
    from PIL import Image

    def blank_render(root: Path, deadline: int) -> list[str]:
        Image.new("RGBA", (64, 64), (0, 0, 0, 0)).save(root / "preview.png")
        return []

    monkeypatch.setattr(sr, "_convert", lambda root, site, deadline: [])
    monkeypatch.setattr(sr, "_render_png", blank_render)
    monkeypatch.setattr(sr, "import_smoke", lambda site: [])
    assert sr.smoke(tmp_path / "site") == ["smoke_failed:png_blank"]


def _catalog(target: Path) -> Path:
    target.mkdir(parents=True, exist_ok=True)
    for name in ("step_runtime_manifest.json", "step_runtime_closure.json"):
        shutil.copyfile(sr.DATA / name, target / name)
    return target


def _pip(cmd, **kwargs):
    (Path(cmd[cmd.index("--target") + 1]) / "OCP").mkdir(parents=True)
    return subprocess.CompletedProcess(cmd, 0, "", "")


def test_an_install_whose_render_fails_publishes_nothing(tmp_path, monkeypatch):
    monkeypatch.setattr(sr, "interpreter_tags", lambda: WIN312)
    monkeypatch.setattr(sr, "verify_tree", lambda site, closure: [])
    monkeypatch.setattr(sr, "import_smoke", lambda site: [])
    monkeypatch.setattr(sr, "_convert", lambda root, site, deadline: ["smoke_failed:convert:render_failed"])
    data, app = _catalog(tmp_path / "data"), tmp_path / "app"
    with pytest.raises(sr.InstallError) as failed:
        sr.install(app, data_dir=data, allow_candidate=True, runner=_pip)
    assert failed.value.reason == "smoke_failed:convert:render_failed"
    assert not sr.locate(app, sr.load_catalog(data)).ok


def test_import_only_is_a_named_early_step_never_the_acceptance(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(sr, "interpreter_tags", lambda: WIN312)
    monkeypatch.setattr(sr, "verify_tree", lambda site, closure: [])
    monkeypatch.setattr(sr, "import_smoke", lambda site: [])
    rendered = []
    monkeypatch.setattr(sr, "_convert", lambda root, site, deadline: rendered.append(site) or [])
    data, app = _catalog(tmp_path / "data"), tmp_path / "app"
    rc = sr.main(["install", "--app-dir", str(app), "--allow-candidate", "--import-only"], runner=_pip, data_dir=data)
    answer = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert rc == 0 and answer["acceptance"] == "import_only" and rendered == []
