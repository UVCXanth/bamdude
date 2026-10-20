"""Notification policy through real routing/placement ticks and a real database."""

import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select

from backend.app.models.auto_queue import AutoQueueItem
from backend.app.models.settings import Settings
from backend.app.services import auto_queue_eligibility as eligibility, auto_queue_scheduler as scheduler_module
from backend.tests.integration.test_auto_queue_scheduler import (
    _idle_status,
    _make_printer_with_queue,
    _patch_printer_manager,
    routing_item as routing_item,
    scheduler as scheduler,
)
from backend.tests.integration.test_dispatch_rollback_terminal import test_engine as test_engine


@pytest.fixture
def sent(monkeypatch):
    spy = AsyncMock()
    monkeypatch.setattr("backend.app.services.notification_service.notification_service.on_queue_job_waiting", spy)
    return spy


async def test_busy_for_many_ticks_is_visible_without_notifications(
    db_session, printer_factory, scheduler, routing_item, sent
):
    printer, queue = await _make_printer_with_queue(db_session, printer_factory, model="A1MINI")
    queue.status = "printing"
    item = routing_item(target_model="A1MINI", status="pending", position=1)
    db_session.add(item)
    await db_session.commit()
    one, two = _patch_printer_manager({printer.id})
    with one, two:
        for _ in range(8):
            await scheduler.tick()
    assert item.waiting_reason and item.status == "pending"
    sent.assert_not_awaited()


async def test_permutation_rename_and_copies_do_not_create_incidents(
    db_session, printer_factory, scheduler, routing_item, sent, monkeypatch
):
    p1, _ = await _make_printer_with_queue(db_session, printer_factory, model="A1MINI", name="First")
    p2, _ = await _make_printer_with_queue(db_session, printer_factory, model="A1MINI", name="Second")
    db_session.add(routing_item(target_model="A1MINI", status="pending", position=1))
    await db_session.commit()
    original = eligibility.printers_for_item
    reversed_order = False

    async def printers(*args, **kwargs):
        rows, model, suffix = await original(*args, **kwargs)
        return (list(reversed(rows)) if reversed_order else rows), model, suffix

    monkeypatch.setattr(eligibility, "printers_for_item", printers)
    states = {p1.id: _idle_status(["PETG"]), p2.id: _idle_status(["PETG"])}
    one, two = _patch_printer_manager({p1.id, p2.id}, states)
    with one, two:
        await scheduler.tick()
        reversed_order = True
        await scheduler.tick()
        p1.name = "Renamed"
        db_session.add(routing_item(target_model="A1MINI", status="pending", position=2))
        await db_session.commit()
        await scheduler.tick()
    assert sent.await_count == 1


async def test_actionable_incident_survives_other_jobs_placement(
    db_session, printer_factory, scheduler, routing_item, sent
):
    printer, _ = await _make_printer_with_queue(db_session, printer_factory, model="P1S")
    db_session.add(routing_item(target_model="A1MINI", status="pending", position=1))
    db_session.add(routing_item(target_model="P1S", status="pending", position=2))
    await db_session.commit()
    connected = {printer.id}
    one, two = _patch_printer_manager(connected)
    with one, two:
        await scheduler.tick()
        assert sent.await_count == 1, "placed work must not silence another model's problem"
        another, _ = await _make_printer_with_queue(db_session, printer_factory, model="P1S")
        connected.add(another.id)
        db_session.add(routing_item(target_model="P1S", status="pending", position=3))
        await db_session.commit()
        await scheduler.tick()
        await scheduler.tick()
    assert sent.await_count == 1
    rows = (await db_session.scalars(select(AutoQueueItem).order_by(AutoQueueItem.position))).all()
    assert [item.status for item in rows] == ["pending", "assigned", "assigned"]


async def test_busy_first_item_is_not_the_actionable_message(
    db_session, printer_factory, scheduler, routing_item, sent
):
    printer, queue = await _make_printer_with_queue(db_session, printer_factory, model="P1S")
    queue.status = "printing"
    db_session.add(routing_item(target_model="P1S", status="pending", position=1))
    db_session.add(routing_item(target_model="A1MINI", status="pending", position=2))
    await db_session.commit()
    one, two = _patch_printer_manager({printer.id})
    with one, two:
        await scheduler.tick()
    assert sent.await_count == 1
    assert "A1 Mini" in sent.await_args.kwargs["waiting_reason"]
    assert "occupied" not in sent.await_args.kwargs["waiting_reason"].lower()


