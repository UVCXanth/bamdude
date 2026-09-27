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
from backend.app.models.spool import Spool
from backend.app.services.ha_sensor_manager import HASensorManager, SensorReading, record_ha_reading, utcnow_naive
from backend.app.services.homeassistant import homeassistant_service
from backend.app.services.location_ha_sensor_manager import location_ha_sensor_manager
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
    assert (
        await async_client.get(
            "/api/v1/inventory/spools?archived=active&page=1&sort_by=temperature_desc", headers=headers
        )
    ).status_code == 403


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


async def test_live_storage_temperature_sort_orders_before_pagination(async_client, db_session, monkeypatch):
    cooler = Location(name="Cool box", name_key="cool box")
    warmer = Location(name="Warm box", name_key="warm box")
    db_session.add_all([cooler, warmer])
    await db_session.flush()
    cool_spool = Spool(material="PLA", location_id=cooler.id)
    warm_spool = Spool(material="PLA", location_id=warmer.id)
    no_reading_spool = Spool(material="PLA")
    db_session.add_all([cool_spool, warm_spool, no_reading_spool])
    await db_session.commit()

    sensors = []
    for location, name in ((cooler, "cool"), (warmer, "warm")):
        response = await async_client.post(
            "/api/v1/location-ha-sensors/",
            json={
                "location_id": location.id,
                "name": name,
                "entity_id": f"sensor.{name}_temperature",
                "kind": "numeric",
                "device_class": "temperature",
                "unit": "°C",
            },
        )
        assert response.status_code == 200, response.text
        sensors.append(response.json()["id"])
    monkeypatch.setattr(location_ha_sensor_manager, "_config_generation", homeassistant_service._config_generation)
    monkeypatch.setattr(
        location_ha_sensor_manager,
        "_readings",
        {
            sensors[0]: SensorReading("18", 18, False, True),
            sensors[1]: SensorReading("26", 26, False, True),
        },
    )

    url = "/api/v1/inventory/spools?archived=active&sort_by=temperature_desc&per_page=1&page="
    first = await async_client.get(url + "1")
    second = await async_client.get(url + "2")
    third = await async_client.get(url + "3")
    assert first.status_code == second.status_code == third.status_code == 200, (first.text, second.text, third.text)
    assert first.json()["meta"]["total"] == 3
    assert first.json()["items"][0]["id"] == warm_spool.id
    assert second.json()["items"][0]["id"] == cool_spool.id
    assert third.json()["items"][0]["id"] == no_reading_spool.id

    ascending = await async_client.get(url.replace("temperature_desc", "temperature_asc") + "1")
    assert ascending.status_code == 200, ascending.text
    assert ascending.json()["items"][0]["id"] == cool_spool.id


async def test_storage_sort_uses_selected_zigbee_source_in_mixed_location(async_client, db_session, monkeypatch):
    mixed = Location(name="Mixed box", name_key="mixed box")
    ha_only = Location(name="HA box", name_key="ha box")
    db_session.add_all([mixed, ha_only])
    await db_session.flush()
    mixed_spool = Spool(material="PLA", location_id=mixed.id)
    ha_spool = Spool(material="PLA", location_id=ha_only.id)
    zigbee = SmartSensor(name="Zigbee temp", zigbee_ieee="00:11:22:33:44:55:66:78")
    db_session.add_all([mixed_spool, ha_spool, zigbee])
    await db_session.flush()
    binding = SmartSensorBinding(sensor_id=zigbee.id, storage_location_id=mixed.id)
    db_session.add(binding)
    await db_session.commit()

    ids = []
    for location, name in ((mixed, "mixed"), (ha_only, "ha_only")):
        response = await async_client.post(
            "/api/v1/location-ha-sensors/",
            json={
                "location_id": location.id,
                "name": name,
                "entity_id": f"sensor.{name}_temperature",
                "kind": "numeric",
                "device_class": "temperature",
                "unit": "°C",
            },
        )
        assert response.status_code == 200, response.text
        ids.append(response.json()["id"])
    monkeypatch.setattr(location_ha_sensor_manager, "_config_generation", homeassistant_service._config_generation)
    monkeypatch.setattr(
        location_ha_sensor_manager,
        "_readings",
        {ids[0]: SensorReading("18", 18, False, True), ids[1]: SensorReading("26", 26, False, True)},
    )

    async def zigbee_payloads(_request, _db):
        return {
            "sensors": [
                {
                    "present": True,
                    "unreachable": False,
                    "measurements": {"temperature": {"value": 30, "stale": False}},
                    "bindings": [{"id": binding.id, "storage_location_id": mixed.id, "visible": True}],
                }
            ]
        }

    monkeypatch.setattr("backend.app.api.routes.zigbee.sensor_payloads", zigbee_payloads)
    url = "/api/v1/inventory/spools?archived=active&sort_by=temperature_desc&per_page=1&page=1"
    ambiguous = await async_client.get(url)
    assert ambiguous.status_code == 200, ambiguous.text
    assert ambiguous.json()["items"][0]["id"] == ha_spool.id

    selected = await async_client.put(
        "/api/v1/location-ha-sensors/primary",
        json={"location_id": mixed.id, "category": "temperature", "source": "zigbee", "binding_id": binding.id},
    )
    assert selected.status_code == 200, selected.text
    sorted_page = await async_client.get(url)
    assert sorted_page.status_code == 200, sorted_page.text
    assert sorted_page.json()["items"][0]["id"] == mixed_spool.id


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
