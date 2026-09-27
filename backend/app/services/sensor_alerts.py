"""Thresholds on sensor readings: the rule, and the two sweeps that apply it.

The rule is a pure function so it can be read in one screen and tested without
a database. Everything below it exists to feed it the newest reading and to
write down what it decided.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import literal, select, union_all

from backend.app.models.smart_sensor import SmartSensor
from backend.app.models.smart_sensor_binding import SmartSensorBinding
from backend.app.models.smart_sensor_history import SmartSensorHistory
from backend.app.models.smart_sensor_threshold import SmartSensorThreshold
from backend.app.services.notification_service import notification_service
from backend.app.services.zigbee.device_settings import (
    DEFAULT_REPORTING_STALE_MULTIPLIER,
    load_device_row,
    resolve_max_interval,
)
from backend.app.services.zigbee.measurements import BY_KEY

logger = logging.getLogger(__name__)

OK = "ok"
ABOVE = "above"
BELOW = "below"


def next_state(
    current: str,
    value: float,
    *,
    min_value: float | None,
    max_value: float | None,
    deadband: float,
) -> str:
    """What this threshold's state becomes, given a reading.

    The deadband applies **only on the way out**. Applying it on the way in
    would mean a threshold of 30 with a deadband of 1 actually alarms at 31,
    and nothing on any screen would say so.

    A limit that is not set can never be crossed: a threshold carrying only a
    maximum never produces ``below``, whatever the reading.
    """
    if max_value is not None and value > max_value:
        return ABOVE
    if min_value is not None and value < min_value:
        return BELOW

    # Inside both raw limits. Whether an existing alarm clears is the only
    # question left, and it is the only place the deadband is consulted.
    if current == ABOVE:
        if max_value is None or value <= max_value - deadband:
            return OK
        return ABOVE
    if current == BELOW:
        if min_value is None or value >= min_value + deadband:
            return OK
        return BELOW
    return OK


def template_for(previous: str, new: str) -> str | None:
    """Which message a transition is, or None when nothing changed.

    "Above" and "below" are different sentences rather than a variable, because
    the sentence is the translation boundary. There is one all-clear: which
    side it returned from is not news.
    """
    if previous == new:
        return None
    if new == ABOVE:
        return "sensor_above_max"
    if new == BELOW:
        return "sensor_below_min"
    return "sensor_back_in_range"


# When this module was imported, which is within seconds of the loop starting.
# The silence sweep is guarded on it: every sensor's last reading is older than
# a process that just booted, so an unguarded sweep announces silence for the
# whole farm on every restart.
_LOADED_AT = datetime.now(timezone.utc)


def uptime_seconds() -> float:
    return (datetime.now(timezone.utc) - _LOADED_AT).total_seconds()


@dataclass(frozen=True)
class AlertEvent:
    """One thing worth telling somebody. Carries the template key and the
    variables it needs — rendering and sending belong to the notifier."""

    sensor_id: int
    sensor_name: str
    location: str
    template: str
    variables: dict[str, str]
    printer_id: int | None = None


def _place(sensor: SmartSensor) -> str:
    """Where to walk.

    Legacy rows without a binding use their previous scalar target. New events
    name one explicit binding via ``_binding_place`` instead.
    """
    if sensor.printer is not None:
        return sensor.printer.name
    return (sensor.location.path if sensor.location else None) or sensor.name


def _binding_place(binding: SmartSensorBinding) -> str:
    if binding.printer is not None:
        return binding.printer.name
    if binding.printer_location is not None:
        return binding.printer_location.path
    if binding.storage_location is not None:
        return binding.storage_location.name
    return binding.sensor.name


def _number(value: float) -> str:
    """Trailing zeros make a limit of 30 read as 30.0, which looks like a
    measurement rather than a setting."""
    return f"{value:g}"


async def evaluate_thresholds(db) -> list[AlertEvent]:
    """Apply every enabled threshold to the newest reading it has, and write
    down what changed.

    The input is the newest recorded row, not whatever was just flushed: that
    way the decision does not depend on which path a reading took into the
    database, and it survives a restart between a report and a flush. Reading
    the same unchanged value on every tick is harmless — only a CHANGE of state
    produces an event.

    One query per threshold. There is one row per sensor per quantity, so the
    count is a handful; a window function that had to be written twice for two
    engines would cost more than it saves.
    """
    events: list[AlertEvent] = []
    defaults = (await db.execute(select(SmartSensorThreshold))).scalars().all()
    bindings = (await db.execute(select(SmartSensorBinding))).scalars().all()
    by_sensor: dict[int, list[SmartSensorBinding]] = {}
    for binding in bindings:
        by_sensor.setdefault(binding.sensor_id, []).append(binding)
    default_by_key = {(row.sensor_id, row.kind): row for row in defaults}
    readings: dict[tuple[int, str], SmartSensorHistory | None] = {}

    async def newest(sensor_id: int, kind: str):
        key = sensor_id, kind
        if key not in readings:
            readings[key] = (
                await db.execute(
                    select(SmartSensorHistory)
                    .where(SmartSensorHistory.sensor_id == sensor_id, SmartSensorHistory.sensor_kind == kind)
                    .order_by(SmartSensorHistory.recorded_at.desc())
                    .limit(1)
                )
            ).scalar_one_or_none()
        return readings[key]

    async def evaluate(rule, sensor_id: int, kind: str, place: str, printer_id: int | None, deliver: bool):
        if not rule.enabled:
            if rule.state != OK:
                rule.state = OK
                rule.state_since = datetime.now(timezone.utc)
            return
        reading = await newest(sensor_id, kind)
        if reading is None:
            return
        state = next_state(
            rule.state, reading.value, min_value=rule.min_value, max_value=rule.max_value, deadband=rule.deadband or 0.0
        )
        template = template_for(rule.state, state)
        if template is None:
            return
        sensor = await db.get(SmartSensor, sensor_id)
        if sensor is None:
            return
        if deliver:
            measurement = BY_KEY.get(kind)
            limit = rule.max_value if state == ABOVE else rule.min_value
            events.append(
                AlertEvent(
                    sensor_id=sensor_id,
                    sensor_name=sensor.name,
                    location=place,
                    template=template,
                    printer_id=printer_id,
                    variables={
                        "location": place,
                        "sensor": sensor.name,
                        "quantity": kind,
                        "value": _number(reading.value),
                        "unit": measurement.unit if measurement else "",
                        "limit": _number(limit) if limit is not None else "",
                    },
                )
            )
            rule.notified_at = datetime.now(timezone.utc)
        rule.state = state
        rule.state_since = datetime.now(timezone.utc)

    for rule in defaults:
        sensor = await db.get(SmartSensor, rule.sensor_id)
        if sensor is not None:
            await evaluate(rule, rule.sensor_id, rule.kind, _place(sensor), None, not by_sensor.get(rule.sensor_id))

    for binding in bindings:
        own_rules = {row.kind: row for row in binding.thresholds}
        kinds = {kind for sensor_id, kind in default_by_key if sensor_id == binding.sensor_id} | {
            kind for kind, row in own_rules.items() if row.custom
        }
        for kind in kinds:
            default = default_by_key.get((binding.sensor_id, kind))
            state_row = own_rules.get(kind)
            if state_row is None:
                from backend.app.models.smart_sensor_binding import SmartSensorBindingThreshold

                state_row = SmartSensorBindingThreshold(
                    binding_id=binding.id,
                    kind=kind,
                    # A default added after the binding exists is a new rule.
                    # Its first violating reading must still reach this target.
                    state=OK,
                )
                db.add(state_row)
            if state_row.custom:
                effective = state_row
            elif default is not None:
                effective = default
            else:
                continue
            # Inherited configuration with independent persistent state.
            if not state_row.custom:

                class InheritedRule:
                    pass

                inherited = InheritedRule()
                inherited.enabled = effective.enabled
                inherited.min_value = effective.min_value
                inherited.max_value = effective.max_value
                inherited.deadband = effective.deadband
                inherited.state = state_row.state
                inherited.state_since = state_row.state_since
                inherited.notified_at = state_row.notified_at
                effective = inherited
            await evaluate(
                effective, binding.sensor_id, kind, _binding_place(binding), binding.printer_id, binding.notify_enabled
            )
            if effective is not state_row:
                state_row.state = effective.state
                state_row.state_since = effective.state_since
                state_row.notified_at = effective.notified_at

    # Committed BEFORE anything is sent. The other order turns a sustained
    # database failure into an identical message every minute.
    await db.commit()
    return events


def _newest_per_kind_stmt(sensor_id: int):
    """One row per quantity this sensor has recorded, carrying its newest reading.

    ⚠️ It asks about the quantities the REGISTRY knows instead of asking the
    database which ones exist. ``SELECT DISTINCT sensor_kind WHERE sensor_id = ?``
    reads every row of that sensor to return four short strings, and there is no
    way around it: PostgreSQL has no loose index scan for a DISTINCT on the
    second column of an index whose first column is fixed, so the work grows
    with retention forever while the answer stays four rows. The same was true
    of the ``ORDER BY recorded_at DESC LIMIT 1`` that used to follow it — the
    shipped index is ``(sensor_id, sensor_kind, recorded_at)``, which gives no
    ordering by time once only ``sensor_id`` is pinned.

    Measured on a live 94 133-row table, one sensor: the two old statements cost
    20.9 ms / 804 buffers and 12.4 ms / 807 buffers. This one costs 0.1 ms and
    28 buffers, on the index that already exists — a handful of
    ``Index Only Scan Backward … LIMIT 1`` probes instead of two full passes.

    ⚠️ Exact rather than approximate because the registry is the ONLY writer of
    ``sensor_kind``: ``zigbee/sensors.py`` takes the key from the same table
    before buffering a reading, so a quantity absent from the registry cannot be
    in the history. The corollary is the thing to remember — **removing a key
    from the registry hides its recorded history from this sweep**.
    """
    parts = []
    for kind in BY_KEY:
        newest = (
            select(SmartSensorHistory.recorded_at.label("recorded_at"))
            .where(SmartSensorHistory.sensor_id == sensor_id, SmartSensorHistory.sensor_kind == kind)
            .order_by(SmartSensorHistory.recorded_at.desc())
            .limit(1)
            .subquery()
        )
        # Wrapped in a subquery rather than unioned directly: SQLite refuses
        # ORDER BY / LIMIT inside a branch of a compound SELECT.
        parts.append(select(literal(kind).label("kind"), newest.c.recorded_at))
    return union_all(*parts)


async def _recorded_kinds(db, sensor: SmartSensor) -> list[tuple[str, datetime]]:
    """What this sensor has recorded, and when it last did, per quantity."""
    rows = (await db.execute(_newest_per_kind_stmt(sensor.id))).all()
    return [(row[0], row[1]) for row in rows if row[1] is not None]


async def _silence_window(db, sensor: SmartSensor, kinds: list[str]) -> int | None:
    """How long this sensor may be quiet before it counts as silent.

    The longest of its own staleness windows, over the quantities it has
    actually recorded. No new number is introduced: that window already exists,
    is derived from what the device promised, and is already overridable per
    device.
    """
    if not kinds:
        return None

    row = await load_device_row(db, sensor.zigbee_ieee)
    if row is not None and row.stale_after_seconds:
        return int(row.stale_after_seconds)

    windows = []
    for kind in kinds:
        interval = await resolve_max_interval(db, sensor.zigbee_ieee, kind)
        if interval > 0:
            windows.append(interval * DEFAULT_REPORTING_STALE_MULTIPLIER)
    return max(windows) if windows else None


async def sweep_silence(db, *, uptime_seconds: float) -> list[AlertEvent]:
    """Notice sensors that stopped talking, and ones that started again.

    Every adopted sensor, not only those carrying thresholds: adoption is
    itself the deliberate act of caring about a device. Nobody who did not ask
    is troubled, because ``on_sensor_silent`` defaults to off.
    """
    events: list[AlertEvent] = []
    now = datetime.now(timezone.utc)
    sensors = (await db.execute(select(SmartSensor))).scalars().all()

    for sensor in sensors:
        # One read answers both questions this loop asks of the history — which
        # quantities exist, and when the last of them arrived.
        recorded = await _recorded_kinds(db, sensor)
        window = await _silence_window(db, sensor, [kind for kind, _ in recorded])
        if window is None:
            # Never reported. That is "not set up yet", not "went silent".
            continue
        # A process younger than the window cannot tell silence from a restart.
        if uptime_seconds < window:
            continue

        newest = max((at for _, at in recorded), default=None)
        if newest is None:
            continue
        if newest.tzinfo is None:
            # SQLite hands back naive datetimes; everything computed here is
            # aware, and subtracting one from the other raises.
            newest = newest.replace(tzinfo=timezone.utc)

        quiet_for = (now - newest).total_seconds()
        bindings = (
            (await db.execute(select(SmartSensorBinding).where(SmartSensorBinding.sensor_id == sensor.id)))
            .scalars()
            .all()
        )
        targets = [(binding, _binding_place(binding)) for binding in bindings if binding.notify_enabled]
        if not bindings:
            targets = [(None, _place(sensor))]

        if quiet_for > window and sensor.silent_since is None:
            sensor.silent_since = newest
            sensor.silence_notified_at = now
            for binding, place in targets:
                events.append(
                    AlertEvent(
                        sensor_id=sensor.id,
                        sensor_name=sensor.name,
                        location=place,
                        template="sensor_silent",
                        printer_id=binding.printer_id if binding else None,
                        variables={"location": place, "sensor": sensor.name, "minutes": str(int(quiet_for // 60))},
                    )
                )
        elif quiet_for <= window and sensor.silent_since is not None:
            sensor.silent_since = None
            sensor.silence_notified_at = now
            for binding, place in targets:
                events.append(
                    AlertEvent(
                        sensor_id=sensor.id,
                        sensor_name=sensor.name,
                        location=place,
                        template="sensor_speaking_again",
                        printer_id=binding.printer_id if binding else None,
                        variables={"location": place, "sensor": sensor.name},
                    )
                )

    await db.commit()
    return events


async def run_sensor_alerts(db) -> int:
    """One tick: decide, then tell. Returns how many alerts were sent.

    Every send is wrapped. This runs inside the loop that also writes
    measurement history and prunes it, and an exception there is a feature that
    silently stops working — taking the other two with it.
    """
    events = await evaluate_thresholds(db)
    events.extend(await sweep_silence(db, uptime_seconds=uptime_seconds()))

    sent = 0
    for event in events:
        try:
            await notification_service.on_sensor_alert(event, db)
            sent += 1
        except Exception as exc:  # noqa: BLE001 — see the docstring
            logger.warning("Sensor alert %s for sensor %s not sent: %s", event.template, event.sensor_id, exc)
    return sent
