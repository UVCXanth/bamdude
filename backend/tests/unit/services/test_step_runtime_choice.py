"""An install's CAD choice and the commands that keep to it (spec stage C R1, R2, R9; plan Task 1): the marker is
an intent written and read only here — anything unreadable is ``none``, never ``enabled`` —, ``install --if-enabled``
touches nothing without it, ``status`` says only what a receipt says ("installed", never "works") and
``status --check`` is the real verify."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from backend.app import step_runtime as sr
from backend.tests.unit.services.test_step_runtime_install import WIN312, catalog_copy, installed


@pytest.fixture
def tmp_path(install_tmp_path):
    return install_tmp_path


@pytest.fixture
def win(monkeypatch):
    monkeypatch.setattr(sr, "interpreter_tags", lambda: WIN312)


def _pip_that_installs(cmd, **kwargs):
    (Path(cmd[cmd.index("--target") + 1]) / "OCP").mkdir(parents=True)
    return subprocess.CompletedProcess(cmd, 0, "", "")


def _never(*args, **kwargs):
    raise AssertionError("no pip, no network, no lock without an enabled choice")


def _answer(capsys) -> dict:
    return json.loads(capsys.readouterr().out.strip().splitlines()[-1])


def _released(tmp_path: Path) -> Path:
    return catalog_copy(tmp_path / "data")  # the candidate pin: a release one of wheels this young is refused


def test_a_choice_is_written_atomically_and_read_back(tmp_path):
    app = tmp_path / "app"
    sr.write_choice(app, "enabled", by="install")
    assert sr.read_choice(app) == "enabled"
    body = json.loads(sr.choice_path(app).read_text(encoding="utf-8"))
    assert body["schema"] == 1 and body["choice"] == "enabled" and body["by"] == "install" and body["decided_at"]
    assert sorted(p.name for p in sr.choice_path(app).parent.iterdir()) == [sr.CHOICE_FILE]


@pytest.mark.parametrize(
    "content",
    [
        json.dumps({"schema": 2, "choice": "enabled"}),
        json.dumps({"schema": 1, "choice": "yes"}),
        "{not json",
        "",
        json.dumps(["enabled"]),
    ],
)
def test_an_unknown_or_broken_choice_reads_none(tmp_path, content):
    app = tmp_path / "app"
    sr.choice_path(app).parent.mkdir(parents=True)
    sr.choice_path(app).write_text(content, encoding="utf-8")
    assert sr.read_choice(app) == "none"


def test_a_directory_where_the_choice_should_be_reads_none(tmp_path):
    app = tmp_path / "app"
    sr.choice_path(app).mkdir(parents=True)
    assert sr.read_choice(app) == "none"


@pytest.mark.parametrize("choice", [None, "disabled"])
def test_install_if_enabled_skips_without_network_lock_or_files_unless_enabled(tmp_path, win, capsys, choice):
    data, app = _released(tmp_path), tmp_path / "app"
    if choice:
        sr.write_choice(app, choice, by="install")
    assert sr.main(["install", "--if-enabled", "--app-dir", str(app)], runner=_never, data_dir=data) == 0
    assert _answer(capsys) == {"ok": True, "skipped": "not_enabled"}
    assert not sr.bundle_root(app).exists()


def test_install_if_enabled_installs_when_enabled(tmp_path, win, capsys, monkeypatch):
    data, app = _released(tmp_path), tmp_path / "app"
    monkeypatch.setattr(sr, "verify_tree", lambda site, closure: [])
    monkeypatch.setattr(sr, "smoke", lambda site: [])
    sr.write_choice(app, "enabled", by="install")
    assert (
        sr.main(
            ["install", "--if-enabled", "--allow-candidate", "--app-dir", str(app)],
            runner=_pip_that_installs,
            data_dir=data,
        )
        == 0
    )
    assert _answer(capsys)["ok"] is True
    assert sr.locate(app, sr.load_catalog(data)).ok


def test_status_says_installed_never_works(tmp_path, win, capsys):
    data, app = _released(tmp_path), tmp_path / "app"
    sr.write_choice(app, "enabled", by="cli")
    assert sr.main(["status", "--app-dir", str(app)], data_dir=data) == 0
    out = capsys.readouterr().out
    assert json.loads(out.strip().splitlines()[-1]) == {"choice": "enabled", "bundle": "missing"}
    assert str(app) not in out
    installed(app, data)
    assert sr.main(["status", "--app-dir", str(app)], data_dir=data) == 0
    assert _answer(capsys) == {"choice": "enabled", "bundle": "installed"}


def test_a_receipt_over_a_broken_site_is_installed_cheaply_and_failed_on_check(tmp_path, win, capsys, monkeypatch):
    data, app = _released(tmp_path), tmp_path / "app"
    installed(app, data)  # a receipt over a site that lacks every library the closure names
    smoked = []
    monkeypatch.setattr(sr, "smoke", lambda site: smoked.append(site) or [])
    assert sr.main(["status", "--app-dir", str(app)], data_dir=data) == 0
    assert _answer(capsys)["bundle"] == "installed"
    assert sr.main(["status", "--check", "--app-dir", str(app)], data_dir=data) == 1
    answer = _answer(capsys)
    assert answer["bundle"].startswith("verify_failed:") and answer["choice"] == "none"
    assert smoked == []  # a tree that is not the pinned one is never smoked


def test_a_check_of_a_sound_tree_says_works(tmp_path, win, capsys, monkeypatch):
    data, app = _released(tmp_path), tmp_path / "app"
    installed(app, data)
    monkeypatch.setattr(sr, "verify_tree", lambda site, closure: [])
    monkeypatch.setattr(sr, "smoke", lambda site: ["smoke_failed:system_library:libGL.so.1"])
    assert sr.main(["status", "--check", "--app-dir", str(app)], data_dir=data) == 1
    assert _answer(capsys)["bundle"] == "smoke_failed:system_library:libGL.so.1"
    monkeypatch.setattr(sr, "smoke", lambda site: [])
    assert sr.main(["status", "--check", "--app-dir", str(app)], data_dir=data) == 0
    assert _answer(capsys)["bundle"] == "works"


def test_a_receipt_of_another_digest_is_not_this_bundle(tmp_path, win, capsys):
    data, app = _released(tmp_path), tmp_path / "app"
    target = installed(app, data)
    target.rename(target.with_name("f" * 32))  # the receipt of an older pin
    assert sr.main(["status", "--app-dir", str(app)], data_dir=data) == 0
    assert _answer(capsys)["bundle"] == "missing"


_POSIX_UNPRIVILEGED = pytest.mark.skipif(
    os.name == "nt" or (hasattr(os, "geteuid") and os.geteuid() == 0),
    reason="named skip: file modes deny writes only to an unprivileged POSIX user",
)


@_POSIX_UNPRIVILEGED
def test_a_choice_that_cannot_be_written_is_permission(tmp_path, capsys):
    app = tmp_path / "app"
    (app / "runtime").mkdir(parents=True)
    (app / "runtime").chmod(0o555)
    try:
        assert sr.main(["choose", "enabled", "--by", "cli", "--app-dir", str(app)]) == 1
        assert _answer(capsys) == {"ok": False, "reason": "permission"}
    finally:
        (app / "runtime").chmod(0o755)


@_POSIX_UNPRIVILEGED
def test_an_unwritable_runtime_is_permission(tmp_path, win, capsys):
    data, app = _released(tmp_path), tmp_path / "app"
    (app / "runtime").mkdir(parents=True)
    (app / "runtime").chmod(0o555)
    try:
        assert sr.main(["install", "--allow-candidate", "--app-dir", str(app)], runner=_never, data_dir=data) == 1
        assert _answer(capsys) == {"ok": False, "reason": "permission"}
    finally:
        (app / "runtime").chmod(0o755)


def test_install_needs_no_writable_home(tmp_path, win, capsys, monkeypatch):
    data, app = _released(tmp_path), tmp_path / "app"
    nowhere = tmp_path / "no-such-home" / "deeper"
    monkeypatch.setenv("HOME", str(nowhere))
    monkeypatch.setenv("USERPROFILE", str(nowhere))
    monkeypatch.setattr(sr, "verify_tree", lambda site, closure: [])
    monkeypatch.setattr(sr, "smoke", lambda site: [])
    assert (
        sr.main(["install", "--allow-candidate", "--app-dir", str(app)], runner=_pip_that_installs, data_dir=data) == 0
    )
    assert not nowhere.exists()


def test_choose_writes_the_marker_through_the_cli(tmp_path, capsys):
    app = tmp_path / "app"
    assert sr.main(["choose", "disabled", "--by", "install", "--app-dir", str(app)]) == 0
    assert _answer(capsys) == {"ok": True, "choice": "disabled"}
    assert sr.read_choice(app) == "disabled"


def test_the_marker_lives_beside_the_bundle_root_not_in_it(tmp_path):
    app = tmp_path / "app"
    assert sr.choice_path(app).parent == sr.bundle_root(app).parent
    assert sys.platform  # the same place on every platform
