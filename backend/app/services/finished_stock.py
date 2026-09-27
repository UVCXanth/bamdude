"""Finished goods — the ONE writer (spec workshop-finished-goods, rules 7–13).

Writes ``stock_items`` (the ``on_hand`` / ``reserved`` columns, the location and
the minimum) and ``stock_item_movements``; nothing else does
(``tests/unit/test_finished_stock_has_one_writer.py``). Every operation locks
the position row, decides against what it read under the lock, writes ONE
movement and moves the columns by the same deltas in the caller's transaction —
so the columns always equal the sum of the ledger. The columns are what lists,
filters and sorts read; the ledger is the history.

Never commits; never writes a zero movement. A position's configuration is
``line_config``'s to write, and its kit is ``line_composition``'s to read.
Refusals are :class:`FinishedStockError` — an English sentence the route
forwards verbatim (translated at the boundary) with its HTTP status.
"""

from __future__ import annotations

from collections.abc import Mapping

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.finished_stock import MOVEMENT_KINDS, StockItem, StockItemMovement
from backend.app.models.product import Product, ProductOrigin, ProductPart
from backend.app.models.user import User
from backend.app.services import line_config, part_stock
from backend.app.services.line_composition import Composition, compositions_for_items, counted


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
    return (await db.execute(lock_item_stmt(item_id))).scalar_one_or_none()


async def item_for(
    db: AsyncSession,
    product_id: int,
    choices: Mapping[int, int],
    counts: Mapping[int, int] | None = None,
    *,
    create: bool,
) -> StockItem | None:
    """The position of this product configuration — found by its key, or created
    when ``create`` (spec rule 9). Only catalogue products are kept (rule 6)."""
    origin = await db.scalar(select(Product.origin).where(Product.id == product_id))
    if origin is None:
        raise FinishedStockError("Product not found", 404)
    if origin != ProductOrigin.CATALOG.value:
        raise FinishedStockError("Only catalogue products are kept in stock", 422)
    try:
        key, new_choices, new_counts = await line_config.resolve(db, product_id, choices, counts)
    except line_config.LineConfigError as e:
        raise FinishedStockError(str(e), e.status) from e
    item = (
        await db.execute(select(StockItem).where(StockItem.product_id == product_id, StockItem.config_key == key))
    ).scalar_one_or_none()
    if item is not None or not create:
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
) -> StockItemMovement:
    """Write one movement and move the columns by it — the only place both happen."""
    if kind not in MOVEMENT_KINDS:
        raise ValueError(f"unknown finished-goods movement {kind!r}")
    locked = await lock_item(db, item.id)
    on_hand, reserved = locked.on_hand + d_on_hand, locked.reserved + d_reserved
    if on_hand < 0 or reserved < 0 or reserved > on_hand:
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
    )
    db.add(move)
    locked.on_hand, locked.reserved = on_hand, reserved
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
    """The reservation held without an order line — all of it until WS-10 adds line reservations."""
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


async def detach_user(db: AsyncSession, user_id: int) -> None:
    """A deleted user leaves the rows, not a dangling id (SQLite runs no FK actions)."""
    await db.execute(update(StockItemMovement).where(StockItemMovement.created_by == user_id).values(created_by=None))
