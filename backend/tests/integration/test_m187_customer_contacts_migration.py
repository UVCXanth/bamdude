"""m187 — customer contacts, kind, order contact, delivery methods; the old contact moves and its column goes."""

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.migrations import m187_customer_contacts as m187


@pytest_asyncio.fixture
async def engine():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "CREATE TABLE customers (id INTEGER PRIMARY KEY, name VARCHAR(255) NOT NULL, contact TEXT, "
                "notes TEXT, created_at DATETIME, updated_at DATETIME)"
            )
        )
        await conn.execute(
            text("CREATE TABLE projects (id INTEGER PRIMARY KEY, name VARCHAR(255), customer_id INTEGER)")
        )
        await conn.execute(text("CREATE TABLE settings (id INTEGER PRIMARY KEY, key VARCHAR(100), value TEXT)"))
        await conn.execute(text("INSERT INTO settings (key, value) VALUES ('language', 'uk')"))
        await conn.execute(
            text(
                "INSERT INTO customers (id, name, contact, notes) VALUES "
                "(1, 'ACME', 'Іван, +380 67 123 45 67, ivan@x.ua', 'pays late'), "
                "(2, 'Beta', NULL, NULL), (3, 'Gamma', '  ', NULL), "
                "(4, 'Delta', 'Олена\nbuh@x.ua\nтел 050 111 22 33', NULL)"
            )
        )
        await conn.execute(text("INSERT INTO projects (id, name, customer_id) VALUES (1, 'A', 1)"))
    try:
        yield engine
    finally:
        await engine.dispose()


async def _run(engine):
    async with engine.begin() as conn:
        await m187.upgrade(conn)
    await m187.seed(async_sessionmaker(engine))


@pytest.mark.asyncio
async def test_the_old_contact_moves_into_first_contacts_and_its_column_goes(engine):
    await _run(engine)
    async with engine.connect() as conn:
        cols = {row[1] for row in (await conn.execute(text("PRAGMA table_info(customers)"))).all()}
        assert "contact" not in cols and "kind" in cols
        rows = (
            await conn.execute(
                text(
                    "SELECT customer_id, position, name, phone, email, note FROM customer_contacts ORDER BY customer_id"
                )
            )
        ).all()
        assert rows == [
            (1, 0, "Іван", "+380 67 123 45 67", "ivan@x.ua", None),
            (4, 0, None, "050 111 22 33", "buh@x.ua", "Олена\nbuh@x.ua\nтел 050 111 22 33"),
        ]
        assert (await conn.execute(text("SELECT notes FROM customers WHERE id = 1"))).scalar() == "pays late"
        assert {r[0] for r in (await conn.execute(text("SELECT kind FROM customers"))).all()} == {"company"}
        assert (await conn.execute(text("SELECT contact_id FROM projects WHERE id = 1"))).scalar() is None


@pytest.mark.asyncio
async def test_the_reference_is_seeded_in_the_system_language_once(engine):
    await _run(engine)
    await _run(engine)  # DEBUG=true re-runs the newest migration: nothing doubles
    async with engine.connect() as conn:
        names = [r[0] for r in (await conn.execute(text("SELECT name FROM delivery_methods ORDER BY position"))).all()]
        assert names == ["Самовивіз", "Нова пошта", "Укрпошта", "Meest", "Кур'єр"]
        assert (await conn.execute(text("SELECT COUNT(*) FROM customer_contacts"))).scalar() == 2
