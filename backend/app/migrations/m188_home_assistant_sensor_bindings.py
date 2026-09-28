"""Add independent Home Assistant entity bindings for printers and storage.

HA entity IDs are not Zigbee IEEE addresses. Each target owns its own alert
rule and last state; the same HA entity may serve several targets. Creating
the tables through their models gives fresh and upgraded databases identical
indexes on SQLite and PostgreSQL. The migration is safe to rerun in DEBUG.
"""

from sqlalchemy import select

from backend.app.models.ha_sensor_history import HASensorHistory
from backend.app.models.location_ha_sensor import LocationHASensor
from backend.app.models.location_sensor_primary import LocationSensorPrimary
from backend.app.models.printer_ha_sensor import PrinterHASensor

version = 188
name = "home_assistant_sensor_bindings"


async def upgrade(conn):
    await conn.run_sync(lambda sync: PrinterHASensor.__table__.create(sync, checkfirst=True))
    await conn.run_sync(lambda sync: LocationHASensor.__table__.create(sync, checkfirst=True))
    await conn.run_sync(lambda sync: HASensorHistory.__table__.create(sync, checkfirst=True))
    await conn.run_sync(lambda sync: LocationSensorPrimary.__table__.create(sync, checkfirst=True))


async def seed(session_factory):
    from backend.app.models.notification_template import DEFAULT_TEMPLATES, NotificationTemplate
    from backend.app.models.settings import Settings

    event_types = {"ha_sensor_alert", "location_ha_sensor_alert"}
    async with session_factory() as session:
        lang = await session.scalar(select(Settings.value).where(Settings.key == "language"))
        locale_templates = {}
        if lang == "uk":
            import json
            from pathlib import Path

            path = Path(__file__).parent.parent / "data" / "notification_templates_uk.json"
            locale_templates = json.loads(path.read_text(encoding="utf-8"))
        existing = set(
            (
                await session.scalars(
                    select(NotificationTemplate.event_type).where(NotificationTemplate.event_type.in_(event_types))
                )
            ).all()
        )
        for default in DEFAULT_TEMPLATES:
            event_type = default["event_type"]
            if event_type not in event_types or event_type in existing:
                continue
            data = locale_templates.get(event_type, default)
            session.add(
                NotificationTemplate(
                    event_type=event_type,
                    name=data["name"],
                    title_template=data["title_template"],
                    body_template=data["body_template"],
                    is_default=True,
                )
            )
        await session.commit()
