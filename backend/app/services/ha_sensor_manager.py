"""Polls the Home Assistant entities bound to printers (#1148, #448).

One background loop reads every configured entity on a fixed cadence and keeps
the result in memory. Three things consume it:

* the printer card, which reads the cache instead of hitting Home Assistant
  once per card per refresh;
* notifications, fired on a transition *into* the alert state, never on every
  poll while it persists;
* the print interlock, which holds queued jobs for a printer while one of its
  sensors is alerting.

Everything degrades to "no opinion" when Home Assistant cannot be reached: an
unreadable sensor never alerts, never notifies, and never holds a print. A
door contact that stops responding must not strand the queue.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Protocol

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.ha_sensor_history import HASensorHistory
from backend.app.models.printer import Printer
from backend.app.models.printer_ha_sensor import LAST_STATE_MAX_LENGTH, PrinterHASensor
from backend.app.services.homeassistant import as_float, homeassistant_service

if TYPE_CHECKING:
    from backend.app.models.location_ha_sensor import LocationHASensor

logger = logging.getLogger(__name__)

# Fast enough that an enclosure door reads as live, slow enough that a handful
# of tiny LAN requests stays background noise.
POLL_INTERVAL = 15


def utcnow_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


@dataclass
class SensorReading:
    """The last thing we managed to read for one sensor."""

    state: str | None  # raw HA state, None when unreadable
    value: float | None  # parsed number for numeric sensors
    alerting: bool
    reachable: bool
    observed_at: datetime | None = None


def persistable_state(state: str | None, max_length: int) -> str | None:
    """Fit a raw HA state into a last_state column.

    A numeric entity can start reporting free text (an enum, an error string)
    longer than the column. PostgreSQL rejects the oversized row, and since a
    poll pass commits every sensor at once, one such entity would sink every
    other sensor's update on every tick -- and for printer sensors that also
    freezes the print interlock's view of the world.

    The cached SensorReading keeps the full state; only what is persisted is
    cut, and the comparison against the stored value is done on the cut form so
    an unchanged-but-long state does not read as a change on every poll.

    Shared with the storage-location poller, which has the same column on its
    own table -- each caller passes its own model's width.
    """
    return state[:max_length] if state else state


class HASensorManager:
    def __init__(self):
        self._task: asyncio.Task | None = None
        # sensor id -> last reading. Sensors absent from this map have not been
        # polled yet; callers must not read that as "not alerting" without also
        # checking, which is why get_reading returns None rather than a default.
        self._readings: dict[int, SensorReading] = {}
        # sensor id -> alerting, from the last reading we could actually take.
        # Kept apart from _readings because a dropout must not read as the
        # alert clearing: on -> unavailable -> on is one continuous alert, and
        # notifying off _readings alone would ping the user on every reconnect
        # of a flaky contact. Absent means "never had a reachable reading".
        self._last_alerting: dict[int, bool] = {}
        self._config_generation = -1

    # -- lifecycle ---------------------------------------------------------

    def start(self):
        if self._task is None:
            self._task = asyncio.create_task(self._poll_loop())
            logger.info("Home Assistant sensor poller started")

    async def stop(self):
        if self._task:
            task, self._task = self._task, None
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            logger.info("Home Assistant sensor poller stopped")

    # -- cache access ------------------------------------------------------

    def get_reading(self, sensor_id: int) -> SensorReading | None:
        if self._config_generation != homeassistant_service._config_generation:
            return None
        return self._readings.get(sensor_id)

    def forget(self, sensor_id: int):
        """Drop a deleted sensor's cached reading so its id cannot be reused
        by a later row and answer with the old sensor's state."""
        self._readings.pop(sensor_id, None)
        self._last_alerting.pop(sensor_id, None)

    async def blocked_printers(self, db: AsyncSession) -> dict[int, str]:
        """Printers currently held by an interlock, mapped to the sensor names.

        A sensor counts only when it is configured to block, *and* was read
        successfully, *and* is in its alert state. Anything we could not read
        is omitted, so the queue keeps moving when Home Assistant is down.

        One query for the whole fleet — the scheduler calls this on every pass,
        and per-printer lookups would put a query per printer in that loop.
        """
        result = await db.execute(select(PrinterHASensor).where(PrinterHASensor.block_print.is_(True)))
        if self._config_generation != homeassistant_service._config_generation:
            return {}
        blocked: dict[int, list[str]] = {}
        for sensor in result.scalars().all():
            reading = self._readings.get(sensor.id)
            if (
                reading
                and reading.reachable
                and reading.alerting
                and reading.observed_at
                and utcnow_naive() - reading.observed_at <= timedelta(seconds=POLL_INTERVAL * 2)
            ):
                blocked.setdefault(sensor.printer_id, []).append(sensor.name)
        return {printer_id: ", ".join(names) for printer_id, names in blocked.items()}

    # -- polling -----------------------------------------------------------

    async def _poll_loop(self):
        while True:
            try:
                await asyncio.sleep(POLL_INTERVAL)
                await self.poll_once()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning("Home Assistant sensor poll failed: %s", e)

    async def poll_once(self):
        """One pass over every configured sensor."""
        from backend.app.core.database import async_session

        async with async_session() as db:
            result = await db.execute(select(PrinterHASensor))
            sensors = list(result.scalars().all())

            # Drop readings for rows that no longer exist. The delete route
            # calls forget(), but a printer deleted with sensors attached takes
            # them out by cascade, and a restored backup can renumber them —
            # either way a stale id must not answer for a later sensor.
            live = {s.id for s in sensors}
            for stale in set(self._readings) - live:
                self.forget(stale)

            if not sensors:
                return

            if not await self._configure(db):
                # Not configured is not a failure to report every 15 seconds,
                # but the readings must not go stale-but-confident either.
                for sensor in sensors:
                    self._readings[sensor.id] = SensorReading(None, None, False, False)
                return

            await db.commit()  # release the read transaction before LAN I/O
            states = await homeassistant_service.fetch_states(sorted({s.entity_id for s in sensors}))
            await self._apply(db, sensors, states)

    async def refresh_one(self, db: AsyncSession, sensor: PrinterHASensor):
        """Read a single sensor now, on the caller's session.

        Used after a create or an edit so the card shows a state straight away
        instead of blank until the next tick. Deliberately not a full
        ``poll_once``: a request handler must not wait on every configured
        entity, and must not fire another user's notification as a side effect
        of this one saving a form.
        """
        self.forget(sensor.id)
        if not await self._configure(db):
            self._readings[sensor.id] = SensorReading(None, None, False, False)
            return

        await db.commit()
        states = await homeassistant_service.fetch_states([sensor.entity_id])
        reading = evaluate(sensor, states.get(sensor.entity_id))
        reading.observed_at = utcnow_naive()
        self._readings[sensor.id] = reading
        if reading.reachable:
            self._last_alerting[sensor.id] = reading.alerting

        sensor.last_checked = utcnow_naive()
        persisted = persistable_state(reading.state, LAST_STATE_MAX_LENGTH)
        if reading.reachable and sensor.last_state != persisted:
            sensor.last_state = persisted
            sensor.last_changed = sensor.last_checked
        await record_ha_reading(db, sensor, reading, sensor.last_checked)
        await db.commit()
        await db.refresh(sensor)

    async def _configure(self, db: AsyncSession) -> bool:
        from backend.app.api.routes.settings import get_homeassistant_settings

        try:
            ha_settings = await get_homeassistant_settings(db)
        except Exception as e:
            logger.warning("Failed to read Home Assistant settings: %s", e)
            return False
        if not ha_settings["ha_enabled"] or not ha_settings["ha_url"] or not ha_settings["ha_token"]:
            homeassistant_service.configure("", "")
            self._readings.clear()
            self._last_alerting.clear()
            self._config_generation = homeassistant_service._config_generation
            return False
        homeassistant_service.configure(ha_settings["ha_url"], ha_settings["ha_token"])
        if self._config_generation != homeassistant_service._config_generation:
            self._readings.clear()
            self._last_alerting.clear()
            self._config_generation = homeassistant_service._config_generation
        return True

    async def _apply(self, db: AsyncSession, sensors: list[PrinterHASensor], states: dict[str, dict | None]):
        """Fold poll results into the cache, the DB and any notifications."""
        from backend.app.services.notification_service import notification_service

        now = utcnow_naive()
        alerts: list[tuple[PrinterHASensor, SensorReading]] = []

        for sensor in sensors:
            payload = states.get(sensor.entity_id)
            reading = evaluate(sensor, payload)
            reading.observed_at = now
            was_alerting = self._last_alerting.get(sensor.id)
            self._readings[sensor.id] = reading

            sensor.last_checked = now
            if reading.reachable:
                persisted = persistable_state(reading.state, LAST_STATE_MAX_LENGTH)
                if sensor.last_state != persisted:
                    sensor.last_state = persisted
                    sensor.last_changed = now
            await record_ha_reading(db, sensor, reading, now)

            # Notify on the edge into alerting only. `was_alerting is None` is
            # a cold cache (first poll after a restart) — a door that was
            # already open then has not just been opened, and re-announcing it
            # on every restart would train users to ignore the alert.
            if sensor.notify_on_alert and reading.reachable and reading.alerting and was_alerting is False:
                alerts.append((sensor, reading))

            if reading.reachable:
                self._last_alerting[sensor.id] = reading.alerting

        await db.commit()

        for sensor, reading in alerts:
            # db.get, not sensor.printer: touching the lazy relationship from
            # an async session raises MissingGreenlet.
            printer = await db.get(Printer, sensor.printer_id)
            try:
                await notification_service.on_ha_sensor_alert(
                    printer_id=sensor.printer_id,
                    printer_name=printer.name if printer else "Unknown",
                    sensor_name=sensor.name,
                    state=describe_state(sensor, reading),
                    db=db,
                )
            except Exception as e:
                logger.warning("Failed to send HA sensor alert for '%s': %s", sensor.name, e)


