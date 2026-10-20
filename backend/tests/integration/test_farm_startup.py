import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from backend.app.api.routes import farm_startup
from backend.app.core.auth import create_access_token
from backend.app.models.user import User
from backend.app.services import farm_startup_guard as module
from backend.app.services.farm_startup_guard import FarmStartupGuard, FarmStartupRefused, manual_service_control


@pytest.fixture
def held(tmp_path, monkeypatch):
    guard = FarmStartupGuard()
    guard.start(tmp_path)
    guard.mark_ready()
    monkeypatch.setattr(module, "farm_startup_guard", guard)
    monkeypatch.setattr(farm_startup, "farm_startup_guard", guard)
    for name in (
        "backend.app.main",
        "backend.app.services.print_scheduler",
        "backend.app.services.auto_queue_scheduler",
        "backend.app.services.smart_plug_manager",
    ):
        monkeypatch.setattr(name + ".farm_startup_guard", guard)
    yield guard
    guard.finish(clean=False)


async def test_authenticated_status_and_cas_release(async_client, held, monkeypatch):
    monkeypatch.setattr(farm_startup, "_reconcile_after_release", AsyncMock())
    response = await async_client.get("/api/v1/system/farm-startup")
    assert response.status_code == 200
    state = response.json()
    assert state["state"] == "held" and state["can_resume"]
    body = {"expected_boot_id": state["boot_id"], "expected_hold_id": state["hold_id"]}
    response = await async_client.post("/api/v1/system/farm-startup/resume", json=body)
    assert response.status_code == 200, response.text
    assert response.json()["result"] == "released"
    before = held.path.read_bytes()
    response = await async_client.post("/api/v1/system/farm-startup/resume", json=body)
    assert response.json()["result"] == "already_released"
    assert held.path.read_bytes() == before
    held.hold("restore")
    response = await async_client.post("/api/v1/system/farm-startup/resume", json=body)
    assert response.status_code == 409
    assert not held.allowed()


async def test_read_only_observer_sees_hold_but_cannot_release(async_client, db_session, held):
    user = User(username="farm_observer", password_hash="unused", role="user", is_active=True)
    db_session.add(user)
    await db_session.commit()
    token = create_access_token(data={"sub": user.username})
    headers = {"Authorization": f"Bearer {token}"}
    response = await async_client.get("/api/v1/system/farm-startup", headers=headers)
    assert response.status_code == 200
    assert response.json()["can_resume"] is False
    state = held.status()
    response = await async_client.post(
        "/api/v1/system/farm-startup/resume",
        headers=headers,
        json={
            "expected_boot_id": state["boot_id"],
            "expected_hold_id": state["hold_id"],
        },
    )
    assert response.status_code == 403
    assert not held.allowed()


async def test_release_storage_failure_and_not_ready(async_client, held, monkeypatch):
    state = held.status()
    body = {"expected_boot_id": state["boot_id"], "expected_hold_id": state["hold_id"]}
    held.ready = False
    assert (await async_client.post("/api/v1/system/farm-startup/resume", json=body)).status_code == 409
    held.mark_ready()
    monkeypatch.setattr(held, "_write", lambda state: (_ for _ in ()).throw(OSError("disk")))
    assert (await async_client.post("/api/v1/system/farm-startup/resume", json=body)).status_code == 503
    assert not held.allowed()


async def test_queues_and_direct_dispatch_do_not_read_sources_or_claim(held, monkeypatch):
    from backend.app.services.auto_queue_scheduler import AutoQueueScheduler
    from backend.app.services.background_dispatch import background_dispatch
    from backend.app.services.print_scheduler import PrintScheduler

    for name in ("print_scheduler", "auto_queue_scheduler", "background_dispatch"):
        monkeypatch.setattr(
            f"backend.app.services.{name}.async_session",
            MagicMock(side_effect=AssertionError("blocked work touched database/source")),
        )
    scheduler = PrintScheduler()
    monkeypatch.setattr(scheduler, "_tick_scheduled_drying", AsyncMock())
    assert await scheduler.check_queue() is False
    scheduler._tick_scheduled_drying.assert_awaited_once_with(set())
    assert await AutoQueueScheduler().tick() is None
    with pytest.raises(FarmStartupRefused):
        await background_dispatch._dispatch(
            kind="print_library_file",
            source_id=999,
            source_name="no source IO",
            printer_id=1,
            printer_name="p",
            options={},
            requested_by_user_id=None,
            requested_by_username=None,
        )


