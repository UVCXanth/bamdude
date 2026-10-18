"""Retained staging of a proven-dead attempt (spec §4.2): bounded reclaim, then an atomic move of only that owned
UUID directory into quarantine on the same filesystem, counted against the limits until it is reclaimed; a failed
move leaves admission refused (resource_limit) — residue is never hidden and never reused."""

from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path

import pytest

from backend.app.services.worker_staging import CleanupResult, quarantine_owned, quarantine_usage, reclaim_quarantine

GEN = "a" * 32


def attempt_dir(root: Path) -> Path:
    path = root / uuid.uuid4().hex
    path.mkdir(parents=True)
    (path / "mesh.stl").write_bytes(b"x" * 1000)
    return path


def test_an_owned_attempt_is_moved_whole_into_quarantine(tmp_path):
    source = attempt_dir(tmp_path / "staging" / GEN / "main")
    result = quarantine_owned(source, tmp_path / "preview-quarantine", GEN, "main")
    assert result.status == "quarantined"
    assert result.path == tmp_path / "preview-quarantine" / GEN / source.name / "main"
    assert not source.exists() and (result.path / "mesh.stl").read_bytes() == b"x" * 1000
    assert quarantine_usage(tmp_path / "preview-quarantine") == (1000, 1)


@pytest.mark.parametrize("name", ["not-a-uuid", "A" * 32, "a" * 31])
def test_only_a_uuid_attempt_directory_is_ever_moved(tmp_path, name):
    source = tmp_path / "staging" / GEN / "main" / name
    source.mkdir(parents=True)
    assert quarantine_owned(source, tmp_path / "q", GEN, "main").status == "refused"
    assert source.exists()


@pytest.mark.parametrize(("generation", "side"), [("../" + "a" * 29, "main"), (GEN, "../../etc"), (GEN, "other")])
def test_the_target_cannot_be_steered_outside_the_quarantine_root(tmp_path, generation, side):
    source = attempt_dir(tmp_path / "staging" / GEN / "main")
    assert quarantine_owned(source, tmp_path / "q", generation, side).status == "refused"
    assert source.exists()


@pytest.mark.skipif(sys.platform == "win32" and not hasattr(os, "symlink"), reason="named skip: no symlink support")
def test_a_link_is_never_followed_or_moved(tmp_path):
    real = attempt_dir(tmp_path / "elsewhere")
    link_parent = tmp_path / "staging" / GEN / "main"
    link_parent.mkdir(parents=True)
    link = link_parent / real.name
    try:
        if sys.platform == "win32":
            import _winapi

            _winapi.CreateJunction(str(real), str(link))
        else:
            os.symlink(real, link, target_is_directory=True)
    except OSError:
        pytest.skip("named skip: cannot create a link here")
    assert quarantine_owned(link, tmp_path / "q", GEN, "main").status == "refused"
    assert real.exists() and (real / "mesh.stl").exists()


def test_a_cross_filesystem_target_is_refused(tmp_path, monkeypatch):
    import backend.app.services.worker_staging as ws

    source = attempt_dir(tmp_path / "staging" / GEN / "main")
    real_info = ws._info

    def info(path):
        result = real_info(path)
        if "q" in Path(path).parts:
            return os.stat_result((result.st_mode, result.st_ino, result.st_dev + 1, *tuple(result)[3:]))
        return result

    monkeypatch.setattr(ws, "_info", info)
    assert quarantine_owned(source, tmp_path / "q", GEN, "main").status == "refused"
    assert source.exists()


def test_reclaim_removes_what_it_can_and_counts_what_stays(tmp_path, monkeypatch):
    import backend.app.services.worker_staging as ws

    q = tmp_path / "q"
    keep = quarantine_owned(attempt_dir(tmp_path / "s" / GEN / "main"), q, GEN, "main").path
    gone = quarantine_owned(attempt_dir(tmp_path / "s" / GEN / "main"), q, GEN, "service").path
    real = ws.cleanup_owned

    def cleanup(path, **kwargs):
        if Path(path) == keep.parent:
            return CleanupResult("retained_error", path, "PermissionError", 5)
        return real(path, **kwargs)

    monkeypatch.setattr(ws, "cleanup_owned", cleanup)
    reclaim_quarantine(q)
    assert keep.exists() and not gone.exists()
    assert quarantine_usage(q) == (1000, 1)


# --- the runtime ----------------------------------------------------------------------------------------------


def _box() -> bytes:
    import trimesh

    return trimesh.creation.box().export(file_type="stl")


@pytest.fixture
async def runtime(tmp_path):
    from backend.app.services.preview_runtime import PreviewRuntime

    rt = PreviewRuntime(tmp_path / ".cache" / "preview-service")
    from backend.tests.preview_support import started

    await started(rt)
    try:
        yield rt
    finally:
        await rt.stop()


def _failing_main_cleanup(monkeypatch, times: int):
    import backend.app.services.preview_runtime as module

    real = module.cleanup_owned
    left = {"n": times}

    def cleanup(path, **kwargs):
        if Path(path).parent.name == "main" and Path(path).exists() and left["n"] > 0:  # a held, existing dir
            left["n"] -= 1
            return CleanupResult("retained_error", Path(path), "PermissionError", 5)
        return real(path, **kwargs)

    monkeypatch.setattr(module, "cleanup_owned", cleanup)