async def test_incomplete_rebalance_does_not_publish_or_forget_a_snapshot(
    db_session, printer_factory, scheduler, routing_item, sent, monkeypatch
):
    db_session.add(routing_item(target_model="A1MINI", status="pending", position=1))
    await db_session.commit()
    await scheduler.tick()
    assert sent.await_count == 1
    db_session.add(routing_item(target_model="P1S", status="pending", position=2))
    db_session.add(Settings(key=scheduler_module.REBALANCE_SETTING_KEY, value="true"))
    await db_session.commit()
    monkeypatch.setattr(scheduler_module.queue_rebalance, "rebalance", AsyncMock(side_effect=RuntimeError("test")))
    await scheduler.tick()
    assert sent.await_count == 1, "a partial pass cannot send its new facts"


async def test_locale_telemetry_resolution_empty_queue_and_restart(
    db_session, printer_factory, scheduler, routing_item, sent, monkeypatch
):
    printer, _ = await _make_printer_with_queue(db_session, printer_factory, model="A1MINI")
    item = routing_item(target_model="A1MINI", status="pending", position=1)
    db_session.add(item)
    await db_session.commit()
    states = {printer.id: _idle_status(["PETG"])}
    one, two = _patch_printer_manager({printer.id}, states)
    with one, two:
        await scheduler.tick()
        assert sent.await_count == 1
        monkeypatch.setattr("backend.app.i18n._current_language", "uk")
        states[printer.id].raw_data["ams"][0]["tray"][0]["remain"] = 1
        await scheduler.tick()
        assert sent.await_count == 1
        states[printer.id] = _idle_status(["ASA"])
        await scheduler.tick()
        assert sent.await_count == 2
        await db_session.delete(item)
        await db_session.commit()
        await scheduler.tick()
        assert not scheduler._active_waiting_facts
        db_session.add(routing_item(target_model="A1MINI", status="pending", position=1))
        await db_session.commit()
        await scheduler.tick()
        assert sent.await_count == 3
        scheduler.stop()
        assert not scheduler._active_waiting_facts
        await scheduler.tick()
        assert sent.await_count == 4, "one event after process restart is permitted"


async def test_commit_failure_does_not_publish_or_advance_seen_facts(
    db_session, scheduler, routing_item, sent, monkeypatch
):
    db_session.add(routing_item(target_model="A1MINI", status="pending", position=1))
    await db_session.commit()
    await scheduler.tick()
    previous = set(scheduler._active_waiting_facts)
    db_session.add(routing_item(target_model="P1S", status="pending", position=2))
    await db_session.commit()
    original = db_session.commit
    monkeypatch.setattr(db_session, "commit", AsyncMock(side_effect=RuntimeError("commit refused")))
    with pytest.raises(RuntimeError, match="commit refused"):
        await scheduler.tick()
    assert scheduler._active_waiting_facts == previous
    assert sent.await_count == 1
    monkeypatch.setattr(db_session, "commit", original)
    await db_session.rollback()
    await scheduler.tick()
    assert sent.await_count == 2
    assert "P1S" in sent.await_args.kwargs["waiting_reason"]
    assert "A1 Mini" not in sent.await_args.kwargs["waiting_reason"], "only new facts belong in the digest"


async def test_delivery_failure_is_not_retried_and_send_follows_commit(db_session, scheduler, routing_item, sent):
    async def unavailable(**kwargs):
        assert not db_session.in_transaction(), "provider I/O must not hold the placement transaction"
        raise RuntimeError("provider unavailable")

    sent.side_effect = unavailable
    db_session.add(routing_item(target_model="A1MINI", status="pending", position=1))
    await db_session.commit()
    await scheduler.tick()
    await scheduler.tick()
    assert sent.await_count == 1
    db_session.add(routing_item(target_model="P1S", status="pending", position=2))
    await db_session.commit()
    await scheduler.tick()
    assert sent.await_count == 2


async def test_rebalance_removal_and_new_rows_use_the_final_pending_projection(
    db_session, scheduler, routing_item, sent, monkeypatch
):
    item = routing_item(target_model="A1MINI", status="pending", position=1)
    db_session.add(item)
    db_session.add(Settings(key=scheduler_module.REBALANCE_SETTING_KEY, value="true"))
    await db_session.commit()
    once = True

    async def rebalance(db, **kwargs):
        nonlocal once
        if once:
            item.status = "cancelled"
            db.add(routing_item(target_model="P1S", status="pending", position=2))
            once = False
        return SimpleNamespace(converted=0)

    monkeypatch.setattr(scheduler_module.queue_rebalance, "rebalance", rebalance)
    await scheduler.tick()
    sent.assert_not_awaited()
    await scheduler.tick()
    assert sent.await_count == 1
    assert "P1S" in sent.await_args.kwargs["waiting_reason"]
    assert "A1 Mini" not in sent.await_args.kwargs["waiting_reason"]


