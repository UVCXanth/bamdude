"""The CAD bundle's install (spec §8, plan A7): under its platform+ABI lock, into an owned staging of its own key,
through the whole-tree launcher; a dead run's staging of THIS platform is reclaimed even when the pin is already in
place; a failed or interrupted install never touches the last good bundle, another digest or another platform;
an interrupted pip with a grandchild leaves nothing running; an unproven tree keeps its staging."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path

import psutil
import pytest

from backend.app import step_runtime as sr
from backend.app.services import step_runtime_child


@pytest.fixture
def tmp_path(install_tmp_path):
    """Installs need a root as short as a real one (see ``install_tmp_path``), never pytest's deep tmp_path."""
    return install_tmp_path


WIN312 = ["cp312-cp312-win_amd64", "cp312-abi3-win_amd64", "py3-none-win_amd64", "py3-none-any"]


def another_pin_time() -> str:
    """Another manifest digest that keeps the committed pin's own age rule: a day after its pin time. An earlier
    time made a young pin of a release one (its wheels must be 14 days old at pinned_at), so these tests held only
    while the committed pin was a candidate."""
    committed = json.loads((sr.DATA / sr.MANIFEST_NAME).read_text(encoding="utf-8"))["pinned_at"]
    later = datetime.fromisoformat(committed.replace("Z", "+00:00")) + timedelta(days=1)
    return later.strftime("%Y-%m-%dT%H:%M:%SZ")


def catalog_copy(target: Path, **changes) -> Path:
    target.mkdir(parents=True, exist_ok=True)
    for name in ("step_runtime_manifest.json", "step_runtime_closure.json"):
        shutil.copyfile(sr.DATA / name, target / name)
    if changes:
        path = target / "step_runtime_manifest.json"
        manifest = json.loads(path.read_text(encoding="utf-8"))
        manifest.update(changes)
        path.write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    return target


@pytest.fixture
def win(monkeypatch):
    monkeypatch.setattr(sr, "interpreter_tags", lambda: WIN312)


def installed(app: Path, data: Path) -> Path:
    """A bundle `locate` accepts for this catalog (receipt + an OCP dir), as a finished install leaves it."""
    catalog = sr.load_catalog(data)
    sel = sr.select(catalog)
    target = sr.bundle_dir(app, sel.key, catalog.digest)
    (target / "site" / "OCP").mkdir(parents=True)
    (target / "receipt.json").write_text(json.dumps(sr.receipt_for(catalog, sel)), encoding="utf-8")
    return target


def failing(*args, **kwargs):
    return subprocess.CompletedProcess(args, 1, "", "pip: no")


def test_a_dead_runs_staging_of_this_platform_is_reclaimed_even_when_the_pin_is_in_place(tmp_path, win, monkeypatch):
    monkeypatch.setattr(sr, "verify_tree", lambda site, closure: [])  # the pin in place is intact
    monkeypatch.setattr(sr, "smoke", lambda site: [])
    data = catalog_copy(tmp_path / "data")
    app = tmp_path / "app"
    target = installed(app, data)
    root = sr.bundle_root(app)
    mine = root / ".staging" / "win-x64-cp312" / ("a" * 32)
    theirs = root / ".staging" / "linux-x64-cp312" / ("b" * 32)
    for path in (mine, theirs):
        path.mkdir(parents=True)
        (path / "half.whl").write_bytes(b"x")
    assert sr.install(app, data_dir=data, allow_candidate=True, runner=failing) == target
    assert not mine.exists()  # dead, this platform's, reclaimed under its lock
    assert theirs.exists()  # another platform's staging is never touched


def test_a_failed_install_of_a_new_pin_keeps_the_last_good_bundle(tmp_path, win):
    old_data = catalog_copy(tmp_path / "old")
    app = tmp_path / "app"
    last_good = installed(app, old_data)
    new_data = catalog_copy(tmp_path / "new", pinned_at=another_pin_time())  # another manifest digest
    with pytest.raises(sr.InstallError) as failed:
        sr.install(app, data_dir=new_data, allow_candidate=True, runner=failing)
    assert failed.value.reason == "pip_failed"
    assert (last_good / "receipt.json").is_file() and (last_good / "site" / "OCP").is_dir()
    assert not any((sr.bundle_root(app) / ".staging" / "win-x64-cp312").iterdir())  # its own staging went


