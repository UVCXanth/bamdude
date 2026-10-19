"""Real broker/process regression for common library file preparation."""

from __future__ import annotations

import asyncio
import logging
import zipfile

import pytest
from defusedxml.common import DefusedXmlException

from backend.app.services.library_file_preparation import EXTRACTION_KEY, prepare_file
from backend.app.services.library_file_runtime import LibraryFileRuntime
from backend.app.services.local_worker_broker import LocalWorkerBroker


def make_plates(path, indices):
    with zipfile.ZipFile(path, "w") as archive:
        for index in indices:
            archive.writestr(f"Metadata/plate_{index}.gcode", "M73 L1\nG1 E2\n")


def test_preparation_keeps_real_plate_indices_and_complete_empty_cache(tmp_path):
    file = tmp_path / "Плити.gcode.3mf"
    make_plates(file, range(1, 33))
    result = prepare_file(file, root=tmp_path)
    assert [plate["index"] for plate in result.metadata["plates"]] == list(range(1, 33))
    assert result.metadata["is_multi_plate"] is True
    assert result.metadata[EXTRACTION_KEY]["hash"] == result.digest

    make_plates(file, [2, 7])
    result = prepare_file(file, root=tmp_path)
    assert [plate["index"] for plate in result.metadata["plates"]] == [2, 7]

    with zipfile.ZipFile(file, "w") as archive:
        archive.writestr("3D/3dmodel.model", "<model/>")
    result = prepare_file(file, root=tmp_path)
    assert result.metadata["plates"] == []
    assert result.metadata["is_multi_plate"] is False


def test_present_but_broken_metadata_is_not_a_complete_snapshot(tmp_path):
    file = tmp_path / "broken.3mf"
    with zipfile.ZipFile(file, "w") as archive:
        archive.writestr("Metadata/plate_1.gcode", "G1 X1")
        archive.writestr("Metadata/project_settings.config", "{broken")
    with pytest.raises(ValueError):
        prepare_file(file, root=tmp_path)


def test_preparation_rejects_xml_entities_in_3mf_metadata(tmp_path):
    file = tmp_path / "entity.3mf"
    with zipfile.ZipFile(file, "w") as archive:
        archive.writestr(
            "Metadata/slice_info.config",
            '<!DOCTYPE config [<!ENTITY x "expanded">]><config>&x;</config>',
        )
    with pytest.raises(DefusedXmlException):
        prepare_file(file, root=tmp_path)


@pytest.mark.asyncio
async def test_real_worker_prepares_and_walks_in_pages(tmp_path, caplog):
    broker = LocalWorkerBroker(tmp_path / ".cache" / "preview-service")
    await broker.start()
    runtime = LibraryFileRuntime(tmp_path, broker)
    try:
        await runtime.start()
        file = tmp_path / "part.gcode.3mf"
        make_plates(file, range(1, 33))
        with caplog.at_level(logging.INFO, logger="backend.app.services.library_file_runtime"):
            result = await runtime.prepare(file, root=tmp_path)
        assert len(result.metadata["plates"]) == 32
        assert "Library file worker parsing file='part.gcode.3mf'" in caplog.text
        assert "outcome=ok plates=32" in caplog.text
        broken = tmp_path / "broken.3mf"
        broken.write_bytes(b"not a ZIP")
        with (
            caplog.at_level(logging.INFO, logger="backend.app.services.library_file_runtime"),
            pytest.raises(RuntimeError, match="BadZipFile"),
        ):
            await runtime.prepare(broken, root=tmp_path)
        assert "outcome=failed plates=-" in caplog.text
        assert "reason='library file service BadZipFile'" in caplog.text
        token = await runtime.walk_start(tmp_path, False)
        entries = []
        while True:
            page = await runtime.walk_next(tmp_path, token)
            entries.extend(page["entries"])
            if page["done"]:
                break
        assert any(item.get("name") == file.name for item in entries)
        async with runtime.slot:
            await runtime.retire()
            await runtime.launch()
        assert len((await runtime.prepare(file, root=tmp_path)).metadata["plates"]) == 32
    finally:
        await runtime.stop()
        await broker.stop()


@pytest.mark.asyncio
async def test_a_restart_drops_the_previous_generations_bucket_only(tmp_path):
    # Every start names a fresh bucket that reserves its max_bytes against the
    # broker's max_file_store, and the store outlives the process: without the
    # sweep, the third leftover filled the 3 GB store beside preview + analysis
    # and the next start failed with "insufficient storage resources available".
    # Another consumer's bucket must survive the sweep.
    from nats.js.api import ObjectStoreConfig

    broker = LocalWorkerBroker(tmp_path / ".cache" / "preview-service")
    await broker.start()
    try:
        js = broker.nc.jetstream()
        await js.create_object_store(
            bucket="foreign", config=ObjectStoreConfig(bucket="foreign", max_bytes=1024**2, storage="file")
        )
        for _ in range(2):
            runtime = LibraryFileRuntime(tmp_path, broker)
            await runtime.start()
            await runtime.stop()
        names = sorted(stream.config.name for stream in await js.streams_info())
        assert names == sorted(["OBJ_foreign", f"OBJ_{runtime.bucket}"])
    finally:
        await broker.stop()


@pytest.mark.asyncio
async def test_worker_crash_restarts_without_restarting_broker(tmp_path):
    broker = LocalWorkerBroker(tmp_path / ".cache" / "preview-service")
    await broker.start()
    runtime = LibraryFileRuntime(tmp_path, broker)
    try:
        await runtime.start()
        file = tmp_path / "plates.gcode.3mf"
        make_plates(file, [1, 2])
        old_pid = runtime.worker.process.pid
        runtime.worker.process.kill()

        async def restarted():
            while runtime.worker is None or runtime.worker.process.pid == old_pid or not runtime.ready:
                await asyncio.sleep(0.2)

        await asyncio.wait_for(restarted(), timeout=30)
        assert len((await runtime.prepare(file, root=tmp_path)).metadata["plates"]) == 2
        assert broker.nc.is_connected
    finally:
        await runtime.stop()
        await broker.stop()