async def test_arbitrary_mqtt_macro_is_refused_before_loading_or_dispatching(held):
    from backend.app.api.routes.macros import execute_macro

    database = AsyncMock()
    with pytest.raises(FarmStartupRefused):
        await execute_macro(1, printer_id=1, db=database, _=None)
    database.execute.assert_not_awaited()


@pytest.mark.parametrize("driver", ["tasmota", "homeassistant", "rest_smart_plug", "mqtt_smart_plug", "zigbee"])
async def test_every_power_driver_blocks_automatic_on_but_allows_typed_manual(held, monkeypatch, driver):
    if driver == "zigbee":
        from backend.app.services.zigbee.driver import ZigbeeSmartPlugService as Service

        method = "_switch"
    elif driver == "tasmota":
        from backend.app.services.tasmota import TasmotaService as Service

        method = "_send_command"
    elif driver == "homeassistant":
        from backend.app.services.homeassistant import HomeAssistantService as Service

        method = "_call_service"
    elif driver == "rest_smart_plug":
        from backend.app.services.rest_smart_plug import RESTSmartPlugService as Service

        method = "_send_request"
    else:
        from backend.app.services.mqtt_smart_plug import MQTTSmartPlugService as Service

        method = "_switch"
    service = Service()
    transport = AsyncMock(return_value={"POWER": "ON"} if driver == "tasmota" else True)
    monkeypatch.setattr(service, method, transport)
    plug = SimpleNamespace(
        id=1,
        name="test",
        ip_address="127.0.0.1",
        username=None,
        password=None,
        ha_entity_id="switch.test",
        rest_on_url="http://127.0.0.1/on",
        rest_method="POST",
        rest_headers=None,
        rest_on_body=None,
        mqtt_command_on="ON",
    )
    assert await service.turn_on(plug) is False
    transport.assert_not_awaited()
    with manual_service_control():
        assert await service.turn_on(plug)
    transport.assert_awaited_once()


def test_actual_paho_publication_blocks_raw_resume_macros_and_heating(held):
    from backend.app.services.bambu_mqtt import BambuMQTTClient

    client = BambuMQTTClient("127.0.0.1", "test", "unused", model="P1S")
    paho = MagicMock()
    client._tee_publishes(paho)
    for packet in (
        {"print": {"command": "project_file"}},
        {"print": {"command": "resume"}},
        {"print": {"command": "gcode_line", "param": "M24"}},
        {"print": {"command": "set_bed_temp", "temp": 60}},
        {"print": {"command": "ams_filament_drying", "mode": 1}},
    ):
        with pytest.raises(FarmStartupRefused):
            paho.publish("request", json.dumps(packet))
    with manual_service_control():
        paho.publish("request", json.dumps({"print": {"command": "gcode_line", "param": "M140 S60"}}))
        with pytest.raises(FarmStartupRefused):
            paho.publish("request", json.dumps({"print": {"command": "resume"}}))
    paho.publish("request", json.dumps({"print": {"command": "stop"}}))
    paho.publish("request", json.dumps({"pushing": {"command": "pushall"}}))


async def test_admitted_power_io_is_owned_through_cancellation(held):
    entered, finish = asyncio.Event(), asyncio.Event()

    @module.guarded_power_on
    async def operation():
        entered.set()
        await finish.wait()
        return True

    state = held.status()
    held.resume(state["boot_id"], state["hold_id"], actor="user:1")
    task = asyncio.create_task(operation())
    await entered.wait()
    held.close_admission()
    task.cancel()
    await asyncio.sleep(0)
    assert not task.done()
    task.cancel()
    finish.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    await module.drain_commands()


async def test_asgi_readiness_is_after_startup_complete_is_delivered(held, monkeypatch):
    held.ready = False
    held.state["hold"] = None
    seen = []

    async def app(scope, receive, send):
        assert not held.allowed()
        await send({"type": "lifespan.startup.complete"})
        assert held.allowed()

    async def send(message):
        seen.append(held.allowed())

    await module.FarmReadyMiddleware(app)({"type": "lifespan"}, None, send)
    assert seen == [False]


