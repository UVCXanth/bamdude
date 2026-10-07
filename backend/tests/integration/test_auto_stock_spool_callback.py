"""Insertion callback deduplication, configuration failures and existing AMS overlay."""

from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import select

from backend.app import main
from backend.app.models.spool_assignment import SpoolAssignment
from backend.app.services import ams_advertised_overlay as overlay
from backend.tests.unit.services.test_auto_stock_spool import event, manager, printer, spool


@pytest.fixture(autouse=True)
def clear_callback_memory():
    main._stock_insertion_seen.clear()
    main._ams_assignment_locks.clear()
    yield
    main._stock_insertion_seen.clear()
    main._ams_assignment_locks.clear()


@pytest.mark.asyncio
@pytest.mark.integration
@pytest.mark.parametrize("published", [True, False, RuntimeError("synthetic publish failure")])
async def test_callback_claims_once_and_reports_failed_configuration(db_session, printer_factory, published):
    p = await printer(printer_factory)
    s = await spool(db_session)
    await spool(db_session)
    pm, state, _ = manager()
    e = event()

    @asynccontextmanager
    async def session():
        try:
            yield db_session
        except BaseException:
            await db_session.rollback()
            raise

    publisher = (
        AsyncMock(side_effect=published) if isinstance(published, Exception) else AsyncMock(return_value=published)
    )
    broadcast = AsyncMock()
    with (
        patch.object(main, "async_session", session),
        patch.object(main.printer_manager, "get_status", pm.get_status),
        patch.object(main.ws_manager, "broadcast", broadcast),
        patch("backend.app.api.routes.inventory.apply_spool_to_slot_via_mqtt", publisher),
        patch.object(overlay, "forget") as forget,
    ):
        await main.on_stock_spool_inserted(p.id, e)
        await main.on_stock_spool_inserted(p.id, e)
    assignments = (await db_session.execute(select(SpoolAssignment))).scalars().all()
    assert [a.spool_id for a in assignments] == [s.id]
    publisher.assert_awaited_once()
    forget.assert_called_once_with(p.id, 0, 0)
    types = [call.args[0]["type"] for call in broadcast.call_args_list]
    assert types.count("spool_auto_assigned") == 1
    assert ("stock_spool_config_failed" in types) is (published is not True)
