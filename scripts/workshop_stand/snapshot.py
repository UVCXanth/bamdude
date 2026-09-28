"""B5: a snapshot of the whole stand database, and what changed between two.

Every row of every table, keyed by its primary key, read straight from the
stand's SQLite file in read-only mode — the runner never imports ``backend``.
Taking everything, not a chosen list, is what makes "nothing changed without a
command" a claim about the database rather than about the tables somebody
thought of: a queue row, an archive, a compensating pair of ledger movements
(same balance, two new rows) all show up.

Excluded: tables that change by merely signing in or reading (auth events and
tokens). No stored column is ignored.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

# Written by authentication itself: a login, a refresh, the rate limiter.
VOLATILE_TABLES = frozenset(
    {
        "auth_ephemeral_tokens",  # revoked JWTs, refresh tokens
        "auth_rate_limit_events",
        "sqlite_sequence",
        "sqlite_stat1",
    }
)


def take(db: Path) -> dict[str, dict[str, dict]]:
    uri = f"file:{Path(db).as_posix()}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    try:
        tables = [
            r[0]
            for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            if r[0] not in VOLATILE_TABLES and not r[0].startswith("sqlite_")
        ]
        out: dict[str, dict[str, dict]] = {}
        for table in tables:
            info = conn.execute(f'PRAGMA table_info("{table}")').fetchall()
            pk = [c["name"] for c in sorted(info, key=lambda c: c["pk"]) if c["pk"]]
            rows = {}
            for index, row in enumerate(conn.execute(f'SELECT * FROM "{table}"')):
                record = dict(row)
                key = "|".join(str(record[c]) for c in pk) if pk else f"#{index}"
                rows[key] = record
            out[table] = rows
        return out
    finally:
        conn.close()


def compare(before: dict, after: dict) -> list[dict]:
    """Every row added, removed or changed between two snapshots — every stored column counts.

    Live estimates (ETA, forecast) are computed per request and never stored, so a
    table snapshot cannot hold them; nothing stored is ignored here."""
    diffs: list[dict] = []
    for table in sorted(set(before) | set(after)):
        old, new = before.get(table, {}), after.get(table, {})
        for key in sorted(set(old) | set(new)):
            if key not in old:
                diffs.append({"table": table, "key": key, "change": "added", "row": new[key]})
            elif key not in new:
                diffs.append({"table": table, "key": key, "change": "removed", "row": old[key]})
            else:
                fields = {
                    f: (old[key].get(f), new[key].get(f))
                    for f in set(old[key]) | set(new[key])
                    if old[key].get(f) != new[key].get(f)
                }
                if fields:
                    diffs.append({"table": table, "key": key, "change": "changed", "fields": fields})
    return diffs