@pytest.mark.parametrize("scope", [[], [1]])
async def test_scoped_key_cannot_release_global_hold(async_client, held, scope):
    made = await async_client.post(
        "/api/v1/api-keys/",
        json={
            "name": "scoped",
            "can_control_printer": True,
            "printer_ids": scope,
        },
    )
    assert made.status_code == 200, made.text
    async_client.headers.pop("Authorization", None)
    headers = {"X-API-Key": made.json()["key"]}
    state = held.status()
    response = await async_client.get("/api/v1/system/farm-startup", headers=headers)
    assert response.status_code == 200 and not response.json()["can_resume"]
    response = await async_client.post(
        "/api/v1/system/farm-startup/resume",
        headers=headers,
        json={
            "expected_boot_id": state["boot_id"],
            "expected_hold_id": state["hold_id"],
        },
    )
    assert response.status_code == 403
    assert not held.allowed()


async def test_unauthenticated_cannot_observe_or_release(async_client, held):
    async_client.headers.pop("Authorization", None)
    assert (await async_client.get("/api/v1/system/farm-startup")).status_code == 401


def test_generation_checked_at_publication_even_after_gate_reopens(held):
    state = held.status()
    held.resume(state["boot_id"], state["hold_id"], actor="test")
    token = module._admitted_generation.set(held.generation)
    try:
        held.hold("restore")
        state = held.status()
        held.resume(state["boot_id"], state["hold_id"], actor="test")
        with pytest.raises(FarmStartupRefused), held.publication({"print": {"command": "project_file"}}):
            pytest.fail("stale dispatch published")
    finally:
        module._admitted_generation.reset(token)


async def test_revocation_while_resume_waits_is_rechecked(async_client, held, db_session, monkeypatch):
    from sqlalchemy import update

    lock = asyncio.Lock()
    await lock.acquire()
    monkeypatch.setattr(farm_startup, "_resume_lock", lock)
    entered = asyncio.Event()
    gate = farm_startup._resume_permission

    async def observed_gate(**kwargs):
        value = await gate(**kwargs)
        entered.set()
        return value

    monkeypatch.setattr(farm_startup, "_resume_permission", observed_gate)
    state = held.status()
    request = asyncio.create_task(
        async_client.post(
            "/api/v1/system/farm-startup/resume",
            json={
                "expected_boot_id": state["boot_id"],
                "expected_hold_id": state["hold_id"],
            },
        )
    )
    try:
        await asyncio.wait_for(entered.wait(), 10)
        await db_session.execute(update(User).where(User.username == "test_admin").values(is_active=False))
        await db_session.commit()
        lock.release()
        response = await request
        assert response.status_code in (401, 403), response.text
        assert not held.allowed()
    finally:
        if lock.locked():
            lock.release()
        if not request.done():
            request.cancel()
            await asyncio.gather(request, return_exceptions=True)


async def test_failed_restore_keeps_local_latch_and_backup_has_no_operational_state(held):
    from io import BytesIO

    from fastapi import HTTPException, UploadFile

    from backend.app.api.routes.settings import _restore_backup
    from backend.app.core.config import settings
    from backend.app.services.backup_files import directories

    state = held.status()
    held.resume(state["boot_id"], state["hold_id"], actor="test")
    with pytest.raises(HTTPException):
        await _restore_backup(UploadFile(filename="bad.txt", file=BytesIO(b"bad")), AsyncMock())
    assert held.status()["reason"] == "restore"
    assert not held.allowed()
    assert "runtime-state" not in directories(settings)


def test_existing_firmware_print_cannot_be_resumed_by_operator_under_hold(held):
    from backend.app.services.bambu_mqtt import BambuMQTTClient

    client = BambuMQTTClient("127.0.0.1", "test", "unused", model="P1S")
    client._client = MagicMock()
    client.state.connected = True
    client.state.state = "PAUSE"
    with pytest.raises(FarmStartupRefused):
        client.resume_print()
    client._client.publish.assert_not_called()
    assert client.stop_print()
    client._client.publish.assert_called_once()


async def test_permission_upgrade_seeds_only_administrators(db_session, test_engine):
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from backend.app.migrations import m205_farm_resume_permission as migration
    from backend.app.models.group import Group

    groups = [Group(name=name, permissions=[], is_system=True) for name in ("Administrators", "Operators", "Viewers")]
    db_session.add_all(groups)
    await db_session.commit()
    await migration.seed(async_sessionmaker(test_engine, expire_on_commit=False))
    await migration.seed(async_sessionmaker(test_engine, expire_on_commit=False))
    db_session.expire_all()
    result = (await db_session.scalars(select(Group).order_by(Group.id))).all()
    assert result[0].permissions == ["farm:resume"]
    assert result[1].permissions == result[2].permissions == []


