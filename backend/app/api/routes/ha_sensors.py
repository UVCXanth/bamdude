"""API routes for Home Assistant sensors bound to a printer (#1148, #448)."""

import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.api_key_scope import in_key_scope, key_printer_scope
from backend.app.core.auth import RequirePermission
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.core.websocket import ws_manager
from backend.app.models.ha_sensor_history import HASensorHistory
from backend.app.models.printer import Printer
from backend.app.models.printer_ha_sensor import PrinterHASensor
from backend.app.models.user import User
from backend.app.schemas.printer_ha_sensor import (
    HADisplayEntity,
    PrinterHASensorCreate,
    PrinterHASensorReading,
    PrinterHASensorResponse,
    PrinterHASensorUpdate,
)
from backend.app.services.ha_sensor_manager import ha_sensor_manager
from backend.app.services.homeassistant import homeassistant_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ha-sensors", tags=["ha-sensors"])

# These reuse the smart-plug permissions rather than introducing their own.
# Both surfaces are "the Home Assistant integration", and a brand-new
# permission would be missing from every existing custom role — users who can
# manage plugs today would silently lose access to the sensors next to them.
_READ = RequirePermission(Permission.SMART_SENSORS_READ)
_CREATE = RequirePermission(Permission.SMART_SENSORS_CREATE)
_UPDATE = RequirePermission(Permission.SMART_SENSORS_UPDATE)
_DELETE = RequirePermission(Permission.SMART_SENSORS_DELETE)


async def _refresh_quietly(sensor: PrinterHASensor, db: AsyncSession) -> None:
    """Take a first reading without letting it fail the write that preceded it.

    The sensor row is committed before this runs. A failure here costs the card
    one poll interval of blank state, which is not worth turning a successful
    save into an error response.
    """
    try:
        await ha_sensor_manager.refresh_one(db, sensor)
    except Exception as e:
        logger.warning("Could not read %s right after saving it: %s", sensor.entity_id, e)


@router.get("/", response_model=list[PrinterHASensorResponse])
async def list_ha_sensors(
    request: Request,
    printer_id: int | None = None,
    db: AsyncSession = Depends(get_db),
    _: User | None = _READ,
):
    """List configured sensors, grouped by printer and in display order."""
    query = select(PrinterHASensor)
    if printer_id is not None:
        query = query.where(PrinterHASensor.printer_id == printer_id)
    scope = key_printer_scope(request)
    if scope is not None:
        query = query.where(PrinterHASensor.printer_id.in_(scope))
    result = await db.execute(query.order_by(PrinterHASensor.printer_id, PrinterHASensor.sort_order))
    return list(result.scalars().all())


# Must precede /{sensor_id} so "entities" is not parsed as an id.
@router.get("/entities", response_model=list[HADisplayEntity])
async def list_bindable_entities(
    search: str | None = None,
    db: AsyncSession = Depends(get_db),
    _: User | None = _READ,
):
    """List the Home Assistant entities that can be bound to a printer."""
    from backend.app.api.routes.settings import get_homeassistant_settings

    ha_settings = await get_homeassistant_settings(db)
    if not ha_settings["ha_enabled"] or not ha_settings["ha_url"] or not ha_settings["ha_token"]:
        raise HTTPException(
            400,
            "Home Assistant not configured. Please set HA URL and token in Settings → Network → Home Assistant.",
        )

    try:
        entities = await homeassistant_service.list_display_entities(
            ha_settings["ha_url"], ha_settings["ha_token"], search
        )
    except Exception as exc:
        raise HTTPException(502, "Home Assistant entity discovery is unavailable") from exc
    return [HADisplayEntity(**e) for e in entities]


@router.get("/by-printer/{printer_id}/readings", response_model=list[PrinterHASensorReading])
async def get_printer_sensor_readings(
    printer_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _: User | None = _READ,
):
    """Live state of a printer's card-visible sensors.

    Served from the poller's cache, so a page full of printer cards costs
    Home Assistant nothing. A sensor the poller has not reached yet falls back
    to its last persisted state, marked unreachable, rather than vanishing
    from the card on every restart.
    """
    if not in_key_scope(request, printer_id):
        raise HTTPException(403, "API key does not have access to this printer")
    result = await db.execute(
        select(PrinterHASensor)
        .where(
            PrinterHASensor.printer_id == printer_id,
            PrinterHASensor.show_on_printer_card.is_(True),
        )
        .order_by(PrinterHASensor.sort_order, PrinterHASensor.id)
    )

    readings = []
    for sensor in result.scalars().all():
        cached = ha_sensor_manager.get_reading(sensor.id)
        readings.append(
            PrinterHASensorReading(
                id=sensor.id,
                name=sensor.name,
                entity_id=sensor.entity_id,
                kind=sensor.kind,
                device_class=sensor.device_class,
                unit=sensor.unit,
                state=cached.state if cached else sensor.last_state,
                value=cached.value if cached else None,
                alerting=cached.alerting if cached else False,
                block_print=sensor.block_print,
                reachable=cached.reachable if cached else False,
                last_changed=sensor.last_changed,
            )
        )
    return readings


