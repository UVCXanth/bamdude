"""Finished goods — the ONE writer (spec workshop-finished-goods, rules 7–13).

Writes ``stock_items`` (the ``on_hand`` / ``reserved`` columns, the location and
the minimum) and ``stock_item_movements``; nothing else does
(``tests/unit/test_finished_stock_has_one_writer.py``). Every operation locks
the position row — ``FOR UPDATE`` on PostgreSQL, SQLite's write lock taken
before the read (``core/database.take_write_lock``) — decides against what it
read under the lock, writes ONE
movement and moves the columns by the same deltas in the caller's transaction —
so the columns always equal the sum of the ledger. The columns are what lists,
filters and sorts read; the ledger is the history.

Never commits; never writes a zero movement. A position's configuration is
``line_config``'s to write, and its kit is ``line_composition``'s to read.
Refusals are :class:`FinishedStockError` — an English sentence the route
forwards verbatim (translated at the boundary) with its HTTP status.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping

from sqlalchemy import delete, func, select, tuple_, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.database import take_write_lock
from backend.app.models.finished_stock import MOVEMENT_KINDS, StockItem, StockItemMovement
from backend.app.models.product import Product, ProductOrigin, ProductPart
from backend.app.models.project_line import ProjectLine
from backend.app.models.stock_issue import StockIssue
from backend.app.models.user import User
from backend.app.services import line_config, part_stock
from backend.app.services.line_composition import (
    Composition,
    LineConfig,
    compositions_for_items,
    counted,
    load_line_configs,
)


class FinishedStockError(Exception):
    """A movement or position the finished-goods ledger refuses; ``status`` is the HTTP answer."""

    def __init__(self, detail: str, status: int = 409) -> None:
        super().__init__(detail)
        self.status = status


def lock_item_stmt(item_id: int):
    """The SELECT every decision rides behind: the row lock, and a fresh read
    (``populate_existing``) rather than the identity map's copy."""
    return select(StockItem).where(StockItem.id == item_id).with_for_update().execution_options(populate_existing=True)


async def lock_item(db: AsyncSession, item_id: int) -> StockItem | None:
    """The position row, locked and read fresh — on SQLite after taking the write
    lock (``take_write_lock``), which is what its dialect's missing ``FOR UPDATE``
    leaves to us."""
    await take_write_lock(db, StockItem.__table__, item_id)
    return (await db.execute(lock_item_stmt(item_id))).scalar_one_or_none()


async def _find_item(db: AsyncSession, product_id: int, key: str) -> StockItem | None:
    return (
        await db.execute(select(StockItem).where(StockItem.product_id == product_id, StockItem.config_key == key))
    ).scalar_one_or_none()


async def item_for(
    db: AsyncSession,
    product_id: int,
    choices: Mapping[int, int],
    counts: Mapping[int, int] | None = None,
    *,
    create: bool,
    any_origin: bool = False,
) -> StockItem | None:
    """The position of this product configuration — found by its key, or created
    when ``create`` (spec rule 9). Only catalogue products are kept (rule 6)."""
    origin = await db.scalar(select(Product.origin).where(Product.id == product_id))
    if origin is None:
        raise FinishedStockError("Product not found", 404)
    if origin != ProductOrigin.CATALOG.value and not any_origin:
        raise FinishedStockError("Only catalogue products are kept in stock", 422)
    try:
        key, new_choices, new_counts = await line_config.resolve(db, product_id, choices, counts)
    except line_config.LineConfigError as e:
        raise FinishedStockError(str(e), e.status) from e
    item = await _find_item(db, product_id, key)
    if item is not None or not create:
        return item
    # Two first receipts of one new configuration at the same moment would both
    # INSERT and the second would meet UNIQUE(product_id, config_key) as a 500.
    # The creation is serialised on the PRODUCT row instead, and the key looked up
    # again under that lock: the second one finds the position the first created.
    # (Not a savepoint: RELEASE of the outermost SAVEPOINT is a COMMIT on SQLite.)
    await take_write_lock(db, Product.__table__, product_id)
    await db.execute(select(Product.id).where(Product.id == product_id).with_for_update())
    item = await _find_item(db, product_id, key)
    if item is not None:
        return item
    item = StockItem(product_id=product_id, config_key=key)
    db.add(item)
    await db.flush()
    await line_config.seed_item(db, item, new_choices, new_counts)
    await db.flush()
    return item


