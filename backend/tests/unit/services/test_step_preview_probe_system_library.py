"""A missing system library is named by its soname (spec stage C R8; plan Task 2): the import smoke of a Linux
bundle whose libGL, libX11, libexpat or zlib is not on the machine says which, so the install scripts can name the
package — and never the loader's raw text or a path."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from backend.app import step_preview_probe as probe, step_runtime as sr
from backend.tests.unit.services.test_step_runtime_install import WIN312, catalog_copy


@pytest.fixture
def tmp_path(install_tmp_path):
    return install_tmp_path


def _probe(monkeypatch, capsys, message: str) -> tuple[int, dict]:
    def broken(site):
        raise ImportError(message)

    monkeypatch.setattr(probe, "activate_bundle", broken)
    rc = probe.main(["--site", "unused"])
    return rc, json.loads(capsys.readouterr().out.strip().splitlines()[-1])


def test_a_missing_system_library_is_named(monkeypatch, capsys):
    rc, answer = _probe(monkeypatch, capsys, "libGL.so.1: cannot open shared object file: No such file or directory")
    assert rc == 1 and answer == {"ok": False, "reason": "system_library:libGL.so.1"}


@pytest.mark.parametrize("soname", probe.SYSTEM_LIBRARIES)
def test_every_listed_library_is_named(monkeypatch, capsys, soname):
    rc, answer = _probe(monkeypatch, capsys, f"{soname}: cannot open shared object file: No such file or directory")
    assert answer["reason"] == f"system_library:{soname}"


def test_a_library_outside_the_list_is_import(monkeypatch, capsys):
    rc, answer = _probe(monkeypatch, capsys, "libfoo.so.3: cannot open shared object file: No such file or directory")
    assert rc == 1 and answer == {"ok": False, "reason": "import"}


def test_the_answer_never_carries_a_path(monkeypatch, capsys):
    message = "/usr/lib/x86_64-linux-gnu/libGL.so.1: cannot open shared object file: No such file or directory"
    _, named = _probe(monkeypatch, capsys, message)
    _, other = _probe(monkeypatch, capsys, "/tmp/x/site/OCP/libbar.so: cannot open shared object file")
    for answer in (named, other):
        assert "/usr" not in json.dumps(answer) and "/tmp" not in json.dumps(answer)
    assert named["reason"] == "system_library:libGL.so.1" and other["reason"] == "import"


def test_a_windows_or_macos_load_failure_is_import(monkeypatch, capsys):
    for message in (
        "DLL load failed while importing OCP: The specified module could not be found.",
        "dlopen(/x/OCP.so, 0x0002): Library not loaded: @rpath/libTKernel.dylib",
    ):
        _, answer = _probe(monkeypatch, capsys, message)
        assert answer["reason"] == "import"


def test_install_and_check_report_the_named_library(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(sr, "interpreter_tags", lambda: WIN312)
    data, app = catalog_copy(tmp_path / "data"), tmp_path / "app"
    named = "smoke_failed:system_library:libX11.so.6"
    monkeypatch.setattr(sr, "verify_tree", lambda site, closure: [])
    monkeypatch.setattr(sr, "smoke", lambda site: [named])

    def pip_that_installs(cmd, **kwargs):
        (Path(cmd[cmd.index("--target") + 1]) / "OCP").mkdir(parents=True)
        return subprocess.CompletedProcess(cmd, 0, "", "")

    assert (
        sr.main(["install", "--allow-candidate", "--app-dir", str(app)], runner=pip_that_installs, data_dir=data) == 1
    )
    assert json.loads(capsys.readouterr().out.strip().splitlines()[-1]) == {"ok": False, "reason": named}


def _libgl_missing() -> bool:
    if not sys.platform.startswith("linux"):
        return False
    import ctypes

    try:
        ctypes.CDLL("libGL.so.1")
    except OSError:
        return True
    return False


@pytest.mark.skipif(not _libgl_missing(), reason="named skip: libGL.so.1 is present (or not Linux)")
def test_the_real_probe_names_a_missing_libgl():
    from backend.tests.cad_lane import located

    found = located()
    if found is None or not getattr(found, "ok", False):
        pytest.skip("named skip: no CAD bundle installed for this interpreter")
    assert sr.import_smoke(found.site) == ["smoke_failed:system_library:libGL.so.1"]
    assert os.name == "posix"
