"""The per-event ntfy Priority reaches the request (upstream #3139).

The provider dialog builds its priority rows from the provider's event toggles
and stores the map under those names — ``on_print_failed`` — while every sender
is called with the bare event name, ``print_failed``. The lookup missed for
every real notification, so each one went out at the ntfy server's default with
the configured priority sitting untouched in the database. Both spellings are
accepted, bare first, so stored configs keep working without a migration.
"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.app.models.notification import NotificationProvider
from backend.app.services.notification_service import NotificationService


def _client() -> MagicMock:
    response = MagicMock()
    response.status_code = 200
    response.text = "ok"
    client = MagicMock()
    client.post = AsyncMock(return_value=response)
    client.put = AsyncMock(return_value=response)
    return client


async def _headers(config: dict, event_type: str) -> dict:
    service = NotificationService()
    client = _client()
    with patch.object(service, "_get_client", new_callable=AsyncMock, return_value=client):
        ok, _ = await service._send_ntfy(config, "Title", "Body", event_type=event_type)
    assert ok
    return client.post.call_args.kwargs["headers"]


class TestTheLookup:
    @pytest.mark.asyncio
    async def test_the_dialogs_key_serves_the_bare_event_name(self):
        """What the dialog writes against what every sender passes."""
        headers = await _headers({"topic": "farm", "event_priorities": {"on_print_failed": 5}}, "print_failed")
        assert headers.get("Priority") == "5"

    @pytest.mark.asyncio
    async def test_a_bare_key_still_resolves(self):
        headers = await _headers({"topic": "farm", "event_priorities": {"print_failed": 4}}, "print_failed")
        assert headers.get("Priority") == "4"

    @pytest.mark.asyncio
    async def test_an_unmapped_event_keeps_the_servers_default(self):
        headers = await _headers({"topic": "farm", "event_priorities": {"on_print_failed": 5}}, "print_complete")
        assert "Priority" not in headers


class TestFromARealEvent:
    @pytest.mark.asyncio
    async def test_a_finished_print_carries_the_priority_the_dialog_saved(self):
        """End to end: calling ``_send_ntfy`` directly cannot see a caller that
        passes a key shape the lookup does not understand — which is how the
        feature shipped broken."""
        provider = NotificationProvider(
            id=1,
            name="ntfy",
            provider_type="ntfy",
            enabled=True,
            config=json.dumps({"topic": "farm", "event_priorities": {"on_print_complete": 5}}),
            quiet_hours_enabled=False,
            daily_digest_enabled=False,
        )
        service = NotificationService()
        client = _client()
        with (
            patch.object(service, "_get_client", new_callable=AsyncMock, return_value=client),
            patch.object(service, "_get_providers_for_event", new_callable=AsyncMock, return_value=[provider]),
            patch.object(
                service, "_build_message_from_template", new_callable=AsyncMock, return_value=("Done", "Body")
            ),
            patch.object(service, "_update_provider_status", new_callable=AsyncMock),
            patch.object(service, "_log_notification", new_callable=AsyncMock),
        ):
            await service.on_print_complete(1, "X1C", "completed", {"filename": "part.3mf"}, AsyncMock())

        assert client.post.await_count == 1
        assert client.post.call_args.kwargs["headers"].get("Priority") == "5"
