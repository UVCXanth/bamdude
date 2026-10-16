"""STEP thumbnail jobs on the real chain (plan A4 RED "upload/ZIP return at the converter barrier"): the upload's
answer arrives while the job has not finished, the converter runs after it, and the picture a real conversion
made is attached to the row by main — or, for a file the watchdog stops, the job fails and the row keeps none."""

from __future__ import annotations

import asyncio
import io
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

from backend.app.models.library import LibraryFile
from backend.app.services import library_preview_jobs as jobs_module, preview_runtime as preview_runtime_module
from backend.app.services.preview_runtime import PreviewRuntime

pytestmark = [pytest.mark.integration, pytest.mark.requires_cad]

ROOT = Path(__file__).resolve().parents[3]
BOX = (ROOT / "backend" / "tests" / "fixtures" / "step" / "authored" / "box_mm.step").read_bytes()


@pytest.fixture
async def chain(tmp_path, monkeypatch):
    from backend.tests.cad_lane import cad_app_dir

    runtime = PreviewRuntime(tmp_path / "preview", app_dir=cad_app_dir())
    await runtime.start()
    assert runtime.ready
    monkeypatch.setattr(preview_runtime_module, "runtime", runtime)
    jobs = jobs_module.start_library_preview_jobs()  # the real attempt and the real read-only checks
    try:
        yield runtime, jobs
    finally:
        assert await jobs.stop("shutdown") is True
        await runtime.stop()


async def _terminal(receipt, seconds: float = 90):
    for _ in range(int(seconds / 0.05)):
        if not receipt.live:
            return receipt
        await asyncio.sleep(0.05)
    raise AssertionError((receipt.state, receipt.error_code))


async def _meshing(runtime, seconds: float = 60) -> None:
    for _ in range(int(seconds / 0.02)):
        for marker in (runtime.staging / "service").glob("*/stage"):
            try:
                if marker.read_text(encoding="ascii") == "mesh":
                    return
            except OSError:
                pass
        await asyncio.sleep(0.02)
    raise AssertionError("the converter never reached its mesh stage")


@pytest.mark.asyncio
async def test_a_real_step_upload_answers_first_and_its_picture_arrives(async_client, db_session, chain):
    _, jobs = chain
    response = await async_client.post(
        "/api/v1/library/files", files={"file": ("bracket.step", BOX, "application/octet-stream")}
    )
    assert response.status_code == 200
    body = response.json()
    receipt = jobs._receipts[body["thumbnail_job"]["receipt_id"]]
    assert receipt.live and body["thumbnail_path"] is None  # answered before any picture existed
    await _terminal(receipt)
    assert (receipt.state, receipt.error_code) == ("succeeded", None)
    row = await db_session.get(LibraryFile, body["id"], populate_existing=True)
    assert row.thumbnail_path
    from backend.app.api.routes.library import to_absolute_path

    png = to_absolute_path(row.thumbnail_path)
    assert png.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"


@pytest.mark.asyncio
async def test_an_upload_returns_while_the_converter_still_meshes(async_client, db_session, chain, tmp_path):
    from backend.tests.cad_lane import located
    from backend.tests.unit.services.test_preview_step_runtime import _DENSE

    runtime, jobs = chain
    dense = tmp_path / "dense.step"
    subprocess.run([sys.executable, "-c", _DENSE, str(located().site), str(dense)], cwd=ROOT, check=True, timeout=300)
    response = await async_client.post(
        "/api/v1/library/files", files={"file": ("dense.step", dense.read_bytes(), "application/octet-stream")}
    )
    receipt = jobs._receipts[response.json()["thumbnail_job"]["receipt_id"]]
    assert receipt.live  # the answer is out
    await _meshing(runtime)  # ...and only now does the converter mesh
    await _terminal(receipt)
    assert (receipt.state, receipt.error_code) == ("failed", "resource_limit")
    row = await db_session.get(LibraryFile, response.json()["id"], populate_existing=True)
    assert row.thumbnail_path is None  # a failed job never publishes


@pytest.mark.asyncio
async def test_a_zip_with_a_step_answers_before_its_picture(async_client, db_session, chain):
    import trimesh

    _, jobs = chain
    content = io.BytesIO()
    with zipfile.ZipFile(content, "w") as archive:
        archive.writestr("part.step", BOX)
        archive.writestr("cube.stl", trimesh.creation.box().export(file_type="stl"))
    response = await async_client.post(
        "/api/v1/library/files/extract-zip", files={"file": ("kit.zip", content.getvalue(), "application/zip")}
    )
    assert response.status_code == 200
    item = next(entry for entry in response.json()["files"] if entry["filename"] == "part.step")
    receipt = jobs._receipts[item["thumbnail_job"]["receipt_id"]]
    assert receipt.live
    await _terminal(receipt)
    assert receipt.state == "succeeded"