class _AlertableSensor(Protocol):
    """Structural type for evaluate()/describe_state().

    PrinterHASensor and LocationHASensor are unrelated SQLAlchemy models —
    one has no base class in common with the other beyond ``Base`` — but both
    carry these five fields with the same meaning, and location_ha_sensor_
    manager.py imports these two functions to reuse the exact same alert
    logic rather than reimplementing it. A concrete PrinterHASensor
    annotation here would be a lie for half of the actual callers.
    """

    kind: str
    unit: str | None
    alert_state: str | None
    alert_above: float | None
    alert_below: float | None


def evaluate(sensor: _AlertableSensor, payload: dict | None) -> SensorReading:
    """Turn one HA state payload into a reading.

    Split out from the manager so the alert rules can be tested without a
    poller, a database or a Home Assistant.
    """
    if payload is None:
        return SensorReading(state=None, value=None, alerting=False, reachable=False)

    state = payload.get("state")
    # HA reports these two for entities whose integration is down. Treating
    # them as a state would make "unavailable" a value the card renders and
    # the thresholds compare against.
    if state in (None, "unknown", "unavailable"):
        return SensorReading(state=None, value=None, alerting=False, reachable=False)

    state = str(state)
    if sensor.kind == "numeric":
        value = as_float(state)
        if value is None:
            # A sensor that used to report numbers and now reports text is
            # not a reading we can place against a threshold.
            return SensorReading(state=state, value=None, alerting=False, reachable=True)
        alerting = (sensor.alert_above is not None and value > sensor.alert_above) or (
            sensor.alert_below is not None and value < sensor.alert_below
        )
        return SensorReading(state=state, value=value, alerting=alerting, reachable=True)

    normalized = state.lower()
    alerting = sensor.alert_state is not None and normalized == sensor.alert_state
    return SensorReading(state=normalized, value=None, alerting=alerting, reachable=True)