@pytest.mark.parametrize("kind", ["manual", "scheduled", "cancelled", "failed", "deleted"])
async def test_due_set_changes_resolve_seen_incidents(db_session, scheduler, routing_item, sent, kind):
    item = routing_item(target_model="A1MINI", status="pending", position=1)
    db_session.add(item)
    await db_session.commit()
    await scheduler.tick()
    assert scheduler._active_waiting_facts
    if kind == "manual":
        item.manual_start = True
    elif kind == "scheduled":
        item.scheduled_time = datetime.now(timezone.utc) + timedelta(days=1)
    elif kind == "deleted":
        await db_session.delete(item)
    else:
        item.status = kind
    await db_session.commit()
    await scheduler.tick()
    assert not scheduler._active_waiting_facts
    assert sent.await_count == 1


async def test_many_models_emit_one_bounded_digest(db_session, scheduler, routing_item, sent):
    for position, model in enumerate(["A1MINI", "P1S", "X1C", "H2D", "H2S", "H2C", "A1"]):
        db_session.add(routing_item(target_model=model, status="pending", position=position))
    await db_session.commit()
    await scheduler.tick()
    assert sent.await_count == 1
    payload = sent.await_args.kwargs
    assert len(payload["waiting_reason"].splitlines()) == 6
    assert "2" in payload["waiting_reason"].splitlines()[-1]
    assert len(payload["waiting_reason"]) < 1900
    assert payload["target_model"] == "multiple printer models"


async def test_hold_and_failed_read_do_not_erase_seen_facts(db_session, scheduler, routing_item, sent, monkeypatch):
    db_session.add(routing_item(target_model="A1MINI", status="pending", position=1))
    await db_session.commit()
    await scheduler.tick()
    previous = set(scheduler._active_waiting_facts)
    with monkeypatch.context() as patch:
        patch.setattr("backend.app.services.farm_startup_guard.farm_startup_guard.allowed", lambda: False)
        await scheduler.tick()
    assert scheduler._active_waiting_facts == previous
    with monkeypatch.context() as patch:
        patch.setattr(scheduler, "_fetch_pending", AsyncMock(side_effect=OSError("read failed")))
        with pytest.raises(OSError):
            await scheduler.tick()
    assert scheduler._active_waiting_facts == previous
    await scheduler.tick()
    assert sent.await_count == 1


async def test_stop_during_commit_does_not_repopulate_seen_facts(
    db_session, scheduler, routing_item, sent, monkeypatch
):
    db_session.add(routing_item(target_model="A1MINI", status="pending", position=1))
    await db_session.commit()
    entered, release = asyncio.Event(), asyncio.Event()
    original = db_session.commit

    async def commit():
        entered.set()
        await release.wait()
        await original()

    monkeypatch.setattr(db_session, "commit", commit)
    task = asyncio.create_task(scheduler.tick())
    await asyncio.wait_for(entered.wait(), 5)
    scheduler.stop()
    release.set()
    await asyncio.wait_for(task, 5)
    assert not scheduler._active_waiting_facts
    sent.assert_not_awaited()


@pytest.mark.parametrize("powered_on", [True, False])
async def test_only_a_successful_wake_suppresses_that_printers_offline_fact(
    db_session, printer_factory, smart_plug_factory, scheduler, routing_item, sent, monkeypatch, powered_on
):
    printer, _ = await _make_printer_with_queue(db_session, printer_factory, model="A1MINI")
    await smart_plug_factory(printer_id=printer.id, auto_on=True)
    db_session.add(routing_item(target_model="A1MINI", status="pending", position=1))
    await db_session.commit()
    scheduler._wake_cooldowns = {}
    switch = AsyncMock(return_value=powered_on)
    monkeypatch.setattr(
        "backend.app.services.smart_plug_manager.smart_plug_manager.get_service_for_plug",
        AsyncMock(return_value=SimpleNamespace(turn_on=switch)),
    )
    one, two = _patch_printer_manager(set())
    with one, two:
        await scheduler.tick()
        assert sent.await_count == int(not powered_on)
        await scheduler.tick()
        assert sent.await_count == 1, "still offline next tick is an observed obstacle"
    switch.assert_awaited_once()


