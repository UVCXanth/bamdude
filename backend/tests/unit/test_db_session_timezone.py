"""A PostgreSQL session is pinned to UTC, so database-filled timestamps are UTC (upstream #2855).

BamDude stores naive datetimes that hold UTC, and the frontend reads a timestamp
with no offset as UTC. Python-side writes honour that, but many columns take
their value from ``server_default=func.now()`` or ``DEFAULT CURRENT_TIMESTAMP``
in migration DDL — the database fills those. On PostgreSQL ``now()`` is a
``timestamptz``, and storing it into ``timestamp without time zone`` casts it
through the session ``TimeZone``: a server initialised with ``TZ=Europe/Istanbul``
stamped every defaulted row three hours ahead. SQLite's ``CURRENT_TIMESTAMP`` is
UTC by definition, which is the behaviour PostgreSQL is brought onto.

The bundled PostgreSQL is already initialised on UTC; an external one is
whatever its operator chose, so the pin applies to every PostgreSQL session.
"""

from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.core import database


class TestConnectArgs:
    def test_sqlite_gets_none(self, monkeypatch):
        """No session timezone to pin; an unknown connect arg is a TypeError in aiosqlite."""
        monkeypatch.setattr(database, "is_sqlite", lambda: True)
        assert database._resolve_connect_args() == {}

    def test_asyncpg_pins_the_session_to_utc(self, monkeypatch):
        monkeypatch.setattr(database, "is_sqlite", lambda: False)
        monkeypatch.setattr(database.settings, "database_url", "postgresql+asyncpg://u:p@host:5432/bamdude")
        assert database._resolve_connect_args() == {"server_settings": {"timezone": "UTC"}}

    def test_other_postgres_drivers_go_through_libpq(self, monkeypatch):
        """``server_settings`` is an asyncpg keyword; psycopg takes the libpq option."""
        monkeypatch.setattr(database, "is_sqlite", lambda: False)
        monkeypatch.setattr(database.settings, "database_url", "postgresql+psycopg://u:p@host:5432/bamdude")
        assert database._resolve_connect_args() == {"options": "-c timezone=UTC"}


class TestTheEngineReceivesThem:
    """The resolver is only useful if it reaches ``create_async_engine``."""

    @staticmethod
    def _capture(monkeypatch) -> dict:
        captured: dict = {}

        def fake_create_async_engine(url, **kwargs):
            captured.update(kwargs)
            return create_async_engine("sqlite+aiosqlite:///:memory:")

        monkeypatch.setattr(database, "create_async_engine", fake_create_async_engine)
        # _create_engine records the pool config for /system/db-pool; keep the
        # real one for whatever runs next in this worker.
        monkeypatch.setattr(database, "_pool_config", dict(database._pool_config))
        return captured

    def test_a_postgres_engine_gets_the_pin(self, monkeypatch):
        captured = self._capture(monkeypatch)
        monkeypatch.setattr(database, "is_sqlite", lambda: False)
        monkeypatch.setattr(database.settings, "database_url", "postgresql+asyncpg://u:p@host:5432/bamdude")

        database._create_engine()

        assert captured["connect_args"] == {"server_settings": {"timezone": "UTC"}}

    def test_a_sqlite_engine_gets_no_connect_args(self, monkeypatch):
        captured = self._capture(monkeypatch)
        monkeypatch.setattr(database, "is_sqlite", lambda: True)

        database._create_engine()

        assert "connect_args" not in captured
