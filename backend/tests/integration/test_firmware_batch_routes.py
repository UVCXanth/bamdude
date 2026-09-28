"""Integration tests for the bulk firmware routes."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest


@pytest.mark.asyncio
async def test_start_batch_returns_run_id(async_client, printer_factory, monkeypatch):
    printer = await printer_factory(model="P1S")

    class FakeSvc:
        async def start_batch(self, targets, actor_id):
            assert len(targets) == 1
            assert targets[0].version == "01.02.03.04"
            return 42

    monkeypatch.setattr("backend.app.api.routes.firmware.firmware_batch_service", FakeSvc())
    monkeypatch.setattr(
        "backend.app.api.routes.firmware.get_firmware_service",
        lambda: SimpleNamespace(
            get_available_versions=AsyncMock(
                return_value=[SimpleNamespace(version="01.02.03.04", download_url="https://example.com/fw.bin")]
            )
        ),
    )
    monkeypatch.setattr("backend.app.api.routes.firmware.firmware_store.list_cached", AsyncMock(return_value=[]))

    r = await async_client.post(
        "/api/v1/firmware/batch",
        json={"targets": [{"printer_id": printer.id, "version": "01.02.03.04"}]},
    )
    assert r.status_code == 200
    assert r.json()["run_id"] == 42


@pytest.mark.asyncio
async def test_batch_preview_excludes_wiki_only_versions(async_client, printer_factory, monkeypatch):
    printer = await printer_factory(model="P2S")
    monkeypatch.setattr(
        "backend.app.api.routes.firmware.get_firmware_service",
        lambda: SimpleNamespace(
            get_available_versions=AsyncMock(
                return_value=[
                    SimpleNamespace(version="01.03.00.00", download_url=""),
                    SimpleNamespace(version="01.02.00.00", download_url="https://example.com/fw.bin"),
                    SimpleNamespace(version="01.01.03.00", download_url=""),
                ]
            )
        ),
    )
    monkeypatch.setattr(
        "backend.app.api.routes.firmware.firmware_store.list_cached",
        AsyncMock(return_value=[SimpleNamespace(version="01.01.03.00")]),
    )

    r = await async_client.post("/api/v1/firmware/batch/preview", json={"targets": [{"printer_id": printer.id}]})
    assert r.status_code == 200
    group = r.json()["groups"][0]
    assert group["available_versions"] == ["01.02.00.00", "01.01.03.00"]
    assert group["default_version"] == "01.02.00.00"
    assert group["cached_versions"] == ["01.01.03.00"]


@pytest.mark.asyncio
async def test_batch_rejects_wiki_only_firmware_before_creating_run(async_client, printer_factory, monkeypatch):
    printer = await printer_factory(model="P2S")
    start = AsyncMock()
    monkeypatch.setattr("backend.app.api.routes.firmware.firmware_batch_service", SimpleNamespace(start_batch=start))
    monkeypatch.setattr(
        "backend.app.api.routes.firmware.get_firmware_service",
        lambda: SimpleNamespace(
            get_available_versions=AsyncMock(return_value=[SimpleNamespace(version="01.03.00.00", download_url="")])
        ),
    )
    monkeypatch.setattr("backend.app.api.routes.firmware.firmware_store.list_cached", AsyncMock(return_value=[]))

    r = await async_client.post(
        "/api/v1/firmware/batch", json={"targets": [{"printer_id": printer.id, "version": "01.03.00.00"}]}
    )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "firmware_file_unavailable"
    start.assert_not_called()


@pytest.mark.asyncio
async def test_start_batch_400_when_no_eligible_printers(async_client, monkeypatch):
    # An unknown printer id resolves to nothing → no eligible targets.
    r = await async_client.post(
        "/api/v1/firmware/batch",
        json={"targets": [{"printer_id": 999999, "version": "01.02.03.04"}]},
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_get_batch_404_for_missing_run(async_client):
    r = await async_client.get("/api/v1/firmware/batch/999999")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_single_printer_update_appears_in_log(async_client, printer_factory):
    """A per-printer (legacy modal) update is recorded into the same log with
    source='single' so the update journal shows both mechanisms."""
    printer = await printer_factory(model="P1S")
    from backend.app.services.firmware_batch import record_single_update

    await record_single_update(
        printer.id, "P1S", from_version="01.00.00.00", to_version="01.02.00.00", status="uploaded"
    )

    r = await async_client.get("/api/v1/firmware/batch")
    assert r.status_code == 200
    runs = r.json()
    single = [run for run in runs if run["source"] == "single"]
    assert single, "single-source run must appear in the log"
    assert single[0]["items"][0]["to_version"] == "01.02.00.00"
    assert single[0]["created_at"]  # timestamp present for the journal