def _at_least_one(qty: int) -> None:
    if qty < 1:
        raise FinishedStockError("Quantity must be at least 1", 422)


async def _record(
    db: AsyncSession,
    item: StockItem,
    kind: str,
    d_on_hand: int,
    d_reserved: int,
    *,
    note: str | None,
    customer_id: int | None = None,
    actor: User | None = None,
    line: ProjectLine | None = None,
    d_line: int = 0,
    counters: Mapping[str, int] | None = None,
    stock_issue_id: int | None = None,
) -> StockItemMovement:
    """Write one movement and move the columns by it — the only place both happen.

    Under an order ``line`` the movement names the line and its order, and the
    line's ``from_finished`` moves by ``d_line`` in the same flush (spec
    workshop-add-to-order, rule 1): a reserve adds, a release takes back, an
    issue leaves it — the units stay the line's. ``counters`` moves the line's
    WS-11 counters (``assembled`` / ``received`` / ``issued`` / ``returned``) the
    same way; ``stock_issue_id`` names the issue an ``issue`` belongs to."""
    if kind not in MOVEMENT_KINDS:
        raise ValueError(f"unknown finished-goods movement {kind!r}")
    locked = await lock_item(db, item.id)
    on_hand, reserved = locked.on_hand + d_on_hand, locked.reserved + d_reserved
    counters = dict(counters or {})
    below = line is not None and (
        line.from_finished + d_line < 0 or any((getattr(line, name) or 0) + n < 0 for name, n in counters.items())
    )
    if on_hand < 0 or reserved < 0 or reserved > on_hand or below:
        # The callers decide under the same lock, so this is a backstop, not a path.
        raise FinishedStockError("Stock never goes below zero")
    move = StockItemMovement(
        item_id=item.id,
        kind=kind,
        delta_on_hand=d_on_hand,
        delta_reserved=d_reserved,
        note=(note or "").strip() or None,
        customer_id=customer_id,
        created_by=actor.id if actor else None,
        project_id=line.project_id if line is not None else None,
        project_line_id=line.id if line is not None else None,
        stock_issue_id=stock_issue_id,
    )
    db.add(move)
    locked.on_hand, locked.reserved = on_hand, reserved
    if line is not None:
        line.from_finished += d_line
        for name, n in counters.items():
            setattr(line, name, (getattr(line, name) or 0) + n)
    await db.flush()
    return move


async def receive(
    db: AsyncSession, item: StockItem, qty: int, *, note: str | None = None, actor: User | None = None
) -> StockItemMovement:
    """Надходження: finished units come in."""
    _at_least_one(qty)
    return await _record(db, item, "receipt", qty, 0, note=note, actor=actor)


async def stocktake(
    db: AsyncSession, item: StockItem, counted: int, *, note: str | None = None, actor: User | None = None
) -> StockItemMovement | None:
    """Інвентаризація: the counted quantity; the movement is the difference (rule 10).

    No difference — no movement (``None``). Below the reserved — 409: a count
    cannot silently eat a reservation. A decrease needs a note — the operator
    says why units are missing.
    """
    if counted < 0:
        raise FinishedStockError("Quantity must be at least 0", 422)
    locked = await lock_item(db, item.id)
    delta = counted - locked.on_hand
    if delta == 0:
        return None
    if counted < locked.reserved:
        raise FinishedStockError(
            f"The count cannot be below the {locked.reserved} reserved; release the reservation first"
        )
    if delta < 0 and not (note or "").strip():
        raise FinishedStockError("A lower count needs a note", 422)
    return await _record(db, item, "stocktake", delta, 0, note=note, actor=actor)


async def reserve(
    db: AsyncSession, item: StockItem, qty: int, *, note: str | None = None, actor: User | None = None
) -> StockItemMovement:
    """Резерв без замовлення: no more than is available."""
    _at_least_one(qty)
    locked = await lock_item(db, item.id)
    available = locked.on_hand - locked.reserved
    if qty > available:
        raise FinishedStockError(f"Only {available} available")
    return await _record(db, item, "reserve", 0, qty, note=note, actor=actor)