def _sliced() -> bytes:
    content = io.BytesIO()
    with zipfile.ZipFile(content, "w") as archive:
        archive.writestr("Metadata/plate_1.gcode", "G1 X1 Y2\n")
    return content.getvalue()


def _box_stl() -> bytes:
    import trimesh

    return trimesh.creation.box().export(file_type="stl")


async def _dense_upload(async_client, tmp_path, jobs):
    from backend.tests.cad_lane import located
    from backend.tests.unit.services.test_preview_step_runtime import _DENSE

    dense = tmp_path / "dense.step"
    subprocess.run([sys.executable, "-c", _DENSE, str(located().site), str(dense)], cwd=ROOT, check=True, timeout=300)
    response = await async_client.post(
        "/api/v1/library/files", files={"file": ("dense.step", dense.read_bytes(), "application/octet-stream")}
    )
    return jobs._receipts[response.json()["thumbnail_job"]["receipt_id"]]


@pytest.mark.asyncio
async def test_no_database_session_is_open_while_cad_runs(async_client, db_session, chain, tmp_path, monkeypatch):
    from backend.app.core import database

    runtime, jobs = chain
    real = database.async_session
    open_sessions = []

    class Counted:
        def __init__(self):
            self.inner = real()

        async def __aenter__(self):
            open_sessions.append(self)
            return await self.inner.__aenter__()

        async def __aexit__(self, *exc):
            open_sessions.remove(self)
            return await self.inner.__aexit__(*exc)

    monkeypatch.setattr(database, "async_session", Counted)
    receipt = await _dense_upload(async_client, tmp_path, jobs)
    await _meshing(runtime)
    assert open_sessions == []  # the converter meshes with no session checked out by the jobs
    await _terminal(receipt)


@pytest.mark.asyncio
async def test_a_series_of_sliced_arrivals_ends_the_job_with_preemption_limit(
    async_client, db_session, chain, tmp_path
):
    runtime, jobs = chain
    receipt = await _dense_upload(async_client, tmp_path, jobs)
    for _ in range(jobs_module.PREEMPTION_LIMIT):
        await _meshing(runtime)  # the job is back at the head, admitted again, and meshing
        async with runtime.attempt({"sliced": (_sliced(), "3mf"), "mesh": (_box_stl(), "stl")}) as high:
            assert high.outcome == "ok"
    await _terminal(receipt)
    assert (receipt.state, receipt.error_code) == ("failed", "preemption_limit")
    assert receipt.execution.preemptions == jobs_module.PREEMPTION_LIMIT


@pytest.mark.asyncio
async def test_a_batch_of_stl_beside_a_step_never_costs_it_a_preemption(async_client, db_session, chain):
    runtime, jobs = chain
    response = await async_client.post(
        "/api/v1/library/files", files={"file": ("bracket.step", BOX, "application/octet-stream")}
    )
    receipt = jobs._receipts[response.json()["thumbnail_job"]["receipt_id"]]
    for _ in range(200):
        if receipt.state == "running":
            break
        await asyncio.sleep(0.02)

    async def stl():
        async with runtime.attempt({"mesh": (_box_stl(), "stl")}, wait_seconds=120) as result:
            return result.outcome

    outcomes = await asyncio.gather(*(stl() for _ in range(4)))
    await _terminal(receipt)
    assert outcomes == ["ok"] * 4
    assert receipt.state == "succeeded" and receipt.execution.preemptions == 0


@pytest.mark.asyncio
async def test_a_service_relaunch_keeps_the_jobs_epoch_and_its_receipts(async_client, db_session, chain):
    import psutil

    from backend.tests.unit.services.test_preview_step_ownership import _real_service

    runtime, jobs = chain
    epoch = jobs.epoch
    old_epoch = runtime.epoch
    _real_service(runtime).kill()
    for _ in range(600):
        if runtime.ready and runtime.service and runtime.epoch != old_epoch:
            break
        await asyncio.sleep(0.05)
    assert runtime.epoch != old_epoch and jobs.epoch == epoch  # the service's epoch is not the jobs'
    response = await async_client.post(
        "/api/v1/library/files", files={"file": ("after.step", BOX, "application/octet-stream")}
    )
    receipt_id = response.json()["thumbnail_job"]["receipt_id"]
    status = await async_client.get("/api/v1/library/thumbnail-jobs", params={"epoch": epoch, "ids": [receipt_id]})
    assert status.status_code == 200 and status.json()["receipts"]
    assert psutil.pid_exists(runtime.service.process.pid)