@router.post("/", response_model=PrinterHASensorResponse)
async def create_ha_sensor(
    data: PrinterHASensorCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _: User | None = _CREATE,
):
    """Bind a Home Assistant entity to a printer."""
    if not in_key_scope(request, data.printer_id):
        raise HTTPException(403, "API key does not have access to this printer")
    printer = await db.get(Printer, data.printer_id)
    if not printer:
        raise HTTPException(404, "Printer not found")

    existing = await db.execute(
        select(PrinterHASensor).where(
            PrinterHASensor.printer_id == data.printer_id,
            PrinterHASensor.entity_id == data.entity_id,
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(400, f"{data.entity_id} is already bound to this printer")

    from backend.app.services.sensor_target_lock import lock_sensor_target

    if not await lock_sensor_target(db, "printers", data.printer_id):
        raise HTTPException(404, "Printer not found")
    sensor = PrinterHASensor(**data.model_dump())
    db.add(sensor)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(409, "This entity is already bound to the printer") from exc
    await db.refresh(sensor)
    logger.info("Bound HA entity %s to printer %s as '%s'", sensor.entity_id, sensor.printer_id, sensor.name)

    # Read it once now so the card shows a state immediately instead of after
    # the next poll tick. Best-effort: the row is already committed, so letting
    # a Home Assistant hiccup 500 the request would report a failure for work
    # that succeeded — and the retry would come back "already bound".
    await _refresh_quietly(sensor, db)
    await ws_manager.broadcast({"type": "sensor_bindings_changed"})
    return sensor


@router.get("/{sensor_id}", response_model=PrinterHASensorResponse)
async def get_ha_sensor(
    sensor_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _: User | None = _READ,
):
    sensor = await db.get(PrinterHASensor, sensor_id)
    if not sensor:
        raise HTTPException(404, "Sensor not found")
    if not in_key_scope(request, sensor.printer_id):
        raise HTTPException(403, "API key does not have access to this printer")
    return sensor


@router.get("/{sensor_id}/history")
async def get_ha_sensor_history(
    sensor_id: int,
    request: Request,
    hours: int = Query(24, ge=1, le=720),
    db: AsyncSession = Depends(get_db),
    _: User | None = _READ,
):
    sensor = await db.get(PrinterHASensor, sensor_id)
    if not sensor:
        raise HTTPException(404, "Sensor not found")
    if not in_key_scope(request, sensor.printer_id):
        raise HTTPException(403, "API key does not have access to this printer")
    since = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=hours)
    rows = (
        await db.scalars(
            select(HASensorHistory)
            .where(
                HASensorHistory.printer_sensor_id == sensor_id,
                HASensorHistory.observed_at >= since,
            )
            .order_by(HASensorHistory.observed_at.desc(), HASensorHistory.id.desc())
            .limit(2000)
        )
    ).all()
    return [
        {
            "id": row.id,
            "revision": row.revision,
            "entity_id": row.entity_id,
            "kind": row.kind,
            "unit": row.unit,
            "state": row.state,
            "value": row.value,
            "observed_at": row.observed_at,
        }
        for row in reversed(rows)
    ]


@router.patch("/{sensor_id}", response_model=PrinterHASensorResponse)
async def update_ha_sensor(
    sensor_id: int,
    data: PrinterHASensorUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _: User | None = _UPDATE,
):
    sensor = await db.get(PrinterHASensor, sensor_id)
    if not sensor:
        raise HTTPException(404, "Sensor not found")
    if not in_key_scope(request, sensor.printer_id):
        raise HTTPException(403, "API key does not have access to this printer")

    updates = data.model_dump(exclude_unset=True)

    # Re-run the create-time rules against the merged row. A PATCH that only
    # sets block_print has no entity_id or alert_state in its payload, so the
    # schema alone cannot tell whether the result is coherent.
    merged = {field: getattr(sensor, field) for field in PrinterHASensorCreate.model_fields}
    merged.update(updates)
    try:
        PrinterHASensorCreate(**merged)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e

    # Same uniqueness rule as create: repointing a sensor at an entity the
    # printer already has would leave two rows fighting over one pill.
    new_entity = updates.get("entity_id")
    if new_entity and new_entity != sensor.entity_id:
        clash = await db.execute(
            select(PrinterHASensor).where(
                PrinterHASensor.printer_id == sensor.printer_id,
                PrinterHASensor.entity_id == new_entity,
                PrinterHASensor.id != sensor.id,
            )
        )
        if clash.scalar_one_or_none():
            raise HTTPException(400, f"{new_entity} is already bound to this printer")

    for field, value in updates.items():
        if field in {"entity_id", "kind", "unit"} and value != getattr(sensor, field):
            sensor.history_revision += 1
            sensor.last_state = None
            sensor.last_changed = None
            break
    for field, value in updates.items():
        setattr(sensor, field, value)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(409, "This entity is already bound to the printer") from exc
    await db.refresh(sensor)

    # The entity or its alert rule may have changed under the cached reading.
    await _refresh_quietly(sensor, db)
    await ws_manager.broadcast({"type": "sensor_bindings_changed"})
    return sensor


@router.delete("/{sensor_id}")
async def delete_ha_sensor(
    sensor_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _: User | None = _DELETE,
):
    sensor = await db.get(PrinterHASensor, sensor_id)
    if not sensor:
        raise HTTPException(404, "Sensor not found")
    if not in_key_scope(request, sensor.printer_id):
        raise HTTPException(403, "API key does not have access to this printer")

    name = sensor.name
    await db.execute(delete(HASensorHistory).where(HASensorHistory.printer_sensor_id == sensor_id))
    await db.delete(sensor)
    await db.commit()
    ha_sensor_manager.forget(sensor_id)
    await ws_manager.broadcast({"type": "sensor_bindings_changed"})
    logger.info("Removed HA sensor '%s'", name)
    return {"message": f"Sensor '{name}' removed"}