@pytest.mark.asyncio
async def test_a_main_cleanup_failure_is_quarantined_and_admission_goes_on(runtime, monkeypatch, caplog):
    import logging

    caplog.set_level(logging.WARNING, logger="backend.app.services.preview_runtime")
    _failing_main_cleanup(monkeypatch, times=1)
    async with runtime.attempt({"mesh": (_box(), "stl")}) as first:
        assert first.outcome == "ok"
    assert quarantine_usage(runtime.quarantine)[1] == 1  # moved out of staging, still counted
    assert "staging_quarantined: side=main" in caplog.text
    async with runtime.attempt({"mesh": (_box(), "stl")}) as second:
        assert second.outcome == "ok"  # not blocked by residue
    assert quarantine_usage(runtime.quarantine) == (0, 0)  # the next admission reclaimed it


@pytest.mark.asyncio
async def test_a_failed_quarantine_move_keeps_admission_refused(runtime, monkeypatch):
    import backend.app.services.preview_runtime as module

    _failing_main_cleanup(monkeypatch, times=10)
    monkeypatch.setattr(
        module, "quarantine_owned", lambda path, *a: CleanupResult("retained_error", path, "PermissionError", 5)
    )
    async with runtime.attempt({"mesh": (_box(), "stl")}) as first:
        assert first.outcome == "ok"
    async with runtime.attempt({"mesh": (_box(), "stl")}) as second:
        assert second.outcome == "resource_limit"  # residue never hidden, never reused


@pytest.mark.asyncio
async def test_a_full_quarantine_blocks_admission(runtime, monkeypatch):
    import backend.app.services.preview_runtime as module
    from backend.app.services.preview_protocol import QUARANTINE_ATTEMPTS

    for _ in range(QUARANTINE_ATTEMPTS + 1):
        (runtime.quarantine / runtime.generation / uuid.uuid4().hex / "main").mkdir(parents=True)
    monkeypatch.setattr(module, "reclaim_quarantine", lambda root: [])  # AV still holds them
    async with runtime.attempt({"mesh": (_box(), "stl")}) as result:
        assert result.outcome == "resource_limit"


@pytest.mark.asyncio
async def test_a_residue_that_could_not_move_is_retried_and_admission_recovers(runtime, monkeypatch):
    """One AV lock must not disable previews until a restart: a proven-dead attempt whose cleanup AND move failed
    is reclaimed again at the next admission (spec §4.2 'reclaim is repeated, bounded')."""
    import backend.app.services.preview_runtime as module

    _failing_main_cleanup(monkeypatch, times=1)
    real_move = module.quarantine_owned
    moves = {"n": 0}

    def move(path, *args):
        moves["n"] += 1
        if moves["n"] == 1:
            return CleanupResult("retained_error", path, "PermissionError", 32)
        return real_move(path, *args)

    monkeypatch.setattr(module, "quarantine_owned", move)
    async with runtime.attempt({"mesh": (_box(), "stl")}) as first:
        assert first.outcome == "ok"
    assert any(runtime.staging.rglob("*"))  # the residue is still in staging after both failed
    async with runtime.attempt({"mesh": (_box(), "stl")}) as second:
        assert second.outcome == "ok"  # retried at admission: removed, admission recovers
    assert not any((runtime.staging / "main").iterdir())


@pytest.mark.asyncio
async def test_an_unmovable_residue_blocks_until_its_lock_goes_then_admission_recovers(runtime, monkeypatch, caplog):
    """The retry is repeated at every admission while the lock holds (each one still refused), and the first
    admission after the lock goes reclaims it — the failed retry must not forget the residue."""
    import logging

    import backend.app.services.preview_runtime as module

    caplog.set_level(logging.INFO, logger="backend.app.services.preview_runtime")
    _failing_main_cleanup(monkeypatch, times=2)  # the attempt's own cleanup + the next admission's retry
    monkeypatch.setattr(
        module, "quarantine_owned", lambda path, *a: CleanupResult("retained_error", path, "PermissionError", 32)
    )
    async with runtime.attempt({"mesh": (_box(), "stl")}) as first:
        assert first.outcome == "ok"
    async with runtime.attempt({"mesh": (_box(), "stl")}) as second:
        assert second.outcome == "resource_limit"  # still locked: refused, never reused
    async with runtime.attempt({"mesh": (_box(), "stl")}) as third:
        assert third.outcome == "ok"  # the lock went: the retry removed it
    assert "staging_residue_reclaimed: side=main" in caplog.text
    assert not any((runtime.staging / "main").iterdir())


@pytest.mark.parametrize("attempt", ["../" + "a" * 29, "A" * 32, "a" * 31, None])
def test_a_service_cleanup_report_for_a_foreign_attempt_name_records_nothing(tmp_path, attempt):
    from backend.app.services.preview_runtime import PreviewRuntime

    rt = PreviewRuntime(tmp_path / ".cache" / "preview-service")
    rt.staging = rt.root / "staging" / rt.generation
    rt._service_cleanup_reply({"staging_cleanup": {"path": "x", "quarantined": False}}, attempt)
    assert rt._dead_residue == {}


def test_a_service_cleanup_report_never_names_its_own_path(tmp_path):
    """Main rebuilds the service attempt path from the attempt id; the reply's path is only logged."""
    from backend.app.services.preview_runtime import PreviewRuntime

    rt = PreviewRuntime(tmp_path / ".cache" / "preview-service")
    rt.staging = rt.root / "staging" / rt.generation
    attempt = uuid.uuid4().hex
    (rt.staging / "service" / attempt).mkdir(parents=True)
    rt._service_cleanup_reply(
        {
            "staging_cleanup": {
                "path": "C:/Windows/System32",
                "error": "PermissionError",
                "code": 5,
                "quarantined": False,
            }
        },
        attempt,
    )
    assert rt._dead_residue == {rt.staging / "service" / attempt: "service"}