async def unassigned_reserved(db: AsyncSession, item: StockItem) -> int:
    """The reservation held without an order line: the column minus what order lines hold (WS-10)."""
    by_lines = await db.scalar(
        select(func.coalesce(func.sum(StockItemMovement.delta_reserved), 0)).where(
            StockItemMovement.item_id == item.id, StockItemMovement.project_line_id.is_not(None)
        )
    )
    return item.reserved - int(by_lines or 0)


async def release(
    db: AsyncSession, item: StockItem, qty: int, *, note: str | None = None, actor: User | None = None
) -> StockItemMovement:
    """Зняти резерв: only what is reserved without an order."""
    _at_least_one(qty)
    locked = await lock_item(db, item.id)
    free = await unassigned_reserved(db, locked)
    if qty > free:
        raise FinishedStockError(f"Only {free} reserved without an order")
    return await _record(db, item, "release", 0, -qty, note=note, actor=actor)


async def issue(
    db: AsyncSession,
    item: StockItem,
    qty: int,
    *,
    from_reserve: bool = False,
    customer_id: int | None = None,
    note: str | None = None,
    actor: User | None = None,
) -> StockItemMovement:
    """Видати: out of what is available, or — ``from_reserve`` — out of the
    reservation held without an order (both columns go down)."""
    _at_least_one(qty)
    locked = await lock_item(db, item.id)
    if from_reserve:
        free = await unassigned_reserved(db, locked)
        if qty > free:
            raise FinishedStockError(f"Only {free} reserved without an order")
        return await _record(db, item, "issue", -qty, -qty, note=note, customer_id=customer_id, actor=actor)
    available = locked.on_hand - locked.reserved
    if qty > available:
        raise FinishedStockError(f"Only {available} available")
    return await _record(db, item, "issue", -qty, 0, note=note, customer_id=customer_id, actor=actor)


# ---------- order lines (spec workshop-add-to-order, rules 1–9) ----------


async def position_for_key(db: AsyncSession, product_id: int, key: str) -> StockItem | None:
    """The finished-goods position of a (product, configuration key) — an order line's by its ``config_key``."""
    return await _find_item(db, product_id, key)


async def held_for_line(db: AsyncSession, line_id: int) -> int:
    """Units the line still holds in reserve, in whatever position — Σ ``delta_reserved`` of its movements."""
    total = await db.scalar(
        select(func.coalesce(func.sum(StockItemMovement.delta_reserved), 0)).where(
            StockItemMovement.project_line_id == line_id
        )
    )
    return int(total or 0)


async def held_by_item(db: AsyncSession, line_id: int) -> dict[int, int]:
    """``item_id → units`` the line still holds there."""
    rows = await db.execute(
        select(StockItemMovement.item_id, func.sum(StockItemMovement.delta_reserved))
        .where(StockItemMovement.project_line_id == line_id)
        .group_by(StockItemMovement.item_id)
    )
    return {item_id: int(n) for item_id, n in rows.all() if n}


async def lock_line(db: AsyncSession, line: ProjectLine) -> None:
    """The line row, locked and read fresh before any door reads what it holds
    (final review M3): two transactions releasing one line — two PATCHes, a
    cancel beside a delete — would both read the same holding and hand it back
    twice. Pending changes to the line are flushed first, so the fresh read
    (``populate_existing``) keeps them."""
    await db.flush()
    await take_write_lock(db, ProjectLine.__table__, line.id)
    await db.execute(
        select(ProjectLine).where(ProjectLine.id == line.id).with_for_update().execution_options(populate_existing=True)
    )


async def lock_positions_for_lines(db: AsyncSession, line_ids: Iterable[int]) -> None:
    """Every position these lines hold, locked in ascending id order before any
    line is handled (final review M4): two orders closing at once over shared
    positions must not lock them in opposite orders — a deadlock on PostgreSQL."""
    ids = sorted(set(line_ids))
    if not ids:
        return
    item_ids = (
        await db.execute(
            select(StockItemMovement.item_id)
            .where(StockItemMovement.project_line_id.in_(ids))
            .group_by(StockItemMovement.item_id)
            .having(func.sum(StockItemMovement.delta_reserved) != 0)
        )
    ).scalars()
    for item_id in sorted(item_ids):
        await lock_item(db, item_id)


