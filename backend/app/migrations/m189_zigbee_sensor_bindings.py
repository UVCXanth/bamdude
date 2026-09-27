"""Move Zigbee sensor targets into independent bindings.

One adopted device keeps its IEEE and history. Each legacy sensor with a
printer or room gets exactly one binding (printer wins corrupt double targets).
The migration may run again in DEBUG mode without duplicating that binding or
its threshold states.
"""

import logging

from sqlalchemy import text

from backend.app.models.smart_sensor_binding import SmartSensorBinding, SmartSensorBindingThreshold

version = 189
name = "zigbee_sensor_bindings"
logger = logging.getLogger(__name__)


async def upgrade(conn):
    await conn.run_sync(lambda sync: SmartSensorBinding.__table__.create(sync, checkfirst=True))
    await conn.run_sync(lambda sync: SmartSensorBindingThreshold.__table__.create(sync, checkfirst=True))

    sensors = (await conn.execute(text("SELECT id, printer_id, location_id FROM smart_sensors ORDER BY id"))).all()
    for sensor_id, printer_id, room_id in sensors:
        # An already migrated sensor may have acquired several targets. A DEBUG
        # rerun must never resurrect a detached legacy target.
        existing = await conn.scalar(
            text("SELECT id FROM smart_sensor_bindings WHERE sensor_id = :sensor_id LIMIT 1"),
            {"sensor_id": sensor_id},
        )
        if existing is not None or (printer_id is None and room_id is None):
            continue
        if printer_id is not None and room_id is not None:
            logger.warning("m189: sensor %s had both targets; keeping printer %s", sensor_id, printer_id)
        await conn.execute(
            text("""
                INSERT INTO smart_sensor_bindings
                    (sensor_id, printer_id, printer_location_id, notify_enabled)
                VALUES (:sensor_id, :printer_id, :room_id, 1)
            """),
            {"sensor_id": sensor_id, "printer_id": printer_id, "room_id": None if printer_id is not None else room_id},
        )
        binding_id = await conn.scalar(
            text("SELECT id FROM smart_sensor_bindings WHERE sensor_id = :sensor_id LIMIT 1"),
            {"sensor_id": sensor_id},
        )
        await conn.execute(
            text("""
                INSERT INTO smart_sensor_binding_thresholds
                    (binding_id, kind, custom, state, state_since, notified_at)
                SELECT :binding_id, kind, 0, state, state_since, notified_at
                FROM smart_sensor_thresholds WHERE sensor_id = :sensor_id
            """),
            {"binding_id": binding_id, "sensor_id": sensor_id},
        )
