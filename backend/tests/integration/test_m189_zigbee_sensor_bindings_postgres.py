"""The legacy sensor backfill must accept PostgreSQL boolean columns."""

import pytest
from sqlalchemy import URL, text
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.core.config import settings
from backend.app.core.database import Base, import_all_models
from backend.app.migrations import m189_zigbee_sensor_bindings as m189
from backend.app.services import embedded_postgres as ep
from backend.tests.integration.test_embedded_postgres_live import live_settings  # noqa: F401

pytest.importorskip("embedded_postgres")
pytestmark = [pytest.mark.asyncio, pytest.mark.integration, pytest.mark.slow]


async def test_legacy_sensor_backfill_on_postgres(live_settings):
    engine = None
    try:
        await ep.start()
        engine = create_async_engine(
            URL.create(
                "postgresql+asyncpg",
                username=ep.PG_USER,
                password="live-test-password",
                host=ep.PG_HOST,
                port=settings.embedded_pg_port,
                database=ep.PG_DATABASE,
            )
        )
        import_all_models()
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
            await conn.execute(text("INSERT INTO printer_locations (id, name, name_key) VALUES (5, 'Room', 'room')"))
            await conn.execute(
                text("INSERT INTO smart_sensors (id, name, location_id, zigbee_ieee) VALUES (1, 'Sensor', 5, 'aa:bb')")
            )
            await conn.execute(
                text("INSERT INTO smart_sensor_thresholds (sensor_id, kind, state) VALUES (1, 'temperature', 'above')")
            )
            await m189.upgrade(conn)
            await m189.upgrade(conn)
            assert (
                await conn.execute(
                    text("SELECT sensor_id, printer_location_id, notify_enabled FROM smart_sensor_bindings")
                )
            ).all() == [(1, 5, True)]
            assert (
                await conn.execute(text("SELECT kind, custom, state FROM smart_sensor_binding_thresholds"))
            ).all() == [("temperature", False, "above")]
    finally:
        if engine is not None:
            await engine.dispose()
        await ep.stop()