async def release_for_line(db: AsyncSession, line: ProjectLine, *, actor: User | None = None) -> int:
    """What the line still holds goes back to the shelf (order cancelled, line or
    order deleted, a reservation rewritten). Read off the ledger, so it finds the
    old position after a configuration change as well. Returns the units released."""
    await lock_line(db, line)
    back = 0
    for item_id, held in sorted((await held_by_item(db, line.id)).items()):
        item = await lock_item(db, item_id)
        await _record(db, item, "release", 0, -held, note=None, actor=actor, line=line, d_line=-held)
        back += held
    return back


async def reserve_for_line(db: AsyncSession, line: ProjectLine, units: int, *, actor: User | None = None) -> int:
    """Rewrite the line's ready units (spec rule 4) — ``units`` is the line's TOTAL,
    issued ones included (rule 1): release what it holds, then take on top of what
    it already issued, ``min(units − issued, quantity − issued, free)`` in the
    position of the line's configuration. A reactivated order's line therefore
    never takes more for asking for fewer (final review I2), and never gives back
    what shipped. A parts line, a product outside the catalogue or a configuration
    without a position take nothing. Returns the units taken."""
    if units < 0:
        raise ValueError(f"cannot reserve {units} units for line {line.id}; a reservation is never negative")
    await release_for_line(db, line, actor=actor)
    issued = line.from_finished  # what is left after the release is what shipped
    if line.mode != "product" or units <= issued:
        return 0
    origin = await db.scalar(select(Product.origin).where(Product.id == line.product_id))
    if origin != ProductOrigin.CATALOG.value:
        return 0
    found = await position_for_key(db, line.product_id, line.config_key)
    if found is None:
        return 0
    item = await lock_item(db, found.id)
    take = min(units - issued, line.quantity - issued, item.on_hand - item.reserved)
    if take <= 0:
        return 0
    await _record(db, item, "reserve", 0, take, note=None, actor=actor, line=line, d_line=take)
    return take


async def issue_for_line(
    db: AsyncSession, line: ProjectLine, *, customer_id: int | None, actor: User | None = None
) -> int:
    """The order completed: everything the line holds leaves with it, to its
    customer (spec rule 8). ``from_finished`` stays — the units were the line's."""
    await lock_line(db, line)
    out = 0
    for item_id, held in sorted((await held_by_item(db, line.id)).items()):
        item = await lock_item(db, item_id)
        await _record(db, item, "issue", -held, -held, note=None, customer_id=customer_id, actor=actor, line=line)
        out += held
    return out


async def move_for_line(db: AsyncSession, line: ProjectLine, *, actor: User | None = None) -> tuple[int, int]:
    """The line's configuration changed (``line.config_key`` is already the new
    one): give back in the old position, take in the new one what it has.
    Returns ``(held before, held after)``; the release reads the ledger, so it
    needs no old key."""
    await lock_line(db, line)
    before = await held_for_line(db, line.id)
    if before == 0:
        return 0, 0
    # The line's total: what it issued (a reactivated order) plus what it holds.
    return before, await reserve_for_line(db, line, line.from_finished, actor=actor)


# ---------- an order line's units on the shelf (spec workshop-order-issue, rules 5, 7, 8) ----------


def moved(line: ProjectLine) -> bool:
    """Has the line's stock moved — anything assembled, received or issued (spec rule 13)?"""
    return (line.assembled or 0) + (line.received or 0) + (line.issued or 0) > 0


def held_units(line: ProjectLine) -> int:
    """Units on the shelf under the order (spec rule 7) — equal, by construction, to
    Σ ``delta_reserved`` of the line's movements."""
    return (
        (line.from_finished or 0)
        + (line.assembled or 0)
        + (line.received or 0)
        - (line.issued or 0)
        - (line.returned or 0)
    )


async def position_for_line(db: AsyncSession, line: ProjectLine, *, create: bool) -> StockItem | None:
    """The position of the line's configuration. An order line's position may be of ANY
    of its products — a one-off product's printed units go through the shelf like the
    rest; only the manual doors keep stock for catalogue products (WS-09 rule 6)."""
    found = await position_for_key(db, line.product_id, line.config_key)
    if found is not None or not create:
        return found
    config = (await load_line_configs(db, [line.id])).get(line.id, LineConfig())
    return await item_for(db, line.product_id, config.choices, config.counts, create=True, any_origin=True)


