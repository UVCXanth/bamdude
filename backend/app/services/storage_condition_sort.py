"""Current storage readings used to order the paged spool list.

The table must sort by the same source its cell draws. In particular, a Zigbee
measurement's last history row is not its current value after the radio went
down, and two bindings with the same numeric ID are not the same source.
"""

import math
from collections import defaultdict

from fastapi import Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.location_ha_sensor import LocationHASensor
from backend.app.models.location_sensor_primary import LocationSensorPrimary
from backend.app.services.location_ha_sensor_manager import location_ha_sensor_manager


def select_condition_value(
    choices: list[tuple[str, int, float | None]], primary: tuple[str, int] | None
) -> float | None:
    selected = (
        next((item for item in choices if item[:2] == primary), None)
        if primary
        else (choices[0] if len(choices) == 1 else None)
    )
    value = selected[2] if selected is not None else None
    return value if value is not None and math.isfinite(value) else None


async def current_condition_values(db: AsyncSession, request: Request, category: str) -> dict[int, float]:
    """Visible finite values, keyed by storage-location ID, without LAN reads.

    The Zigbee payload builder and HA poller cache are the same readers the
    cells use. When several sources cover one category, only the operator's
    explicit primary counts; otherwise a single visible candidate suffices.
    """
    from backend.app.api.routes.zigbee import sensor_payloads

    candidates: dict[int, list[tuple[str, int, float | None]]] = defaultdict(list)
    ha_rows = (
        await db.scalars(
            select(LocationHASensor).where(
                LocationHASensor.device_class == category, LocationHASensor.show_on_card.is_(True)
            )
        )
    ).all()
    for sensor in ha_rows:
        reading = location_ha_sensor_manager.get_reading(sensor.id)
        value = reading.value if reading and reading.reachable else None
        candidates[sensor.location_id].append(("ha", sensor.id, value))

    zigbee = await sensor_payloads(request, db)
    for sensor in zigbee["sensors"]:
        measurement = sensor["measurements"].get(category)
        if measurement is None:
            continue
        reachable = sensor["present"] and not sensor["unreachable"] and not measurement["stale"]
        value = measurement["value"] if reachable else None
        for binding in sensor["bindings"]:
            location_id = binding["storage_location_id"]
            if location_id is not None and binding["visible"]:
                candidates[location_id].append(("zigbee", binding["id"], value))

    primaries = {
        (row.location_id, row.category): (row.source, row.binding_id)
        for row in (
            await db.scalars(select(LocationSensorPrimary).where(LocationSensorPrimary.category == category))
        ).all()
    }
    values: dict[int, float] = {}
    for location_id, choices in candidates.items():
        primary = primaries.get((location_id, category))
        value = select_condition_value(choices, primary)
        if value is not None:
            values[location_id] = value
    return values
