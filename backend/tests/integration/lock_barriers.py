"""Barriers inside real operations, and a record of their SQL (WS-13 E1, spec BL / R12).

A scenario that runs operation A to its end and only then starts B proves that B
waits for A's commit — it cannot prove the absence of a lock cycle, because A no
longer asks for anything. The helpers here stop an operation right after its N-th
real lock, let the other one reach its own first lock, and only then let both go
on, so the conflicting step happens with both operations holding what they hold
in production.

* :class:`Barriers` wraps lock helpers of a service module (``finished_stock.lock_line``
  and friends). The services call them through their module globals, so replacing
  the attribute catches the internal calls too.
* :func:`first_of` is the coordinator: after A stopped, it waits for the FIRST of
  "B reached its barrier" and "PostgreSQL shows B waiting on a lock". Waiting for
  B's barrier alone would hang the green run, where B cannot pass the lock A holds.
* :class:`SqlRecorder` records, per tagged connection, every DML statement and every
  row lock (``FOR UPDATE`` / ``FOR NO KEY UPDATE``, ``NOWAIT`` noted) with its table.

Used by the PostgreSQL scenario runner (a subprocess) and by SQLite tests alike.
"""

from __future__ import annotations

import asyncio
import re
from collections import defaultdict
from dataclasses import dataclass, field

from sqlalchemy import event, text

DEADLOCK_DETECTED = "40P01"
LOCK_NOT_AVAILABLE = "55P03"


def sqlstate(exc: BaseException) -> str | None:
    """The SQLSTATE a database error carries, wherever SQLAlchemy put it.

    SQLAlchemy wraps the asyncpg error in its DBAPI adapter (``.orig``) and keeps
    the driver's own exception as ``__cause__``; walk both.
    """
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        for candidate in (current, getattr(current, "orig", None)):
            code = getattr(candidate, "sqlstate", None) or getattr(candidate, "pgcode", None)
            if isinstance(code, str):
                return code
        current = current.__cause__ or current.__context__
    return None


@dataclass
class Hold:
    """One session's stop: after its ``after``-th wrapped call it waits for ``release``."""

    after: int
    #: Count only these helpers (by name); None — every wrapped call.
    on: frozenset[str] | None = None
    reached: asyncio.Event = field(default_factory=asyncio.Event)
    release: asyncio.Event = field(default_factory=asyncio.Event)
    count: int = 0
    trail: list[str] = field(default_factory=list)


class Barriers:
    def __init__(self) -> None:
        self._holds: dict[int, Hold] = {}
        self._restore: list[tuple[object, str, object]] = []

    def hold(self, db, *, after: int = 1, on: str | tuple[str, ...] | None = None) -> Hold:
        """Stop the session ``db`` right after its ``after``-th wrapped call (of the
        helpers named ``on``, when given)."""
        names = (on,) if isinstance(on, str) else on
        hold = Hold(after=after, on=frozenset(names) if names else None)
        self._holds[id(db)] = hold
        return hold

    def trail(self, db) -> list[str]:
        hold = self._holds.get(id(db))
        return list(hold.trail) if hold else []

    def wrap(self, module: object, name: str) -> None:
        """Replace ``module.name`` — an ``async def f(db, …)`` — with a counting wrapper."""
        original = getattr(module, name)

        async def wrapped(db, *args, **kwargs):
            result = await original(db, *args, **kwargs)
            hold = self._holds.get(id(db))
            if hold is not None:
                hold.trail.append(name)
                if hold.on is not None and name not in hold.on:
                    return result
                hold.count += 1
                if hold.count == hold.after:
                    hold.reached.set()
                    await hold.release.wait()
            return result

        setattr(module, name, wrapped)
        self._restore.append((module, name, original))

    def release_all(self) -> None:
        for hold in self._holds.values():
            hold.release.set()

    def restore(self) -> None:
        self.release_all()
        for module, name, original in reversed(self._restore):
            setattr(module, name, original)
        self._restore.clear()


async def backend_pid(db) -> int:
    """The PostgreSQL backend of ``db``'s connection — asked first, so it opens the transaction."""
    return int(await db.scalar(text("SELECT pg_backend_pid()")))


async def waiting_on_lock(engine, pid: int) -> bool:
    async with engine.connect() as conn:
        kind = await conn.scalar(text("SELECT wait_event_type FROM pg_stat_activity WHERE pid = :pid"), {"pid": pid})
    return kind == "Lock"


async def first_of(hold: Hold, engine, pid_future: asyncio.Future, *, timeout: float = 15.0) -> str:
    """``"barrier"`` when B stopped at its barrier, ``"waiting"`` when PostgreSQL
    shows it waiting on a lock — whichever comes first. Never waits for a barrier
    B cannot reach."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    pid = await asyncio.wait_for(pid_future, timeout=timeout)
    while True:
        if hold.reached.is_set():
            return "barrier"
        if await waiting_on_lock(engine, pid):
            return "waiting"
        if loop.time() > deadline:
            raise TimeoutError("B neither reached its barrier nor waited on a lock")
        await asyncio.sleep(0.02)


_DML = re.compile(r"^\s*(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+\"?(\w+)\"?", re.IGNORECASE)
_FROM = re.compile(r"\bFROM\s+\"?(\w+)\"?", re.IGNORECASE)
_LOCK = re.compile(r"\bFOR\s+(NO\s+KEY\s+UPDATE|UPDATE|SHARE|KEY\s+SHARE)\b(\s+NOWAIT)?", re.IGNORECASE)


def classify(statement: str) -> tuple[str, str, bool] | None:
    """``(kind, table, nowait)`` for a DML statement or a row lock; None otherwise."""
    dml = _DML.match(statement)
    if dml:
        verb = dml.group(1).split()[0].upper()
        return verb, dml.group(2), False
    lock = _LOCK.search(statement)
    if lock and statement.lstrip().upper().startswith("SELECT"):
        table = _FROM.search(statement)
        return "LOCK " + " ".join(lock.group(1).upper().split()), table.group(1) if table else "?", bool(lock.group(2))
    return None


class SqlRecorder:
    """Every DML and row-lock statement of each TAGGED connection, in order."""

    def __init__(self, sync_engine) -> None:
        self.log: dict[str, list[tuple[str, str, bool]]] = defaultdict(list)
        self._engine = sync_engine
        event.listen(sync_engine, "before_cursor_execute", self._on)

    def _on(self, conn, _cursor, statement, _params, _context, _executemany) -> None:
        tag = conn.info.get("ws13_tag")
        if tag is None:
            return
        found = classify(statement)
        if found is not None:
            self.log[tag].append(found)

    @staticmethod
    async def tag(db, name: str) -> None:
        (await db.connection()).info["ws13_tag"] = name

    @staticmethod
    async def untag(db) -> None:
        (await db.connection()).info.pop("ws13_tag", None)

    def close(self) -> None:
        event.remove(self._engine, "before_cursor_execute", self._on)