async def produce_for_line(db: AsyncSession, line: ProjectLine, units: int, *, actor: User | None = None) -> None:
    """Printed units received onto the shelf under the order (``produced``, rule 5)."""
    _at_least_one(units)
    await lock_line(db, line)
    item = await position_for_line(db, line, create=True)
    await _record(db, item, "produced", units, units, note=None, actor=actor, line=line, counters={"received": units})


async def assemble_for_line(db: AsyncSession, line: ProjectLine, units: int, *, actor: User | None = None) -> None:
    """The line's reserved kits assembled into units for the order (``assembled`` with the
    line): the parts writer turns the kit reservation into a write-off first — a refusal
    there writes nothing here."""
    _at_least_one(units)
    await lock_line(db, line)
    item = await position_for_line(db, line, create=True)
    await part_stock.convert_reserved_kits(
        db, line, units, stock_item_id=item.id, created_by=actor.id if actor is not None else None
    )
    await _record(db, item, "assembled", units, units, note=None, actor=actor, line=line, counters={"assembled": units})


async def issue_from_line(
    db: AsyncSession, line: ProjectLine, units: int, *, stock_issue: StockIssue, actor: User | None = None
) -> None:
    """``units`` of what the line holds handed to the customer under ``stock_issue`` —
    part of it or all (rule 8); from its positions in id order."""
    _at_least_one(units)
    await lock_line(db, line)
    held = held_units(line)
    if units > held:
        raise FinishedStockError(f"Only {held} held for this order")
    left = units
    for item_id, holding in sorted((await held_by_item(db, line.id)).items()):
        if left == 0:
            break
        take = min(left, holding)
        if take <= 0:
            continue
        item = await lock_item(db, item_id)
        await _record(
            db,
            item,
            "issue",
            -take,
            -take,
            note=None,
            customer_id=stock_issue.customer_id,
            actor=actor,
            line=line,
            counters={"issued": take},
            stock_issue_id=stock_issue.id,
        )
        left -= take


async def give_back_for_line(db: AsyncSession, line: ProjectLine, *, actor: User | None = None) -> int:
    """Cancel or delete: everything the line holds becomes free stock (rule 14). A line
    whose stock never moved behaves as in WS-10 — ``from_finished`` comes down, so a
    reactivation (allowed to it, rule 15) does not count what went back; a moved line
    counts it in ``returned`` and keeps its counters as history. Returns the units."""
    await lock_line(db, line)
    if not moved(line):
        return await release_for_line(db, line, actor=actor)
    back = 0
    for item_id, holding in sorted((await held_by_item(db, line.id)).items()):
        if holding <= 0:
            continue
        item = await lock_item(db, item_id)
        await _record(
            db, item, "release", 0, -holding, note=None, actor=actor, line=line, counters={"returned": holding}
        )
        back += holding
    return back


async def take_for_line(db: AsyncSession, line: ProjectLine, units: int, *, actor: User | None = None) -> int:
    """«Взяти зі складу» (rule 17): MORE ready units for the line — never a release first,
    never past its quantity, never more than is free. Returns the units taken."""
    if units <= 0 or line.mode != "product":
        return 0
    await lock_line(db, line)
    found = await position_for_key(db, line.product_id, line.config_key)
    if found is None:
        return 0
    item = await lock_item(db, found.id)
    room = (
        line.quantity - (line.from_finished or 0) - (line.assembled or 0) - (line.received or 0) + (line.returned or 0)
    )
    take = min(units, room, item.on_hand - item.reserved)
    if take <= 0:
        return 0
    await _record(db, item, "reserve", 0, take, note=None, actor=actor, line=line, d_line=take)
    return take


async def free_by_keys(db: AsyncSession, pairs: Iterable[tuple[int, str]]) -> dict[tuple[int, str], StockItem]:
    """The positions of these (product, configuration key) pairs — one statement."""
    wanted = sorted(set(pairs))
    if not wanted:
        return {}
    rows = await db.execute(select(StockItem).where(tuple_(StockItem.product_id, StockItem.config_key).in_(wanted)))
    return {(item.product_id, item.config_key): item for item in rows.scalars()}


async def detach_line(db: AsyncSession, line_id: int) -> None:
    """A deleted line leaves its rows without its id (SQLite runs no FK actions).
    Called after the release, so the rows' reservations already cancel out."""
    await db.execute(
        update(StockItemMovement).where(StockItemMovement.project_line_id == line_id).values(project_line_id=None)
    )


