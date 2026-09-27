"""HA entity bindings persist independently of the Zigbee device model."""

from contextlib import asynccontextmanager
from datetime import timedelta
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import select

from backend.app.models.ha_sensor_history import HASensorHistory
from backend.app.models.location import Location
from backend.app.models.location_ha_sensor import LocationHASensor
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer_ha_sensor import PrinterHASensor
from backend.app.models.printer_queue import PrinterQueue
from backend.app.models.smart_sensor import SmartSensor
from backend.app.models.smart_sensor_binding import SmartSensorBinding
from backend.app.services.ha_sensor_manager import HASensorManager, SensorReading, record_ha_reading, utcnow_naive
from backend.app.services.homeassistant import homeassistant_service
from backend.app.services.print_scheduler import PrintScheduler

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]


async def test_printer_ha_bindings_allow_shared_entity_and_validate_rules(async_client, printer_factory):
    first = await printer_factory(name="Door A")
    second = await printer_factory(name="Door B")
    payload = {
        "printer_id": first.id,
        "name": "Door",
        "entity_id": "binary_sensor.enclosure_door",
        "kind": "binary",
        "alert_state": "on",
        "block_print": True,
    }
    first_response = await async_client.post("/api/v1/ha-sensors/", json=payload)
    assert first_response.status_code == 200, first_response.text
    second_response = await async_client.post("/api/v1/ha-sensors/", json={**payload, "printer_id": second.id})
    assert second_response.status_code == 200, second_response.text
    assert first_response.json()["id"] != second_response.json()["id"]
    assert (await async_client.post("/api/v1/ha-sensors/", json=payload)).status_code in (400, 409)
    invalid = await async_client.patch(f"/api/v1/ha-sensors/{first_response.json()['id']}", json={"alert_state": None})
    assert invalid.status_code == 422


async def test_printer_scoped_key_sees_only_its_ha_bindings(async_client, printer_factory):
    first = await printer_factory(name="Key A")
    second = await printer_factory(name="Key B")
    sensor_ids = []
    for printer in (first, second):
        response = await async_client.post(
            "/api/v1/ha-sensors/",
            json={
                "printer_id": printer.id,
                "name": "Door",
                "entity_id": "binary_sensor.door",
                "kind": "binary",
            },
        )
        assert response.status_code == 200, response.text
        sensor_ids.append(response.json()["id"])
    created_key = await async_client.post(
        "/api/v1/api-keys/", json={"name": "ha-printer-a", "can_read_status": True, "printer_ids": [first.id]}
    )
    assert created_key.status_code == 200, created_key.text
    headers = {"X-API-Key": created_key.json()["key"]}

    visible = await async_client.get("/api/v1/ha-sensors/", headers=headers)
    assert [row["id"] for row in visible.json()] == [sensor_ids[0]]
    assert (await async_client.get(f"/api/v1/ha-sensors/{sensor_ids[1]}", headers=headers)).status_code == 403
    assert (await async_client.get(f"/api/v1/ha-sensors/{sensor_ids[1]}/history", headers=headers)).status_code == 403
    assert (await async_client.get("/api/v1/location-ha-sensors/", headers=headers)).status_code == 403


async def test_storage_ha_binding_blocks_delete_and_allows_entity_replacement(async_client, db_session):
    location = Location(name="Drybox HA", name_key="drybox ha")
    db_session.add(location)
    await db_session.commit()
    response = await async_client.post(
        "/api/v1/location-ha-sensors/",
        json={
            "location_id": location.id,
            "name": "Humidity",
            "entity_id": "sensor.box_humidity",
            "kind": "numeric",
            "device_class": "humidity",
            "unit": "%",
            "alert_above": 60,
        },
    )
    assert response.status_code == 200, response.text
    sensor_id = response.json()["id"]
    listed = (await async_client.get("/api/v1/inventory/locations")).json()
    assert next(row for row in listed if row["id"] == location.id)["sensor_count"] == 1
    assert (await async_client.delete(f"/api/v1/inventory/locations/{location.id}")).status_code == 409
    replaced = await async_client.patch(
        f"/api/v1/location-ha-sensors/{sensor_id}", json={"entity_id": "sensor.other_humidity"}
    )
    assert replaced.status_code == 200, replaced.text
    assert replaced.json()["entity_id"] == "sensor.other_humidity"
    assert (await async_client.delete(f"/api/v1/location-ha-sensors/{sensor_id}")).status_code == 200
    assert (await async_client.delete(f"/api/v1/inventory/locations/{location.id}")).status_code == 200


async def test_ha_history_keeps_entity_revisions_separate(async_client, db_session):
    location = Location(name="History box", name_key="history box")
    db_session.add(location)
    await db_session.commit()
    created = await async_client.post(
        "/api/v1/location-ha-sensors/",
        json={
            "location_id": location.id,
            "name": "Humidity",
            "entity_id": "sensor.first_humidity",
            "kind": "numeric",
            "device_class": "humidity",
            "unit": "%",
        },
    )
    assert created.status_code == 200, created.text
    sensor_id = created.json()["id"]
    sensor = await db_session.get(LocationHASensor, sensor_id)
    reading = SensorReading("40", 40, False, True)
    await record_ha_reading(db_session, sensor, reading, utcnow_naive())
    await record_ha_reading(db_session, sensor, reading, utcnow_naive())
    await db_session.commit()
    rows = (
        await db_session.scalars(select(HASensorHistory).where(HASensorHistory.location_sensor_id == sensor_id))
    ).all()
    assert len(rows) == 1

    changed = await async_client.patch(
        f"/api/v1/location-ha-sensors/{sensor_id}", json={"entity_id": "sensor.second_humidity"}
    )
    assert changed.status_code == 200, changed.text
    await db_session.refresh(sensor)
    assert sensor.history_revision == 2
    await record_ha_reading(db_session, sensor, SensorReading("42", 42, False, True), utcnow_naive())
    await db_session.commit()
    response = await async_client.get(f"/api/v1/location-ha-sensors/{sensor_id}/history")
    assert response.status_code == 200, response.text
    history = response.json()
    assert [(row["revision"], row["entity_id"]) for row in history] == [
        (1, "sensor.first_humidity"),
        (2, "sensor.second_humidity"),
    ]