def test_another_platforms_bundle_is_never_removed(tmp_path, win):
    data = catalog_copy(tmp_path / "data")
    app = tmp_path / "app"
    other = sr.bundle_root(app) / "linux-arm64-cp312" / ("c" * 32)
    (other / "site").mkdir(parents=True)
    with pytest.raises(sr.InstallError):
        sr.install(app, data_dir=data, allow_candidate=True, runner=failing)
    assert other.is_dir()


def test_two_installs_of_one_platform_never_overlap(tmp_path, win):
    data = catalog_copy(tmp_path / "data")
    app = tmp_path / "app"
    order = []

    def slow(*args, **kwargs):
        order.append("start")
        time.sleep(1.0)
        order.append("end")
        return subprocess.CompletedProcess(args, 1, "", "")

    def one():
        with pytest.raises(sr.InstallError):
            sr.install(app, data_dir=data, allow_candidate=True, runner=slow)

    threads = [threading.Thread(target=one) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert order == ["start", "end", "start", "end"]  # serialised by the platform's lock


def test_a_rename_that_fails_leaves_no_half_bundle_and_keeps_the_last_good(tmp_path, win, monkeypatch):
    old_data = catalog_copy(tmp_path / "old")
    app = tmp_path / "app"
    last_good = installed(app, old_data)
    new_data = catalog_copy(tmp_path / "new", pinned_at=another_pin_time())
    monkeypatch.setattr(sr, "verify_tree", lambda site, closure: [])
    monkeypatch.setattr(sr, "smoke", lambda site: [])

    def ok(*args, **kwargs):
        return subprocess.CompletedProcess(args, 0, "", "")

    real_replace = sr.os.replace
    new_target = sr.bundle_dir(app, "win-x64-cp312", sr.load_catalog(new_data).digest)

    def refuse(src, dst):
        if Path(dst) == new_target:  # the bundle's own rename; the staging's records still write
            raise PermissionError(13, "denied")
        return real_replace(src, dst)

    monkeypatch.setattr(sr.os, "replace", refuse)
    with pytest.raises(sr.InstallError) as failed:
        sr.install(app, data_dir=new_data, allow_candidate=True, runner=ok)
    assert failed.value.reason == "rename_failed"
    new_target = sr.bundle_dir(app, "win-x64-cp312", sr.load_catalog(new_data).digest)
    assert not new_target.exists() and last_good.is_dir()


def test_an_interrupted_pip_with_a_grandchild_leaves_nothing_running(tmp_path, win, monkeypatch):
    data = catalog_copy(tmp_path / "data")
    app = tmp_path / "app"
    marker = tmp_path / "grandchild.pid"
    script = tmp_path / "pip_stand_in.py"
    script.write_text(
        "import subprocess, sys, time\n"
        "g = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])\n"
        f"open(r'{marker}', 'w').write(str(g.pid))\n"
        "time.sleep(120)\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(sr, "_pip_command", lambda staging, req, wheels: [sys.executable, str(script)])
    monkeypatch.setattr(sr, "INSTALL_SECONDS", 3)
    with pytest.raises(sr.InstallError) as failed:
        sr.install(app, data_dir=data, allow_candidate=True)  # the real whole-tree launcher
    assert failed.value.reason == "pip_timeout"
    pid = int(marker.read_text())
    assert not psutil.pid_exists(pid) or psutil.Process(pid).status() == psutil.STATUS_ZOMBIE
    assert not any((sr.bundle_root(app) / ".staging" / "win-x64-cp312").iterdir())


def test_an_installer_tree_not_proven_ended_keeps_its_staging(tmp_path, win):
    data = catalog_copy(tmp_path / "data")
    app = tmp_path / "app"

    def unproven(*args, **kwargs):
        raise step_runtime_child.TreeUnproven("still there")

    with pytest.raises(sr.InstallError) as failed:
        sr.install(app, data_dir=data, allow_candidate=True, runner=unproven)
    assert failed.value.reason == "tree_unproven"
    assert any((sr.bundle_root(app) / ".staging" / "win-x64-cp312").iterdir())  # a writer may live: kept


def deepest_staged_library(app: Path, data: Path) -> int:
    """The longest path the Windows DLL loader is asked to open during an install: the catalog's deepest native
    library under a staging site (staging is longer than the final bundle), in UTF-16 units as Windows counts."""
    catalog = sr.load_catalog(data)
    sel = sr.select(catalog)
    site = sr.bundle_root(app).absolute() / ".staging" / sel.key / ("0" * 32) / "site"
    longest = max(len(lib["path"]) for lib in catalog.closure["artifacts"][sel.wheel["filename"]])
    return len(str(site).encode("utf-16-le")) // 2 + 1 + longest


def test_an_app_dir_too_deep_for_the_windows_dll_loader_is_refused_before_pip(tmp_path, win, monkeypatch):
    data = catalog_copy(tmp_path / "data")
    app = tmp_path / "app"
    calls = []

    def runner(*args, **kwargs):
        calls.append(args)
        return failing(*args, **kwargs)

    monkeypatch.setattr(sr, "PATH_LIMIT", deepest_staged_library(app, data) - 1)
    with pytest.raises(sr.InstallError) as refused:
        sr.install(app, data_dir=data, allow_candidate=True, runner=runner)
    assert refused.value.reason == "path_too_long"  # named, never a misleading smoke_failed:import
    assert calls == [] and not app.exists()  # decided before the lock, the staging and pip


def test_an_app_dir_exactly_at_the_limit_goes_on_to_pip(tmp_path, win, monkeypatch):
    data = catalog_copy(tmp_path / "data")
    app = tmp_path / "app"
    monkeypatch.setattr(sr, "PATH_LIMIT", deepest_staged_library(app, data))
    with pytest.raises(sr.InstallError) as failed:
        sr.install(app, data_dir=data, allow_candidate=True, runner=failing)
    assert failed.value.reason == "pip_failed"


def test_a_cyrillic_app_dir_is_counted_in_windows_units(tmp_path, win, monkeypatch):
    data = catalog_copy(tmp_path / "data")
    app = tmp_path / "Програми" / "app"
    monkeypatch.setattr(sr, "PATH_LIMIT", deepest_staged_library(app, data))
    with pytest.raises(sr.InstallError) as failed:
        sr.install(app, data_dir=data, allow_candidate=True, runner=failing)
    assert failed.value.reason == "pip_failed"


def test_only_windows_has_the_dll_path_limit():
    """The loader's own limit, not MAX_PATH - 1: measured 2026-10-18 (installer acceptance S1), a native library at
    250 UTF-16 units loads and at 251 fails with ERROR_FILENAME_EXCED_RANGE, LongPathsEnabled on or off, whatever
    the interpreter or working directory — and a DLL whose dependency lies past it fails too. 259 let a bundle
    through the install's own check only to fail its smoke as `import`."""
    expected = 250 if sys.platform == "win32" else None
    assert expected == sr.PATH_LIMIT


def test_a_new_pin_installs_beside_a_bundle_a_render_holds_open(tmp_path, win, monkeypatch):
    old_data = catalog_copy(tmp_path / "old")
    app = tmp_path / "app"
    last_good = installed(app, old_data)
    library = last_good / "site" / "OCP" / "TKernel.dll"
    library.write_bytes(b"loaded")
    new_data = catalog_copy(tmp_path / "new", pinned_at=another_pin_time())
    monkeypatch.setattr(sr, "verify_tree", lambda site, closure: [])
    monkeypatch.setattr(sr, "smoke", lambda site: [])

    def pip(cmd, **kwargs):
        (Path(cmd[cmd.index("--target") + 1]) / "OCP").mkdir(parents=True)
        return subprocess.CompletedProcess(cmd, 0, "", "")

    with library.open("rb") as held:  # a STEP render in flight has the old bundle's library loaded
        target = sr.install(app, data_dir=new_data, allow_candidate=True, runner=pip)
        assert held.read() == b"loaded"
    assert target != last_good and (target / "receipt.json").is_file()
    assert library.read_bytes() == b"loaded" and (last_good / "receipt.json").is_file()


def test_a_character_outside_the_bmp_counts_as_two_windows_units(tmp_path, win, monkeypatch):
    data = catalog_copy(tmp_path / "data")
    app = tmp_path / "\U0001f5a8" / "app"  # one Python character, a surrogate pair on Windows
    monkeypatch.setattr(sr, "PATH_LIMIT", deepest_staged_library(app, data) - 1)
    with pytest.raises(sr.InstallError) as refused:
        sr.install(app, data_dir=data, allow_candidate=True, runner=failing)
    assert refused.value.reason == "path_too_long"


def test_an_install_another_process_holds_the_lock_of_ends_in_lock_timeout(tmp_path, win, monkeypatch):
    data = catalog_copy(tmp_path / "data")
    app = tmp_path / "app"
    root = sr.bundle_root(app)
    root.mkdir(parents=True)
    ready = tmp_path / "held"
    holder = subprocess.Popen(
        [
            sys.executable,
            "-c",
            "import sys, time\nfrom pathlib import Path\nfrom backend.app import step_runtime as sr\n"
            "with sr._platform_lock(Path(sys.argv[1]), 'win-x64-cp312', 5):\n"
            "    Path(sys.argv[2]).write_text('1')\n    time.sleep(60)\n",
            str(root),
            str(ready),
        ],
        cwd=str(Path(sr.__file__).resolve().parents[2]),
    )
    try:
        deadline = time.monotonic() + 30
        while not ready.exists():
            assert holder.poll() is None and time.monotonic() < deadline
            time.sleep(0.05)
        monkeypatch.setattr(sr, "INSTALL_SECONDS", 0.5)
        with pytest.raises(sr.InstallError) as waited:
            sr.install(app, data_dir=data, allow_candidate=True, runner=failing)
        assert waited.value.reason == "lock_timeout"
        assert not (root / ".staging").exists()  # nothing of it was touched without the lock
    finally:
        holder.kill()
        holder.wait(timeout=30)


def _pip_that_installs(cmd, **kwargs):
    (Path(cmd[cmd.index("--target") + 1]) / "OCP").mkdir(parents=True)
    return subprocess.CompletedProcess(cmd, 0, "", "")


def test_an_installed_pin_answers_ok_only_after_its_own_verify(tmp_path, win, monkeypatch):
    data = catalog_copy(tmp_path / "data")
    app = tmp_path / "app"
    target = installed(app, data)
    checked = []
    monkeypatch.setattr(sr, "verify_tree", lambda site, closure: checked.append(site) or [])
    monkeypatch.setattr(sr, "smoke", lambda site: checked.append(("smoke", site)) or [])
    calls = []
    assert sr.install(app, data_dir=data, allow_candidate=True, runner=lambda *a, **k: calls.append(a)) == target
    assert checked == [target / "site", ("smoke", target / "site")] and calls == []  # verified, nothing installed


def test_a_broken_installed_pin_is_repaired_by_a_verified_replacement(tmp_path, win, monkeypatch):
    data = catalog_copy(tmp_path / "data")
    app = tmp_path / "app"
    target = installed(app, data)
    (target / "site" / "broken.marker").write_text("x", encoding="utf-8")
    monkeypatch.setattr(
        sr, "verify_tree", lambda site, closure: ["closure_missing:x"] if site == target / "site" else []
    )
    monkeypatch.setattr(sr, "smoke", lambda site: [])
    assert sr.install(app, data_dir=data, allow_candidate=True, runner=_pip_that_installs) == target
    assert not (target / "site" / "broken.marker").exists()  # the broken tree was replaced
    assert json.loads((target / "receipt.json").read_text(encoding="utf-8"))["installed_at"]
    assert not any((sr.bundle_root(app) / ".staging" / "win-x64-cp312").iterdir())  # nothing set aside is left


def test_a_failed_repair_leaves_the_installed_tree_as_it_was(tmp_path, win, monkeypatch):
    data = catalog_copy(tmp_path / "data")
    app = tmp_path / "app"
    target = installed(app, data)
    monkeypatch.setattr(sr, "verify_tree", lambda site, closure: ["closure_missing:x"])
    monkeypatch.setattr(sr, "smoke", lambda site: [])
    with pytest.raises(sr.InstallError) as failed:
        sr.install(app, data_dir=data, allow_candidate=True, runner=failing)
    assert failed.value.reason == "pip_failed"
    assert (target / "receipt.json").is_file() and (target / "site" / "OCP").is_dir()


def test_a_stale_tree_under_the_pin_does_not_block_the_install_forever(tmp_path, win, monkeypatch):
    data = catalog_copy(tmp_path / "data")
    app = tmp_path / "app"
    catalog = sr.load_catalog(data)
    target = sr.bundle_dir(app, sr.select(catalog).key, catalog.digest)
    (target / "site").mkdir(parents=True)
    (target / "receipt.json").write_text("{not json", encoding="utf-8")  # a power cut mid-write, an old schema
    monkeypatch.setattr(sr, "verify_tree", lambda site, closure: [])
    monkeypatch.setattr(sr, "smoke", lambda site: [])
    assert sr.install(app, data_dir=data, allow_candidate=True, runner=_pip_that_installs) == target
    assert sr.locate(app, catalog).ok


def test_a_tree_still_in_use_is_named_and_kept(tmp_path, win, monkeypatch):
    data = catalog_copy(tmp_path / "data")
    app = tmp_path / "app"
    target = installed(app, data)
    monkeypatch.setattr(
        sr, "verify_tree", lambda site, closure: ["closure_missing:x"] if site == target / "site" else []
    )
    monkeypatch.setattr(sr, "smoke", lambda site: [])
    real_replace = sr.os.replace

    def locked(src, dst):
        if Path(src) == target:
            raise PermissionError(32, "in use")  # a running converter holds a DLL of it (Windows)
        return real_replace(src, dst)

    monkeypatch.setattr(sr.os, "replace", locked)
    with pytest.raises(sr.InstallError) as refused:
        sr.install(app, data_dir=data, allow_candidate=True, runner=_pip_that_installs)
    assert refused.value.reason == "bundle_in_use"
    assert (target / "receipt.json").is_file()
    assert not any((sr.bundle_root(app) / ".staging" / "win-x64-cp312").iterdir())


def test_an_unproven_tree_keeps_its_staging_with_the_records_that_name_its_writer(tmp_path, win):
    """The real launcher leaves the launch's token and the bootstrap's record when it cannot prove the end: the
    staging stays, and a later install keeps it while that writer may live."""
    from backend.app.services import part_render_tree as tree

    data = catalog_copy(tmp_path / "data")
    app = tmp_path / "app"

    def unproven(*args, records, **kwargs):
        tree.launch(records, "installer")
        tree.record(records / "installer.pid", os.getpid())  # this live process stands in for the writer
        raise step_runtime_child.TreeUnproven("still there")

    with pytest.raises(sr.InstallError) as failed:
        sr.install(app, data_dir=data, allow_candidate=True, runner=unproven)
    assert failed.value.reason == "tree_unproven"
    (kept,) = (sr.bundle_root(app) / ".staging" / "win-x64-cp312").iterdir()
    assert {"owner.pid", "installer.launch", "installer.pid"} <= {p.name for p in kept.iterdir()}
    with pytest.raises(sr.InstallError):
        sr.install(app, data_dir=data, allow_candidate=True, runner=failing)
    assert kept.exists()  # its writer may live: a later install leaves it


def test_an_owner_record_that_cannot_be_written_starts_nothing(tmp_path, win, monkeypatch):
    from backend.app.services import part_render_tree as tree

    data = catalog_copy(tmp_path / "data")
    app = tmp_path / "app"
    calls = []

    def refuse(path, pid):
        raise PermissionError(13, "denied")

    monkeypatch.setattr(tree, "record", refuse)
    with pytest.raises(sr.InstallError) as failed:
        sr.install(app, data_dir=data, allow_candidate=True, runner=lambda *a, **k: calls.append(a))
    assert failed.value.reason == "record_unwritable" and calls == []
    assert not any((sr.bundle_root(app) / ".staging" / "win-x64-cp312").iterdir())  # nothing ran: nothing kept


# --- prune: old CAD after a proven stop (stage B, Task 2) ------------------------------------------------------------


def _digest_dir(app: Path, key: str, digest: str) -> Path:
    path = sr.bundle_root(app) / key / digest / "site"
    path.mkdir(parents=True)
    (path / "x.dll").write_bytes(b"x")
    return path.parent


def test_prune_removes_another_digest_of_this_key_and_keeps_the_current(tmp_path, win):
    data = catalog_copy(tmp_path / "data")
    app = tmp_path / "app"
    current = installed(app, data)
    old = _digest_dir(app, "win-x64-cp312", "d" * 32)
    assert sr.prune(app, data_dir=data) == {"ok": True, "removed": 1, "kept": {}}
    assert not old.exists() and current.is_dir()
    assert sr.locate(app, sr.load_catalog(data, decode_tags=False)).ok


def test_prune_keeps_the_bundle_of_the_code_a_failed_update_rolls_back_to(tmp_path, win, capsys):
    """update.sh prunes before it starts the service, and a start that fails rolls the code back: the previous
    code's pin must still have its bundle then (Codex F1-R1). `--keep-manifest` names that pin by its manifest —
    the old code's own file, kept before the code moved — and only bundles of other pins go."""
    data = catalog_copy(tmp_path / "data")
    app = tmp_path / "app"
    current = installed(app, data)
    previous = json.loads((data / sr.MANIFEST_NAME).read_text(encoding="utf-8"))
    previous["pinned_at"] = "2026-09-01T00:00:00Z"  # the code before this update ran on another pin
    rollback = tmp_path / "previous-manifest.json"
    rollback.write_text(json.dumps(previous, indent=1), encoding="utf-8")
    kept = _digest_dir(app, "win-x64-cp312", sr.hashlib.sha256(sr.canonical(previous)).hexdigest()[:32])
    older = _digest_dir(app, "win-x64-cp312", "d" * 32)
    assert sr.main(["prune", "--app-dir", str(app), "--keep-manifest", str(rollback)], data_dir=data) == 0
    answer = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert answer == {"ok": True, "removed": 1, "kept": {"rollback": 1}}
    assert kept.is_dir() and current.is_dir() and not older.exists()


def test_prune_with_a_rollback_manifest_it_cannot_read_removes_nothing(tmp_path, win, capsys):
    data = catalog_copy(tmp_path / "data")
    app = tmp_path / "app"
    installed(app, data)
    older = _digest_dir(app, "win-x64-cp312", "d" * 32)
    missing = tmp_path / "gone.json"
    assert sr.main(["prune", "--app-dir", str(app), "--keep-manifest", str(missing)], data_dir=data) == 1
    answer = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert answer["ok"] is False and answer["reason"] == "keep_unreadable" and older.is_dir()


def test_prune_without_a_located_bundle_removes_nothing(tmp_path, win, capsys):
    data = catalog_copy(tmp_path / "data")
    app = tmp_path / "app"
    old = _digest_dir(app, "win-x64-cp312", "d" * 32)
    answer = sr.prune(app, data_dir=data)
    assert answer["ok"] is False and answer["removed"] == 0 and old.is_dir()
    assert sr.main(["prune", "--app-dir", str(app)], data_dir=data) == 1
    assert old.is_dir()


def test_prune_other_keys_takes_only_windows_abis(tmp_path, win):
    data = catalog_copy(tmp_path / "data")
    app = tmp_path / "app"
    installed(app, data)
    cp313 = _digest_dir(app, "win-x64-cp313", "e" * 32)
    linux = _digest_dir(app, "linux-x64-cp312", "f" * 32)
    unknown = _digest_dir(app, "foo", "a" * 32)
    assert sr.prune(app, data_dir=data)["removed"] == 0 and cp313.is_dir()
    assert sr.prune(app, other_keys=True, data_dir=data) == {"ok": True, "removed": 1, "kept": {}}
    assert not cp313.exists() and linux.is_dir() and unknown.is_dir()


def test_prune_keeps_a_busy_key_and_goes_on(tmp_path, win):
    data = catalog_copy(tmp_path / "data")
    app = tmp_path / "app"
    installed(app, data)
    old = _digest_dir(app, "win-x64-cp312", "d" * 32)
    busy = _digest_dir(app, "win-x64-cp313", "e" * 32)
    ready = tmp_path / "held"
    holder = subprocess.Popen(
        [
            sys.executable,
            "-c",
            "import sys, time\nfrom pathlib import Path\nfrom backend.app import step_runtime as sr\n"
            "with sr._platform_lock(Path(sys.argv[1]), 'win-x64-cp313', 5):\n"
            "    Path(sys.argv[2]).write_text('1')\n    time.sleep(60)\n",
            str(sr.bundle_root(app)),
            str(ready),
        ],
        cwd=str(Path(sr.__file__).resolve().parents[2]),
    )
    try:
        deadline = time.monotonic() + 30
        while not ready.exists():
            assert holder.poll() is None and time.monotonic() < deadline
            time.sleep(0.05)
        started = time.monotonic()
        answer = sr.prune(app, other_keys=True, lock_seconds=0.2, data_dir=data)
        assert time.monotonic() - started < 3
        assert answer == {"ok": True, "removed": 1, "kept": {"busy": 1}}
        assert not old.exists() and busy.is_dir()
    finally:
        holder.kill()
        holder.wait(timeout=30)


def test_prune_keeps_a_digest_it_cannot_set_aside(tmp_path, win, monkeypatch):
    data = catalog_copy(tmp_path / "data")
    app = tmp_path / "app"
    installed(app, data)
    old = _digest_dir(app, "win-x64-cp312", "d" * 32)
    real = os.replace

    def refuse(src, dst):
        if Path(src) == old:
            raise PermissionError(32, "in use by another process")
        return real(src, dst)

    monkeypatch.setattr(sr.os, "replace", refuse)
    assert sr.prune(app, data_dir=data) == {"ok": True, "removed": 0, "kept": {"in_use": 1}}
    assert old.is_dir()


def test_a_trash_left_by_a_failed_removal_goes_next_time(tmp_path, win, monkeypatch):
    data = catalog_copy(tmp_path / "data")
    app = tmp_path / "app"
    installed(app, data)
    _digest_dir(app, "win-x64-cp312", "d" * 32)
    real = shutil.rmtree
    calls = []

    def once(path, *args, **kwargs):  # shutil is global: only the first removal of a trash fails
        if Path(path).name.startswith(".trash-") and not calls:
            calls.append(path)
            raise OSError(5, "access denied")
        return real(path, *args, **kwargs)

    monkeypatch.setattr(sr.shutil, "rmtree", once)
    assert sr.prune(app, data_dir=data) == {"ok": True, "removed": 0, "kept": {"remove_failed": 1}}
    key_dir = sr.bundle_root(app) / "win-x64-cp312"
    assert [p.name.startswith(".trash-") for p in key_dir.iterdir() if p.name.startswith(".")] == [True]
    assert sr.prune(app, data_dir=data) == {"ok": True, "removed": 1, "kept": {}}
    assert not any(p.name.startswith(".trash-") for p in key_dir.iterdir())


def test_the_trash_is_never_deeper_than_the_bundle(tmp_path, win, monkeypatch):
    """A set-aside bundle is still removed by paths no longer than its own: StepMaxAppDirLen leaves the deepest DLL
    exactly at MAX_PATH, and a longer trash name would put it past the limit (final review I1)."""
    data = catalog_copy(tmp_path / "data")
    app = tmp_path / "app"
    installed(app, data)
    old = _digest_dir(app, "win-x64-cp312", "d" * 32)
    cp313 = _digest_dir(app, "win-x64-cp313", "e" * 32)
    moves = []
    real = os.replace

    def note(src, dst):
        moves.append((Path(src), Path(dst)))
        return real(src, dst)

    monkeypatch.setattr(sr.os, "replace", note)
    assert sr.prune(app, other_keys=True, data_dir=data)["removed"] == 2
    units = lambda p: len(str(p).encode("utf-16-le")) // 2  # noqa: E731
    assert {src for src, _ in moves} == {old, cp313}
    assert all(units(dst) <= units(src) for src, dst in moves), moves


def test_prune_reclaims_a_dead_runs_staging_and_keeps_a_live_writers(tmp_path, win):
    from backend.app.services import part_render_tree as tree

    data = catalog_copy(tmp_path / "data")
    app = tmp_path / "app"
    installed(app, data)
    staging = sr.bundle_root(app) / ".staging" / "win-x64-cp312"
    dead, live = staging / ("a" * 32), staging / ("b" * 32)
    for path in (dead, live):
        path.mkdir(parents=True)
    tree.record(live / sr.OWNER_RECORD, os.getpid())  # this process: a writer that may still live
    tree.launch(live, sr.INSTALLER)
    answer = sr.prune(app, data_dir=data)
    assert answer == {"ok": True, "removed": 1, "kept": {"writer_may_live": 1}}
    assert not dead.exists() and live.is_dir()


def test_prune_answers_without_paths(tmp_path, win, capsys):
    data = catalog_copy(tmp_path / "data")
    app = tmp_path / "app"
    installed(app, data)
    _digest_dir(app, "win-x64-cp312", "d" * 32)
    assert sr.main(["prune", "--app-dir", str(app), "--other-keys"], data_dir=data) == 0
    out = capsys.readouterr().out
    assert json.loads(out) == {"ok": True, "removed": 1, "kept": {}} and str(app) not in out
