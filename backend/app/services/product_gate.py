"""The product gate and the NOWAIT footprints (WS-13 E1, spec BL1 / BL2 / BL5).

**The gate** is the product row, ``FOR NO KEY UPDATE`` on PostgreSQL and SQLite's
write lock taken before the first read (``take_write_lock``). Every door that writes
a product's configurations — its variant groups, a part's binding, a line's or a
position's choices — or creates a stock position of it takes the gate FIRST, before
any order row, position, line or part (spec BL0). All such writers of one product are
therefore serialised, and each reads the configuration fresh behind the gate (BL4).
``NO KEY UPDATE`` and not ``FOR UPDATE``: gates collide with each other and with an
UPDATE/DELETE of the product, not with the FK checks of inserts that merely reference
it, which therefore never queue behind a gate.

**Preconditions** (BL2) are checked before any SQL of a NEW entry and are not
diagnostics: a dirty ORM session (autoflush would write before the gate), a gate
after a lock of class ≥ 3, or a new id below one already held raise
:class:`GateOrderError` in every process — continuing would void the protocol. A
re-entry for ids already held does nothing at all.

**NOWAIT footprints** (BL5): a writer of product configurations never waits after
its gate. Everything it will change or delete that another transaction may hold is
taken with ``FOR UPDATE NOWAIT``; a held row answers :class:`ProductBusy` (SQLSTATE
55P03, matched by code — SQLAlchemy wraps the driver's exception). On SQLite the gate
is already the global write lock, and these calls are no-ops.
"""

from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy import Table, select
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.database import LOCK_NOT_AVAILABLE, sqlstate, take_write_lock
from backend.app.core.lock_ledger import ORDER, PRODUCT, GateOrderError, ledger
from backend.app.models.product import Product

PRODUCT_BUSY = "Orders or stock of this product are being changed right now — try again"

_CHUNK = 500


class ProductBusy(Exception):
    """A row of a NOWAIT footprint is held by another transaction (spec BL5)."""

    def __init__(self, table: str) -> None:
        super().__init__(PRODUCT_BUSY)
        self.table = table


async def product_gate(db: AsyncSession, product_ids: Iterable[int]) -> None:
    """Take the gates of ``product_ids``, ascending — or nothing, when all are held."""
    ids = sorted({int(pid) for pid in product_ids})
    held = ledger(db)
    # A product INSERTed by this very transaction is nobody else's to wait on.
    new = [pid for pid in ids if pid not in held.gates and ("products", pid) not in held.created_rows]
    if not new:
        return
    if db.new or db.dirty or db.deleted:
        raise GateOrderError("product gate: the session has unflushed changes — take the gate before writing")
    if held.lock_class >= ORDER:
        raise GateOrderError(f"product gate: a class-{held.lock_class} lock is already held — the gate comes first")
    if held.gates and new[0] < max(held.gates):
        raise GateOrderError(f"product gate: product {new[0]} is below a gate already held — gates go ascending")
    for pid in new:
        await take_write_lock(db, Product.__table__, pid)
        await db.execute(select(Product.id).where(Product.id == pid).with_for_update(key_share=True))
        held.gates.add(pid)
        held.note("products", pid, PRODUCT)


def _sqlite(db: AsyncSession) -> bool:
    return db.get_bind().dialect.name == "sqlite"


async def lock_nowait(db: AsyncSession, table: Table, ids: Iterable[int]) -> None:
    """``FOR UPDATE NOWAIT`` on these rows of ``table`` (keyed by ``id``)."""
    ids = sorted({int(i) for i in ids})
    if not ids or _sqlite(db):
        return
    for start in range(0, len(ids), _CHUNK):
        chunk = ids[start : start + _CHUNK]
        await _nowait(db, table, select(table.c.id).where(table.c.id.in_(chunk)))
    held = ledger(db)
    held.locked_rows.update((table.name, i) for i in ids)


async def lock_nowait_where(db: AsyncSession, table: Table, *conditions) -> None:
    """``FOR UPDATE NOWAIT`` on the rows of ``table`` matching ``conditions`` — for
    tables without an ``id`` key (pivots) and for "every row of this part"."""
    if _sqlite(db):
        return
    await _nowait(db, table, select(*table.primary_key.columns).where(*conditions))


async def _nowait(db: AsyncSession, table: Table, statement) -> None:
    try:
        await db.execute(statement.with_for_update(nowait=True))
    except DBAPIError as e:
        if sqlstate(e) == LOCK_NOT_AVAILABLE:
            raise ProductBusy(table.name) from e
        raise


# ---------- the footprints of spec BL5, one per kind of product edit ----------