async def test_interlock_ignores_unreachable_and_stale_readings(async_client, db_session, printer_factory):
    printer = await printer_factory(name="Interlocked")
    created = await async_client.post(
        "/api/v1/ha-sensors/",
        json={
            "printer_id": printer.id,
            "name": "Door",
            "entity_id": "binary_sensor.interlock_door",
            "kind": "binary",
            "alert_state": "on",
            "block_print": True,
        },
    )
    assert created.status_code == 200, created.text
    sensor_id = created.json()["id"]
    manager = HASensorManager()
    manager._config_generation = homeassistant_service._config_generation
    manager._readings[sensor_id] = SensorReading("on", None, True, True, utcnow_naive())
    assert await manager.blocked_printers(db_session) == {printer.id: "Door"}
    manager._readings[sensor_id].reachable = False
    assert await manager.blocked_printers(db_session) == {}
    manager._readings[sensor_id] = SensorReading("on", None, True, True, utcnow_naive() - timedelta(minutes=2))
    assert await manager.blocked_printers(db_session) == {}


async def test_one_ha_entity_notifies_each_binding_on_its_own_alert_edge(db_session, printer_factory):
    first = await printer_factory(name="Door A")
    second = await printer_factory(name="Door B")
    sensors = [
        PrinterHASensor(
            printer_id=first.id,
            name="Open alert",
            entity_id="binary_sensor.shared_door",
            kind="binary",
            alert_state="on",
            notify_on_alert=True,
        ),
        PrinterHASensor(
            printer_id=second.id,
            name="Closed alert",
            entity_id="binary_sensor.shared_door",
            kind="binary",
            alert_state="off",
            notify_on_alert=True,
        ),
    ]
    db_session.add_all(sensors)
    await db_session.commit()
    manager = HASensorManager()

    with patch(
        "backend.app.services.notification_service.notification_service.on_ha_sensor_alert", new=AsyncMock()
    ) as send:
        await manager._apply(db_session, sensors, {"binary_sensor.shared_door": {"state": "off"}})
        send.assert_not_awaited()  # Cold cache does not announce an already active alert.
        await manager._apply(db_session, sensors, {"binary_sensor.shared_door": {"state": "on"}})
        send.assert_awaited_once()
        assert send.await_args.kwargs["printer_id"] == first.id


async def test_primary_selection_validates_owner_and_source(async_client, db_session):
    first = Location(name="Primary A", name_key="primary a")
    second = Location(name="Primary B", name_key="primary b")
    db_session.add_all([first, second])
    await db_session.commit()
    ha = await async_client.post(
        "/api/v1/location-ha-sensors/",
        json={
            "location_id": first.id,
            "name": "HA temp",
            "entity_id": "sensor.primary_temperature",
            "kind": "numeric",
            "device_class": "temperature",
            "unit": "°C",
        },
    )
    assert ha.status_code == 200, ha.text
    ha_id = ha.json()["id"]
    selection = {"location_id": first.id, "category": "temperature", "source": "ha", "binding_id": ha_id}
    assert (await async_client.put("/api/v1/location-ha-sensors/primary", json=selection)).status_code == 200
    assert (
        await async_client.put("/api/v1/location-ha-sensors/primary", json={**selection, "location_id": second.id})
    ).status_code == 422

    zigbee = SmartSensor(name="Zigbee temp", zigbee_ieee="00:11:22:33:44:55:66:77")
    db_session.add(zigbee)
    await db_session.flush()
    binding = SmartSensorBinding(sensor_id=zigbee.id, storage_location_id=first.id)
    db_session.add(binding)
    await db_session.commit()
    selected_zigbee = {**selection, "source": "zigbee", "binding_id": binding.id}
    assert (await async_client.put("/api/v1/location-ha-sensors/primary", json=selected_zigbee)).status_code == 200
    rows = (await async_client.get("/api/v1/location-ha-sensors/primary")).json()
    assert rows == [selected_zigbee]
    assert (await async_client.delete(f"/api/v1/zigbee/sensors/{zigbee.id}/bindings/{binding.id}")).status_code == 200
    assert (await async_client.get("/api/v1/location-ha-sensors/primary")).json() == []


async def test_scheduler_keeps_interlocked_item_pending(db_session, printer_factory):
    printer = await printer_factory(name="Door queue")
    queue = PrinterQueue(id=printer.id, printer_id=printer.id)
    db_session.add(queue)
    await db_session.flush()
    item = PrintQueueItem(queue_id=queue.id, status="pending", position=1)
    db_session.add(item)
    await db_session.commit()

    @asynccontextmanager
    async def session():
        yield db_session

    scheduler = PrintScheduler()
    with (
        patch("backend.app.services.print_scheduler.async_session", session),
        patch(
            "backend.app.services.ha_sensor_manager.ha_sensor_manager.blocked_printers",
            new=AsyncMock(return_value={printer.id: "Door"}),
        ),
        patch.object(scheduler, "_tick_scheduled_drying", new=AsyncMock()),
        patch.object(scheduler, "_check_auto_drying", new=AsyncMock()),
    ):
        assert await scheduler.check_queue() is False
    await db_session.refresh(item)
    assert item.status == "pending"
    assert item.waiting_reason_code == "ha_sensor"
    assert "Door" in item.waiting_reason
