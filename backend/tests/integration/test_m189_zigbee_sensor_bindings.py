"""Upgrade existing adopted sensors without losing their rule and alarm state."""

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.migrations import m189_zigbee_sensor_bindings as m189

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]


async def test_legacy_targets_backfill_once_with_printer_precedence_and_alert_state(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{(tmp_path / 'm189.db').as_posix()}")
    try:
        async with engine.begin() as conn:
            await conn.execute(
                text("""
                CREATE TABLE smart_sensors (
                    id INTEGER PRIMARY KEY, printer_id INTEGER, location_id INTEGER,
                    zigbee_ieee TEXT NOT NULL UNIQUE
                )
            """)
            )
            await conn.execute(
                text("""
                CREATE TABLE smart_sensor_thresholds (
                    id INTEGER PRIMARY KEY, sensor_id INTEGER, kind TEXT, state TEXT,
                    state_since DATETIME, notified_at DATETIME
                )
            """)
            )
            await conn.execute(text("INSERT INTO smart_sensors VALUES (1, 3, 5, 'aa:bb')"))
            await conn.execute(text("INSERT INTO smart_sensors VALUES (2, NULL, 5, 'cc:dd')"))
            await conn.execute(text("INSERT INTO smart_sensors VALUES (3, NULL, NULL, 'ee:ff')"))
            await conn.execute(
                text("""
                INSERT INTO smart_sensor_thresholds VALUES
                    (7, 1, 'temperature', 'above', '2026-09-26 10:00:00', '2026-09-26 10:01:00')
            """)
            )
            await m189.upgrade(conn)
            await m189.upgrade(conn)

            bindings = (
                await conn.execute(
                    text("""
                SELECT sensor_id, printer_id, printer_location_id, notify_enabled
                FROM smart_sensor_bindings ORDER BY sensor_id
            """)
                )
            ).all()
            assert bindings == [(1, 3, None, 1), (2, None, 5, 1)]
            state = (
                await conn.execute(
                    text("""
                SELECT kind, state, notified_at FROM smart_sensor_binding_thresholds
            """)
                )
            ).one()
            assert state.kind == "temperature"
            assert state.state == "above"
            assert str(state.notified_at).startswith("2026-09-26 10:01:00")
    finally:
        await engine.dispose()
