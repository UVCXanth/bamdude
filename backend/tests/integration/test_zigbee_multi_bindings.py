"""One physical report may serve several explicit targets without duplicating the device."""

import pytest
from sqlalchemy import select

from backend.app.models.location import Location
from backend.app.models.printer import Printer
from backend.app.models.printer_location import PrinterLocation
from backend.app.models.smart_sensor import SmartSensor
from backend.app.models.smart_sensor_history import SmartSensorHistory
from backend.app.models.smart_sensor_threshold import SmartSensorThreshold
from backend.app.services.sensor_alerts import evaluate_thresholds

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]


async def _setup(db):
    sensor = SmartSensor(name="Probe", zigbee_ieee="aa:bb:cc:dd:ee:ff:00:11")
    room = PrinterLocation(name="Shop", name_key="shop")
    box1 = Location(name="Box 1", name_key="box 1")
    box2 = Location(name="Box 2", name_key="box 2")
    first = Printer(name="P1", ip_address="192.168.1.51", access_code="12345678", serial_number="MULTI-1")
    second = Printer(name="P2", ip_address="192.168.1.52", access_code="12345678", serial_number="MULTI-2")
    db.add_all([sensor, room, box1, box2, first, second])
    await db.commit()
    return sensor, room, box1, box2, first, second


async def test_one_sensor_can_bind_to_two_printers_room_and_two_boxes(async_client, db_session):
    sensor, room, box1, box2, first, second = await _setup(db_session)
    targets = [
        {"printer_id": first.id},
        {"printer_id": second.id},
        {"printer_location_id": room.id},
        {"storage_location_id": box1.id},
        {"storage_location_id": box2.id},
    ]
    binding_ids = []
    for target in targets:
        response = await async_client.post(f"/api/v1/zigbee/sensors/{sensor.id}/bindings", json=target)
        assert response.status_code == 201, response.text
        binding_ids.append(response.json()["id"])

    listed = (await async_client.get("/api/v1/zigbee/sensors")).json()["sensors"]
    assert len(listed) == 1
    assert len(listed[0]["bindings"]) == 5
    assert listed[0]["printer_id"] is None
    assert listed[0]["location"] is None

    duplicate = await async_client.post(f"/api/v1/zigbee/sensors/{sensor.id}/bindings", json=targets[0])
    assert duplicate.status_code == 409
    old_client = await async_client.patch(f"/api/v1/zigbee/sensors/{sensor.id}", json={"printer_id": first.id})
    assert old_client.status_code == 409
    renamed = await async_client.patch(f"/api/v1/zigbee/sensors/{sensor.id}", json={"name": "Probe A"})
    assert renamed.status_code == 200

    removed = await async_client.delete(f"/api/v1/zigbee/sensors/{sensor.id}/bindings/{binding_ids[0]}")
    assert removed.status_code == 200
    remaining = (await async_client.get("/api/v1/zigbee/sensors")).json()["sensors"][0]
    assert {binding["id"] for binding in remaining["bindings"]} == set(binding_ids[1:])
    assert await db_session.get(SmartSensor, sensor.id) is not None


async def test_alert_state_and_delivery_are_per_binding(async_client, db_session):
    sensor, _room, _box1, _box2, first, second = await _setup(db_session)
    db_session.add(SmartSensorThreshold(sensor_id=sensor.id, kind="temperature", max_value=30, enabled=True))
    db_session.add(SmartSensorHistory(sensor_id=sensor.id, sensor_kind="temperature", value=35))
    await db_session.commit()

    first_binding = await async_client.post(
        f"/api/v1/zigbee/sensors/{sensor.id}/bindings",
        json={"printer_id": first.id, "notify_enabled": True},
    )
    second_binding = await async_client.post(
        f"/api/v1/zigbee/sensors/{sensor.id}/bindings",
        json={"printer_id": second.id},
    )
    assert first_binding.status_code == second_binding.status_code == 201
    events = await evaluate_thresholds(db_session)
    assert [(event.location, event.printer_id) for event in events] == [("P1", first.id)]
    assert await evaluate_thresholds(db_session) == []
    history = (
        (await db_session.execute(select(SmartSensorHistory).where(SmartSensorHistory.sensor_id == sensor.id)))
        .scalars()
        .all()
    )
    assert len(history) == 1