async def lock_configurations(db: AsyncSession, product_id: int) -> None:
    """Adding a variant group, rebinding a part: every position of the product, every
    ``product`` line of it (any order status) and every part of it — rewriting their
    configurations inserts count rows whose FK checks take KEY SHARE on the parts,
    which a parts-ledger door holds FOR UPDATE."""
    from backend.app.models.finished_stock import StockItem
    from backend.app.models.product import ProductPart
    from backend.app.models.project_line import ProjectLine

    await lock_nowait(
        db, StockItem.__table__, (await db.scalars(select(StockItem.id).where(StockItem.product_id == product_id)))
    )
    await lock_nowait(
        db,
        ProjectLine.__table__,
        await db.scalars(
            select(ProjectLine.id).where(ProjectLine.product_id == product_id, ProjectLine.mode == "product")
        ),
    )
    await lock_nowait(
        db, ProductPart.__table__, await db.scalars(select(ProductPart.id).where(ProductPart.product_id == product_id))
    )


async def lock_part_edit(db: AsyncSession, product_id: int, part_ids: Iterable[int]) -> None:
    """Deleting or merging parts: the positions and lines — of BOTH modes — that count
    these parts, every part of the product, the parts' procurement rows, their ledger
    movements (deleted or repointed) and their parts-line counters."""
    from backend.app.models.finished_stock import StockItem, StockItemPartCount
    from backend.app.models.line_config import ProjectLinePartCount
    from backend.app.models.part_stock import ProductPartStockMovement
    from backend.app.models.product import ProductPart
    from backend.app.models.project_line import ProjectLine, ProjectLinePartStock, ProjectProcurement

    ids = sorted({int(i) for i in part_ids})
    if not ids:
        return
    await lock_nowait(
        db,
        StockItem.__table__,
        await db.scalars(select(StockItemPartCount.item_id).where(StockItemPartCount.part_id.in_(ids))),
    )
    line_ids = set(await db.scalars(select(ProjectLinePartCount.line_id).where(ProjectLinePartCount.part_id.in_(ids))))
    line_ids |= set(await db.scalars(select(ProjectLinePartStock.line_id).where(ProjectLinePartStock.part_id.in_(ids))))
    await lock_nowait(db, ProjectLine.__table__, line_ids)
    await lock_nowait(
        db, ProductPart.__table__, await db.scalars(select(ProductPart.id).where(ProductPart.product_id == product_id))
    )
    await lock_nowait_where(db, ProjectProcurement.__table__, ProjectProcurement.product_part_id.in_(ids))
    await lock_nowait_where(db, ProductPartStockMovement.__table__, ProductPartStockMovement.product_part_id.in_(ids))
    await lock_nowait_where(db, ProjectLinePartStock.__table__, ProjectLinePartStock.part_id.in_(ids))


async def lock_product_delete(db: AsyncSession, product_id: int) -> None:
    """Deleting a product: its positions and their movements, its parts with their
    movements, parts-line counters and procurement rows, its plates, file and folder
    links and facets — and last the product row itself, ``FOR UPDATE NOWAIT`` (the
    gate's own mode upgraded without waiting: inserts referencing the product hold
    KEY SHARE, which a DELETE must not wait behind)."""
    from backend.app.models.finished_stock import StockItem, StockItemMovement
    from backend.app.models.part_stock import ProductPartStockMovement
    from backend.app.models.product import ProductFacet, ProductPart, ProductPlate, product_files, product_folders
    from backend.app.models.project_line import ProjectLinePartStock, ProjectProcurement

    item_ids = list(await db.scalars(select(StockItem.id).where(StockItem.product_id == product_id)))
    await lock_nowait(db, StockItem.__table__, item_ids)
    if item_ids:
        await lock_nowait_where(db, StockItemMovement.__table__, StockItemMovement.item_id.in_(item_ids))
    part_ids = list(await db.scalars(select(ProductPart.id).where(ProductPart.product_id == product_id)))
    await lock_nowait(db, ProductPart.__table__, part_ids)
    if part_ids:
        await lock_nowait_where(
            db, ProductPartStockMovement.__table__, ProductPartStockMovement.product_part_id.in_(part_ids)
        )
        await lock_nowait_where(db, ProjectLinePartStock.__table__, ProjectLinePartStock.part_id.in_(part_ids))
        await lock_nowait_where(db, ProjectProcurement.__table__, ProjectProcurement.product_part_id.in_(part_ids))
    await lock_nowait_where(db, ProductPlate.__table__, ProductPlate.product_id == product_id)
    await lock_nowait_where(db, product_files, product_files.c.product_id == product_id)
    await lock_nowait_where(db, product_folders, product_folders.c.product_id == product_id)
    await lock_nowait_where(db, ProductFacet.__table__, ProductFacet.product_id == product_id)
    await lock_nowait_where(db, Product.__table__, Product.id == product_id)
