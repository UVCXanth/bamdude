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


@pytest.mark.asyncio
@pytest.mark.integration
@pytest.mark.parametrize("printer_state", ["IDLE", "RUNNING", "PAUSE"])
@pytest.mark.parametrize("returned_report", ["same", "blank", "reset_color"])
async def test_removing_and_returning_partial_spool_does_not_claim_full_stock(
    db_session, printer_factory, printer_state, returned_report
):
    from backend.tests.unit.services.test_auto_stock_spool import client

    p = await printer(printer_factory)
    partial = await spool(db_session, weight_used=300)
    full = await spool(db_session, added_full=None)
    db_session.add(
        SpoolAssignment(
            spool_id=partial.id,
            printer_id=p.id,
            ams_id=0,
            tray_id=0,
            fingerprint_color=partial.rgba,
            fingerprint_type=partial.material,
        )
    )
    await db_session.commit()
    pm, state, _ = manager()
    state.state = printer_state
    occupied = state.raw_data["ams"]
    empty = [{"id": 0, "tray": [{"id": 0, "exists": False, "state": 9, "tray_type": "", "tray_color": ""}]}]
    detector = client()
    assert detector._stock_spool_insertions(occupied, {"tray_exist_bits": "1"}) == []

    @asynccontextmanager
    async def session():
        yield db_session

    publisher = AsyncMock(return_value=True)
    with (
        patch.object(main, "async_session", session),
        patch.object(main.printer_manager, "get_status", pm.get_status),
        patch.object(main, "printer_state_to_dict", return_value={}),
        patch.object(main, "_repeat_available_for", AsyncMock(return_value=False)),
        patch.object(main.ws_manager, "broadcast", AsyncMock()),
        patch.object(main.ws_manager, "send_printer_status", AsyncMock()),
        patch("backend.app.services.ams_backup_compatibility_apply.rebuild_once", AsyncMock()),
        patch("backend.app.services.filament_low.check_printer", AsyncMock()),
        patch("backend.app.api.routes.inventory.apply_spool_to_slot_via_mqtt", publisher),
    ):
        state.raw_data["ams"] = empty
        assert detector._stock_spool_insertions(empty, {"tray_exist_bits": "0"}) == []
        await main.on_ams_change(p.id, empty)  # real empty-slot auto-unlink path
        state.raw_data["ams"] = occupied
        if returned_report == "blank":
            occupied[0]["tray"][0].update(tray_type="", tray_color="", state=9)
        elif returned_report == "reset_color":
            occupied[0]["tray"][0]["tray_color"] = "000000FF"
        insertions = detector._stock_spool_insertions(occupied, {"tray_exist_bits": "1"})
        assert len(insertions) == 1
        await main.on_ams_change(p.id, occupied)
        await main.on_stock_spool_inserted(p.id, insertions[0])
    assigned = (await db_session.execute(select(SpoolAssignment))).scalars().all()
    assert [a.spool_id for a in assigned] == [partial.id]
    assert all(a.spool_id != full.id for a in assigned)
    publisher.assert_not_awaited()
    await db_session.refresh(partial)
    await db_session.refresh(full)
    assert partial.weight_used == 300 and full.weight_used == 0