async def detach_project(db: AsyncSession, project_id: int) -> None:
    """A deleted order leaves its rows without its ids."""
    await db.execute(
        update(StockItemMovement)
        .where(StockItemMovement.project_id == project_id)
        .values(project_id=None, project_line_id=None)
    )


async def item_composition(db: AsyncSession, item: StockItem) -> Composition:
    """The position's kit, through the one reader (``line_composition``)."""
    parts = (
        (
            await db.execute(
                select(ProductPart)
                .where(ProductPart.product_id == item.product_id)
                .execution_options(populate_existing=True)
            )
        )
        .scalars()
        .all()
    )
    return (await compositions_for_items(db, [item], {item.product_id: list(parts)}))[item.id]


async def can_assemble_item(db: AsyncSession, item: StockItem) -> int:
    """Whole units of the position's kit the free-parts shelf can make — 0 when a
    printed part of the kit has no shelf at all (the product does not count it)."""
    return part_stock.kits_of(await part_stock.balances(db, item.product_id), await item_composition(db, item))


async def assemble(
    db: AsyncSession, item: StockItem, qty: int, *, note: str | None = None, actor: User | None = None
) -> StockItemMovement:
    """Зібрати з деталей — one transaction for both ledgers (spec rule 10).

    Every printed part of the position's kit leaves the shelf (``per × qty``,
    reason ``assembled``, the position named on the row), then the position grows
    by ``qty``. Purchased parts are not on a shelf and are not written off. More
    than the shelf can make is refused before anything is written.
    """
    _at_least_one(qty)
    locked = await lock_item(db, item.id)
    comp = await item_composition(db, locked)
    kit = counted(comp)
    # The shelf decision spans several parts: lock them all, in id order, before reading.
    await part_stock.lock_parts(db, [part for part, _per in kit])
    most = part_stock.kits_of(await part_stock.balances(db, locked.product_id), comp)
    if qty > most:
        raise FinishedStockError(f"Only {most} can be assembled from the free parts")
    actor_id = actor.id if actor else None
    for part, per in kit:
        await part_stock.move(
            db,
            part_id=part.id,
            delta=-per * qty,
            reason="assembled",
            note=part_stock.NOTE_ASSEMBLED,
            created_by=actor_id,
            stock_item_id=item.id,
        )
    return await _record(db, item, "assembled", qty, 0, note=note, actor=actor)


async def set_params(db: AsyncSession, item: StockItem, fields: Mapping[str, object]) -> None:
    """Комірка й мінімум — the position's parameters, not stock: no movement."""
    locked = await lock_item(db, item.id)
    if "min_qty" in fields:
        minimum = fields["min_qty"]
        if not isinstance(minimum, int) or minimum < 0:
            raise FinishedStockError("Minimum must be 0 or more", 422)
        locked.min_qty = minimum
    if "location" in fields:
        location = fields["location"]
        locked.location = (location.strip() or None) if isinstance(location, str) else None
    await db.flush()


async def delete_for_product(db: AsyncSession, product_id: int) -> None:
    """A deleted product takes its EMPTY positions, their configuration and history
    with it (SQLite runs no FK actions); one that still holds goods or a
    reservation is refused (spec rule 15) — stock is not deleted by a catalogue edit."""
    items = (await db.execute(select(StockItem).where(StockItem.product_id == product_id))).scalars().all()
    if any(item.on_hand or item.reserved for item in items):
        raise FinishedStockError("The product has finished goods in stock")
    ids = [item.id for item in items]
    if not ids:
        return
    await db.execute(delete(StockItemMovement).where(StockItemMovement.item_id.in_(ids)))
    await line_config.forget_items(db, ids)
    await db.execute(delete(StockItem).where(StockItem.id.in_(ids)))


async def detach_customer(db: AsyncSession, customer_id: int) -> None:
    """A deleted customer leaves the issues, not a dangling id — SQLite runs no FK
    actions, and ``customers`` reuses ids, so the next customer would inherit them."""
    await db.execute(
        update(StockItemMovement).where(StockItemMovement.customer_id == customer_id).values(customer_id=None)
    )


async def detach_user(db: AsyncSession, user_id: int) -> None:
    """A deleted user leaves the rows, not a dangling id (SQLite runs no FK actions)."""
    await db.execute(update(StockItemMovement).where(StockItemMovement.created_by == user_id).values(created_by=None))