@pytest.mark.parametrize("reconnected", [False, True])
async def test_first_status_waits_for_its_own_reconciliation(
    async_client, printer_factory, held, monkeypatch, reconnected
):
    from backend.app.services.bambu_mqtt import BambuMQTTClient
    from backend.app.services.printer_manager import PrinterManager

    entered, finish = asyncio.Event(), asyncio.Event()
    manager = PrinterManager()
    tasks = []
    monkeypatch.setattr(manager, "_schedule_async", lambda coro: tasks.append(asyncio.create_task(coro)))

    async def reconcile(*args, **kwargs):
        assert kwargs["strict"] is True
        entered.set()
        await finish.wait()

    def connect(client):
        # The manager must attach identity before MQTT can call back.
        assert client._farm_printer_id == printer.id
        client.state.connected = True
        client.state.connection_generation = 7
        held.printer_connecting(printer.id, 7)
        client.on_first_status("RUNNING", "same.3mf", "same-run", "")

    monkeypatch.setattr(BambuMQTTClient, "connect", connect)
    monkeypatch.setattr("backend.app.services.print_reconciliation.reconcile_printer_prints", reconcile)
    monkeypatch.setattr("backend.app.main.maybe_register_external_stagger", AsyncMock())
    printer = await printer_factory()
    state = held.status()
    held.resume(state["boot_id"], state["hold_id"], actor="test")
    assert await manager.connect_printer(printer)
    await entered.wait()
    assert not held.allowed(printer.id)
    if reconnected:
        held.printer_connecting(printer.id, 8)
        manager.get_client(printer.id).state.connection_generation = 8
    finish.set()
    await asyncio.gather(*tasks)
    assert held.allowed(printer.id) is (not reconnected)


@pytest.mark.parametrize("live_state", ["RUNNING", "PREPARE", "PAUSE"])
async def test_firmware_recovered_run_keeps_its_archive_and_queue_identity(
    held,
    db_session,
    printer_factory,
    archive_factory,
    live_state,
    monkeypatch,
):
    from sqlalchemy import func, select

    from backend.app.models.archive import PrintArchive
    from backend.app.models.print_queue import PrintQueueItem
    from backend.app.models.printer_queue import PrinterQueue
    from backend.app.services.print_reconciliation import _reconcile

    printer = await printer_factory()
    archive = await archive_factory(printer.id, filename="same.3mf", subtask_id="existing-run", status="printing")
    queue = await db_session.get(PrinterQueue, printer.id)
    if queue is None:
        queue = PrinterQueue(id=printer.id, printer_id=printer.id, status="printing")
        db_session.add(queue)
        await db_session.flush()
    item = PrintQueueItem(queue_id=queue.id, archive_id=archive.id, status="printing", position=1)
    db_session.add(item)
    await db_session.flush()
    queue.status = "printing"
    queue.current_item_id = item.id
    await db_session.commit()
    archive_id, item_id = archive.id, item.id
    commands = MagicMock()
    monkeypatch.setattr("backend.app.services.printer_manager.printer_manager.start_print", commands)
    await _reconcile(db_session, printer.id, live_state, "same.3mf", "existing-run")
    await db_session.commit()
    await db_session.refresh(item)
    await db_session.refresh(archive)
    assert await db_session.scalar(select(func.count()).select_from(PrintArchive)) == 1
    assert archive.id == archive_id and archive.status == "printing"
    assert item.id == item_id and item.archive_id == archive_id and item.status == "printing"
    commands.assert_not_called()
    assert not held.allowed()


async def test_pending_table_change_keeps_owed_stage_during_hold(held, db_session, printer_factory, archive_factory):
    from backend.app.services import swap_terminal
    from backend.app.services.print_reconciliation import _resolve_pending_swaps

    printer = await printer_factory()
    extra = {
        "swap_macro_events_pending": ["swap_mode_change_table"],
        "bamdude_terminal_effects": {"swap_change_table": {"stage": "owed"}},
    }
    archive = await archive_factory(printer.id, status="completed", extra_data=extra)
    await _resolve_pending_swaps(printer.id, [archive.id])
    assert (
        await swap_terminal.claim_change_table(
            MagicMock(side_effect=AssertionError("held macro opened a writer")),
            archive.id,
            queue_id=printer.id,
            owner="test",
            allow_absent=False,
        )
        == swap_terminal.CLAIM_HELD
    )
    await db_session.refresh(archive)
    assert archive.extra_data == extra
