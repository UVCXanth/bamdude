from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from backend.app.services import order_plan_submission as service
from backend.app.services.queue_sources import QueueSourceBusy, SourceChanged


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "error,reason",
    [
        (RuntimeError("secret-credential-in-message"), "publication_failed"),
        (SourceChanged("secret-credential-in-message"), "source_changed"),
        (QueueSourceBusy("secret-credential-in-message"), "source_copy_busy"),
        (HTTPException(409, {"code": "inputs_changed", "message": "secret-credential-in-message"}), "inputs_changed"),
    ],
)
async def test_failure_has_closed_reason_and_sanitized_operation_diagnostics(monkeypatch, caplog, error, reason):
    caplog.set_level("DEBUG", logger=service.__name__)
    monkeypatch.setattr(service, "read", AsyncMock(return_value={"status": "pending", "created": [], "remaining": []}))
    monkeypatch.setattr(
        service,
        "_operation",
        AsyncMock(
            return_value=SimpleNamespace(
                request={"parts": [{"entry": {"entry_id": "entry-1"}, "count": 2}]},
            )
        ),
    )
    monkeypatch.setattr(service.authority, "fresh", AsyncMock(return_value=(None, "all", None)))
    result = await service.execute(AsyncMock(), 1, "operation-1", SimpleNamespace(), AsyncMock(side_effect=error))
    assert result["error"] == reason
    assert result["error_entry_id"] == "entry-1"
    assert "operation-1" in caplog.text and "entry-1" in caplog.text
    assert type(error).__name__ in caplog.text
    assert "secret-credential-in-message" not in caplog.text
    assert all(r.exc_info is None for r in caplog.records)