async def test_second_target_can_override_the_device_limit(async_client, db_session):
    sensor, _room, _box1, _box2, first, second = await _setup(db_session)
    db_session.add(SmartSensorThreshold(sensor_id=sensor.id, kind="temperature", max_value=30, enabled=True))
    db_session.add(SmartSensorHistory(sensor_id=sensor.id, sensor_kind="temperature", value=35))
    await db_session.commit()
    first_binding = (
        await async_client.post(
            f"/api/v1/zigbee/sensors/{sensor.id}/bindings",
            json={"printer_id": first.id, "notify_enabled": True},
        )
    ).json()
    second_binding = (
        await async_client.post(
            f"/api/v1/zigbee/sensors/{sensor.id}/bindings",
            json={"printer_id": second.id, "notify_enabled": True},
        )
    ).json()
    response = await async_client.put(
        f"/api/v1/zigbee/sensors/{sensor.id}/bindings/{second_binding['id']}/thresholds",
        json={"thresholds": [{"kind": "temperature", "custom": True, "max_value": 40}]},
    )
    assert response.status_code == 200, response.text
    assert response.json()["thresholds"][0]["max_value"] == 40

    events = await evaluate_thresholds(db_session)
    assert [(event.printer_id, event.location) for event in events] == [(first.id, "P1")]
    assert first_binding["id"] != second_binding["id"]


async def test_storage_location_with_sensor_cannot_be_deleted(async_client, db_session):
    sensor, _room, box1, _box2, _first, _second = await _setup(db_session)
    created = await async_client.post(
        f"/api/v1/zigbee/sensors/{sensor.id}/bindings",
        json={"storage_location_id": box1.id},
    )
    assert created.status_code == 201
    locations = (await async_client.get("/api/v1/inventory/locations")).json()
    assert next(row for row in locations if row["id"] == box1.id)["sensor_count"] == 1
    response = await async_client.delete(f"/api/v1/inventory/locations/{box1.id}")
    assert response.status_code == 409
    assert "sensor" in response.json()["detail"].lower()


async def test_rule_added_after_binding_alerts_that_binding(async_client, db_session):
    sensor, _room, _box1, _box2, first, _second = await _setup(db_session)
    response = await async_client.post(
        f"/api/v1/zigbee/sensors/{sensor.id}/bindings",
        json={"printer_id": first.id, "notify_enabled": True},
    )
    assert response.status_code == 201
    db_session.add(SmartSensorThreshold(sensor_id=sensor.id, kind="temperature", max_value=30, enabled=True))
    db_session.add(SmartSensorHistory(sensor_id=sensor.id, sensor_kind="temperature", value=35))
    await db_session.commit()

    events = await evaluate_thresholds(db_session)
    assert [(event.location, event.printer_id) for event in events] == [("P1", first.id)]
    assert await evaluate_thresholds(db_session) == []


async def test_printer_scoped_key_sees_only_its_sensor_bindings(async_client, db_session):
    sensor, room, box1, _box2, first, second = await _setup(db_session)
    binding_ids = []
    for target in (
        {"printer_id": first.id},
        {"printer_id": second.id},
        {"printer_location_id": room.id},
        {"storage_location_id": box1.id},
    ):
        response = await async_client.post(f"/api/v1/zigbee/sensors/{sensor.id}/bindings", json=target)
        assert response.status_code == 201
        binding_ids.append(response.json()["id"])
    key_response = await async_client.post(
        "/api/v1/api-keys/",
        json={"name": "sensor-printer-scope", "can_read_status": True, "printer_ids": [first.id]},
    )
    assert key_response.status_code == 200
    response = await async_client.get(
        "/api/v1/zigbee/sensors",
        headers={"X-API-Key": key_response.json()["key"]},
    )
    assert response.status_code == 200
    listed = response.json()["sensors"]
    assert len(listed) == 1
    assert len(listed[0]["bindings"]) == 1
    assert listed[0]["bindings"][0]["printer_id"] == first.id
    allowed = await async_client.get(
        f"/api/v1/zigbee/sensors/{sensor.id}/bindings/{binding_ids[0]}/thresholds",
        headers={"X-API-Key": key_response.json()["key"]},
    )
    refused = await async_client.get(
        f"/api/v1/zigbee/sensors/{sensor.id}/bindings/{binding_ids[1]}/thresholds",
        headers={"X-API-Key": key_response.json()["key"]},
    )
    assert allowed.status_code == 200
    assert refused.status_code == 403
    assert (
        await async_client.get(
            f"/api/v1/zigbee/sensors/{sensor.id}/history?kind=temperature",
            headers={"X-API-Key": key_response.json()["key"]},
        )
    ).status_code == 200
    no_printers = await async_client.post(
        "/api/v1/api-keys/",
        json={"name": "no-sensor-printers", "can_read_status": True, "printer_ids": []},
    )
    assert no_printers.status_code == 200
    assert (
        await async_client.get(
            f"/api/v1/zigbee/sensors/{sensor.id}/history?kind=temperature",
            headers={"X-API-Key": no_printers.json()["key"]},
        )
    ).status_code == 403