def describe_state(sensor: _AlertableSensor, reading: SensorReading) -> str:
    """Human-readable state for a notification body ("open", "31.4 °C")."""
    if sensor.kind == "numeric" and reading.value is not None:
        return f"{reading.value:g} {sensor.unit}".strip() if sensor.unit else f"{reading.value:g}"
    return reading.state or "unknown"


ha_sensor_manager = HASensorManager()


async def record_ha_reading(
    db: AsyncSession, sensor: PrinterHASensor | LocationHASensor, reading: SensorReading, now: datetime
) -> None:
    """One ingestion path for live observations, with bounded unchanged samples."""
    if not reading.reachable or reading.state is None:
        return
    owner = "printer_sensor_id" if isinstance(sensor, PrinterHASensor) else "location_sensor_id"
    previous = await db.scalar(
        select(HASensorHistory)
        .where(
            getattr(HASensorHistory, owner) == sensor.id,
            HASensorHistory.revision == sensor.history_revision,
        )
        .order_by(HASensorHistory.observed_at.desc(), HASensorHistory.id.desc())
        .limit(1)
    )
    state = persistable_state(reading.state, 64)
    if (
        previous
        and previous.state == state
        and previous.value == reading.value
        and now - previous.observed_at < timedelta(minutes=5)
    ):
        return
    db.add(
        HASensorHistory(
            **{owner: sensor.id},
            revision=sensor.history_revision,
            entity_id=sensor.entity_id,
            kind=sensor.kind,
            unit=sensor.unit,
            state=state,
            value=reading.value,
            observed_at=now,
        )
    )
