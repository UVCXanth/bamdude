"""Customer contacts, customer kind, an order's contact person and the
delivery-method reference (spec workshop-customers, part B).

- ``delivery_methods`` — name, a Python-computed unique ``name_key``, position;
  seeded in the system language once, as m184 seeds its templates.
- ``customer_contacts`` — several per customer; the lowest ``position`` is the main one.
- ``customers.kind`` (company | regular | private, default company) and ``projects.contact_id``.
- The old free-text ``customers.contact`` moves into each customer's first contact —
  the first e-mail and the first phone into their fields, the rest into the name
  when it is one line of at most 255 characters, otherwise the WHOLE original
  text into that contact's note (nothing is lost; the customer's own notes stay
  untouched) — and then the column is dropped.

The move runs in ``upgrade`` because the drop does: a seed would read a column
already gone. It is guarded on the column still existing, so a re-run
(``DEBUG=true`` re-runs the newest migration) moves nothing twice. A fresh
install gets the tables from ``create_all`` and has no ``contact`` column to move.
"""

import logging
import re

from sqlalchemy import text

from backend.app.migrations.helpers import add_column, column_exists, drop_column, table_exists

logger = logging.getLogger(__name__)

version = 185
name = "customer_contacts"

_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
_PHONE = re.compile(r"\+?\d[\d\s().-]{5,}\d")
_EDGE = " \t,;·|/:–—-"
_MAX_NAME = 255
_SEED = {
    "uk": ("Самовивіз", "Нова пошта", "Укрпошта", "Meest", "Кур'єр"),
    "en": ("Pickup", "Courier", "Post"),
}


def split_legacy_contact(raw: str | None) -> dict[str, str | None] | None:
    """The old free-text contact as a first contact's fields, or None when it was empty."""
    if raw is None or not raw.strip():
        return None
    original = raw.strip()
    rest = original
    email = None
    match = _EMAIL.search(rest)
    if match:
        email = match.group(0)
        rest = rest[: match.start()] + " " + rest[match.end() :]
    phone = None
    for candidate in _PHONE.finditer(rest):
        if sum(ch.isdigit() for ch in candidate.group(0)) >= 7:
            phone = candidate.group(0).strip()
            rest = rest[: candidate.start()] + " " + rest[candidate.end() :]
            break
    lines = [line.strip(_EDGE) for line in rest.splitlines() if line.strip(_EDGE)]
    name = note = None
    if len(lines) > 1:
        note = original
    elif lines:
        one = re.sub(r"\s+", " ", lines[0])
        one = re.sub(r"(?:\s*[,;·|/])+\s*", ", ", one).strip(_EDGE)
        if len(one) > _MAX_NAME:
            note = original
        else:
            name = one or None
    return {"name": name, "phone": phone, "email": email, "note": note}


async def upgrade(conn):
    sqlite = conn.dialect.name == "sqlite"
    pk = "INTEGER PRIMARY KEY AUTOINCREMENT" if sqlite else "SERIAL PRIMARY KEY"

    if not await table_exists(conn, "delivery_methods"):
        await conn.exec_driver_sql(
            f"""
            CREATE TABLE delivery_methods (
                id {pk},
                name VARCHAR(255) NOT NULL,
                name_key VARCHAR(255) NOT NULL UNIQUE,
                position INTEGER NOT NULL DEFAULT 0
            )
            """
        )
    if not await table_exists(conn, "customer_contacts"):
        await conn.exec_driver_sql(
            f"""
            CREATE TABLE customer_contacts (
                id {pk},
                customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
                position INTEGER NOT NULL DEFAULT 0,
                name VARCHAR(255),
                role VARCHAR(255),
                phone VARCHAR(255),
                email VARCHAR(255),
                city VARCHAR(255),
                delivery_method_id INTEGER REFERENCES delivery_methods(id) ON DELETE SET NULL,
                delivery_details VARCHAR(255),
                note TEXT
            )
            """
        )
    await conn.exec_driver_sql(
        "CREATE INDEX IF NOT EXISTS ix_customer_contacts_customer_position ON customer_contacts (customer_id, position)"
    )
    await add_column(conn, "customers", "kind VARCHAR(16) NOT NULL DEFAULT 'company'")
    await add_column(conn, "projects", "contact_id INTEGER REFERENCES customer_contacts(id) ON DELETE SET NULL")

    if await column_exists(conn, "customers", "contact"):
        rows = (await conn.execute(text("SELECT id, contact FROM customers WHERE contact IS NOT NULL"))).all()
        moved = 0
        for customer_id, raw in rows:
            fields = split_legacy_contact(raw)
            if fields is None:
                continue
            await conn.execute(
                text(
                    "INSERT INTO customer_contacts (customer_id, position, name, phone, email, note) "
                    "VALUES (:customer_id, 0, :name, :phone, :email, :note)"
                ),
                {"customer_id": customer_id, **fields},
            )
            moved += 1
        logger.info("m185: moved %d old customer contact(s) into customer_contacts", moved)
        await drop_column(conn, "customers", "contact")


async def seed(session_factory):
    """The delivery reference in the system language — once; the owner edits it afterwards."""
    async with session_factory() as session:
        if (await session.execute(text("SELECT COUNT(*) FROM delivery_methods"))).scalar():
            return
        lang = (await session.execute(text("SELECT value FROM settings WHERE key = 'language'"))).scalar_one_or_none()
        names = _SEED.get((lang or "en").strip().lower(), _SEED["en"])
        for position, method in enumerate(names):
            await session.execute(
                text("INSERT INTO delivery_methods (name, name_key, position) VALUES (:name, :name_key, :position)"),
                {"name": method, "name_key": method.strip().casefold(), "position": position},
            )
        await session.commit()
