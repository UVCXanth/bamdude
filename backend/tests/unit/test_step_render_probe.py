"""The preview chain's acceptance where it is installed (plan A7): ``python -m backend.app.step_render_probe`` renders
a cube STL and — where this interpreter has a CAD build — the shipped STEP fixture through the real PreviewRuntime
to a PNG. Exit 0 when every expected picture rendered, 3 when this interpreter has no CAD build and the STL
rendered (armv7: STL only), 1 otherwise — a supported platform without its bundle included."""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from pathlib import Path

import pytest

from backend.app import step_render_probe as probe, step_runtime as sr

WIN312 = ["cp312-cp312-win_amd64", "cp312-abi3-win_amd64", "py3-none-win_amd64", "py3-none-any"]
ARMV7 = ["cp312-cp312-linux_armv7l", "py3-none-any"]


def run(tmp_path: Path) -> tuple[int, dict]:
    return asyncio.run(probe.probe(tmp_path / "app", work=tmp_path / "work"))


def test_an_interpreter_without_a_cad_build_renders_the_stl_and_exits_3(tmp_path, monkeypatch):
    monkeypatch.setattr(sr, "interpreter_tags", lambda: ARMV7)
    rc, report = run(tmp_path)
    assert report["stl"] == {"outcome": "ok", "png": True}
    assert report["step"] == {"outcome": "unsupported"}
    assert rc == sr.EXIT_UNSUPPORTED


def test_a_supported_platform_without_its_bundle_fails(tmp_path, monkeypatch):
    monkeypatch.setattr(sr, "interpreter_tags", lambda: WIN312)
    rc, report = run(tmp_path)
    assert report["stl"]["png"] is True
    assert report["step"] == {"outcome": "not_installed"}
    assert rc == sr.EXIT_FAILED


def test_a_picture_with_nothing_drawn_is_no_picture(tmp_path):
    from PIL import Image

    blank = tmp_path / "blank.png"
    Image.new("RGBA", (64, 64), (0, 0, 0, 0)).save(blank)
    drawn = tmp_path / "drawn.png"
    image = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    image.paste((200, 30, 30, 255), (16, 16, 48, 48))
    image.save(drawn)
    (tmp_path / "text.png").write_bytes(b"not a png")
    assert probe.drawn(blank) is False
    assert probe.drawn(drawn) is True
    assert probe.drawn(tmp_path / "text.png") is False


def test_the_probe_leaves_nothing_in_its_work_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(sr, "interpreter_tags", lambda: ARMV7)
    work = tmp_path / "work"
    asyncio.run(probe.probe(tmp_path / "app", work=work))
    assert not work.exists() or not any(work.iterdir())


@pytest.mark.requires_cad
def test_the_installed_bundle_renders_the_step_fixture(tmp_path):
    from backend.tests.cad_lane import cad_app_dir

    root = Path(sr.__file__).resolve().parents[2]
    p = subprocess.run(
        [sys.executable, "-m", "backend.app.step_render_probe", "--app-dir", str(cad_app_dir())],
        cwd=str(root),
        capture_output=True,
        text=True,
        timeout=600,
    )
    report = json.loads(p.stdout.strip().splitlines()[-1])
    assert p.returncode == 0, report
    assert report["stl"] == {"outcome": "ok", "png": True}
    assert report["step"] == {"outcome": "ok", "png": True, "stage": report["step"]["stage"]}


def test_an_stl_that_does_not_render_fails_the_probe_whatever_the_cad_says(tmp_path, monkeypatch):
    monkeypatch.setattr(sr, "interpreter_tags", lambda: ARMV7)
    monkeypatch.setattr(probe, "_cube_stl", lambda: "solid nothing\nendsolid nothing\n")
    rc, report = run(tmp_path)
    assert report["stl"]["png"] is False
    assert rc == sr.EXIT_FAILED
