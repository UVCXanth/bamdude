"""Customer contacts, customer kind, an order's contact person and the
delivery-method reference (spec workshop-customers, part B).

- ``delivery_methods`` — name, a Python-computed unique ``name_key``, position;
  seeded in the system language once, as m184 seeds its templates.
- ``customer_contacts`` — several per customer; the lowest ``position`` is the main one.
- ``customers.kind`` (company | regular | private, default company) and ``projects.contact_id``.
- The old free-text ``customers.contact`` moves into each customer's first contact —
  the first e-mail and the first phone into their fields, the one line left into
  the name with its separators as written; whenever the text cannot be kept as
  it stood (more lines left, a field over 255 characters, a name that is no
  longer a verbatim slice of the original) the WHOLE original also goes into
  that contact's note. Nothing is lost; the customer's own notes stay untouched.
  Then the column is dropped.

Numbered 190: the migrations run in one unbroken sequence, and ``feature/v0.6.1-fixes``
holds 184–189; the workshop's two follow as 190 and 191
(``test_migration_versions_are_unique`` makes a clash a red build).

The move runs in ``upgrade`` because the drop does: a seed would read a column
already gone. It is guarded on the column still existing and on the customer
having no contacts yet, so a re-run (``DEBUG=true`` re-runs the newest
migration) moves nothing twice — even on an SQLite too old to drop the column.
A fresh install gets the tables from ``create_all`` and has no ``contact``
column to move.
"""

import logging
import re

from sqlalchemy import text

from backend.app.migrations.helpers import add_column, column_exists, drop_column, table_exists

logger = logging.getLogger(__name__)

version = 190
name = "customer_contacts"

_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
# Digits, spaces, brackets and hyphens only: no dot (a date is not a phone) and
# no line break (a phone must never swallow the next line).
_PHONE = re.compile(r"\+?\d[\d ()\-]{5,}\d")
_EDGE = " \t,;·|/:–—-"
_MAX_FIELD = 255
_SEED = {
    "uk": ("Самовивіз", "Нова пошта", "Укрпошта", "Meest", "Кур'єр"),
    "en": ("Pickup", "Courier", "Post"),
}


def split_legacy_contact(raw: str | None) -> dict[str, str | None] | None:
    """The old free-text contact as a first contact's fields, or None when it was empty.

    The first e-mail and the first phone come out into their fields; the one
    line left becomes the name, its separators exactly as they were. Nothing is
    lost: whenever the text cannot be kept as it stood — more than one line left,
    a field over 255 characters, or a name that is no longer a verbatim slice of
    the original (pieced together around a phone) — the WHOLE original goes into
    the note as well.
    """
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
    keep_whole = len(lines) > 1
    name = None
    if len(lines) == 1:
        # Only runs of blanks and of repeated commas/semicolons (the holes the
        # extraction left) are tidied; a single separator stays as written.
        name = re.sub(r"(?:\s*[,;]){2,}\s*", ", ", re.sub(r"[ \t]+", " ", lines[0]))
        if len(name) > _MAX_FIELD or name not in original:
            keep_whole = True
        if len(name) > _MAX_FIELD:
            name = None
    if email is not None and len(email) > _MAX_FIELD:
        email, keep_whole = None, True
    if phone is not None and len(phone) > _MAX_FIELD:
        phone, keep_whole = None, True
    return {"name": name, "phone": phone, "email": email, "note": original if keep_whole else None}


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
    # The contacts' order counts group on it, and PostgreSQL's SET NULL check scans it.
    await conn.exec_driver_sql("CREATE INDEX IF NOT EXISTS ix_projects_contact_id ON projects (contact_id)")

    if await column_exists(conn, "customers", "contact"):
        # ``NOT EXISTS``: on an SQLite too old to drop the column, ``DEBUG=true``
        # re-runs this every start — a customer that has contacts moved nothing twice.
        rows = (
            await conn.execute(
                text(
                    "SELECT id, contact FROM customers WHERE contact IS NOT NULL AND NOT EXISTS "
                    "(SELECT 1 FROM customer_contacts WHERE customer_contacts.customer_id = customers.id)"
                )
            )
        ).all()
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
        logger.info("m190: moved %d old customer contact(s) into customer_contacts", moved)
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