async def test_failed_on_keeps_the_existing_one_wake_attempt_per_pass(
    db_session, printer_factory, smart_plug_factory, scheduler, routing_item, sent, monkeypatch
):
    for _ in range(2):
        printer, _ = await _make_printer_with_queue(db_session, printer_factory, model="A1MINI")
        await smart_plug_factory(printer_id=printer.id, auto_on=True)
    for position in range(2):
        db_session.add(routing_item(target_model="A1MINI", status="pending", position=position))
    await db_session.commit()
    scheduler._wake_cooldowns = {}
    switch = AsyncMock(return_value=False)
    monkeypatch.setattr(
        "backend.app.services.smart_plug_manager.smart_plug_manager.get_service_for_plug",
        AsyncMock(return_value=SimpleNamespace(turn_on=switch)),
    )
    one, two = _patch_printer_manager(set())
    with one, two:
        await scheduler.tick()
    switch.assert_awaited_once()
    assert sent.await_count == 1


@pytest.mark.parametrize("reason", ["source_check_busy", "source_timeout"])
async def test_source_wait_or_failure_has_no_duplicate_waiting_event(
    db_session, printer_factory, scheduler, routing_item, sent, monkeypatch, reason
):
    from backend.app.services.filament_requirements import PrintRequirements

    printer, _ = await _make_printer_with_queue(db_session, printer_factory, model="A1MINI")
    item = routing_item(target_model="A1MINI", status="pending", position=1)
    db_session.add(item)
    await db_session.commit()
    monkeypatch.setattr(
        eligibility,
        "read_item_requirements",
        AsyncMock(return_value=PrintRequirements(status="unavailable", reason=reason)),
    )
    one, two = _patch_printer_manager({printer.id})
    with one, two:
        await scheduler.tick()
    sent.assert_not_awaited()
    assert item.status == ("failed" if reason == "source_timeout" else "pending")


async def test_swap_exclusion_does_not_claim_a_printer_is_busy(db_session, printer_factory, routing_item):
    printer, _ = await _make_printer_with_queue(db_session, printer_factory, model="A1MINI")
    item = routing_item(target_model="A1MINI", status="pending", position=1)
    db_session.add(item)
    await db_session.commit()
    one, two = _patch_printer_manager({printer.id})
    with one, two:
        result = await eligibility.find_eligible_printer(
            db_session, item, {printer.id}, exclusion_reasons={printer.id: "swap_request_refused"}
        )
    assert result.facts[0].code == "swap_request_refused"
    assert not result.facts[0].actionable
    assert "occupied" not in result.reason.lower()


@pytest.mark.parametrize("language", ["en", "uk"])
async def test_provider_selection_custom_template_and_no_backfill(
    db_session, scheduler, routing_item, monkeypatch, language
):
    from backend.app.models.notification import NotificationProvider
    from backend.app.models.notification_template import NotificationTemplate
    from backend.app.services.locale_updater import _update_notification_templates
    from backend.app.services.notification_service import NotificationService

    custom = NotificationTemplate(
        event_type="queue_job_waiting",
        name="Own",
        title_template="Custom",
        body_template="OWN {job_name} {target_model} {waiting_reason}",
        is_default=False,
    )
    provider = NotificationProvider(
        name="Isolated", provider_type="ntfy", config="{}", enabled=False, subscribed_events=["on_queue_job_waiting"]
    )
    db_session.add_all([custom, provider, routing_item(target_model="A1MINI", status="pending", position=1)])
    await _update_notification_templates(db_session, language)
    await db_session.commit()
    assert custom.body_template == "OWN {job_name} {target_model} {waiting_reason}"
    service = NotificationService()
    delivery = AsyncMock()
    monkeypatch.setattr(service, "_send_to_providers", delivery)
    monkeypatch.setattr(
        "backend.app.services.notification_service.notification_service.on_queue_job_waiting",
        service.on_queue_job_waiting,
    )
    await scheduler.tick()
    assert delivery.await_count == 1  # The in-app inbox remains an existing channel.
    assert provider not in delivery.await_args.args[0]
    provider.enabled = True
    await db_session.commit()
    await scheduler.tick()
    assert delivery.await_count == 1, "enabling a provider must not backfill a seen incident"
    db_session.add(routing_item(target_model="P1S", status="pending", position=2))
    await db_session.commit()
    await scheduler.tick()
    assert delivery.await_count == 2
    args = delivery.await_args.args
    assert [item.id for item in args[0] if isinstance(item, NotificationProvider)] == [provider.id]
    assert args[1] == "Custom" and args[2].startswith("OWN ")
    assert args[4] == "queue_job_waiting"
