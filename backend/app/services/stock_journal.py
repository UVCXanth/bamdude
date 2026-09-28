"""One journal for both stock ledgers — read-only (spec workshop-finished-goods, rule 21).

The finished-goods ledger and the free-parts ledger are two tables; the
Stock page reads them as one feed, newest first, one keyset page at a time.
The order is ``(created_at, book, id)`` descending — a finished row above a
parts row written in the same instant — and the cursor is that triple of the
last row, so a page boundary between rows of the same timestamp neither loses
nor repeats one.

⚠️ The timestamp is compared at its full MICROSECOND precision, in SQL and in
Python alike, and the cursor carries all six digits. An earlier version
truncated to the millisecond — and SQLite's ``strftime('%f')`` ROUNDS where
Python truncates, so a page ending on ``.123900`` lost the ``.123789`` row
behind it (final review of WS-09). On SQLite a datetime is a string: the
parts ledger still holds rows from before its clock moved to Python (the
server default ``YYYY-MM-DD HH:MM:SS``, no fraction) beside rows with six
digits, so its column is padded to one format before it is compared; the
finished ledger is written by its one writer only, always with six digits,
and is compared as it is. On PostgreSQL both are real timestamps, compared
as they are — which lets the ``(created_at, id)`` indexes serve the order.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import String, and_, case, func, literal, or_, select, type_coerce
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.customer import Customer
from backend.app.models.finished_stock import StockItem, StockItemMovement
from backend.app.models.part_stock import ProductPartStockMovement
from backend.app.models.product import Product, ProductPart
from backend.app.models.project import Project
from backend.app.models.user import User
from backend.app.schemas.finished_stock import (
    StockJournalCustomer,
    StockJournalIssue,
    StockJournalItemRef,
    StockJournalOrder,
    StockJournalPage,
    StockJournalRow,
    StockJournalUser,
)
from backend.app.services.entity_codes import code_for
from backend.app.services.finished_stock_views import configuration_refs
from backend.app.services.stock_views import orders_of_lines

FINISHED, PARTS = "finished", "parts"
_RANK = {FINISHED: 1, PARTS: 0}


_SQLITE_FORMAT = "%Y-%m-%d %H:%M:%S.%f"


def _sql_ts(column, sqlite: bool, legacy: bool):
    """The column as the keyset compares it: a SQLite string padded to six digits
    when the table can hold legacy rows without a fraction, else the column."""
    if sqlite and legacy:
        text = type_coerce(column, String)
        return case((func.length(text) == 19, text + ".000000"), else_=text)
    return column


def _bind_ts(dt: datetime, sqlite: bool):
    """The cursor's timestamp in the same shape as :func:`_sql_ts`."""
    return literal(dt.strftime(_SQLITE_FORMAT)) if sqlite else literal(dt)


def _issue_ref(issue_id: int | None) -> StockJournalIssue | None:
    """The dispatch note an issue movement belongs to (spec workshop-dispatch-notes, rule 16)."""
    return StockJournalIssue(id=issue_id, code=code_for("dispatch_note", issue_id)) if issue_id else None


def encode_cursor(created_at: datetime, book: str, row_id: int) -> str:
    return f"{created_at.isoformat(timespec='microseconds')}|{book}|{row_id}"


def decode_cursor(cursor: str) -> tuple[datetime, str, int]:
    stamp, book, row_id = cursor.split("|")
    if book not in _RANK:
        raise ValueError(cursor)
    return datetime.fromisoformat(stamp), book, int(row_id)


def _older_than(ts_sql, id_col, rank: int, cursor, sqlite: bool):
    """``(ts, rank, id) < cursor`` lexicographically, for a table of one fixed rank."""
    ct, cbook, cid = cursor
    crank = _RANK[cbook]
    bound = _bind_ts(ct, sqlite)
    same_instant = ts_sql == bound
    if rank < crank:
        tie = same_instant
    elif rank == crank:
        tie = and_(same_instant, id_col < cid)
    else:
        tie = literal(False)
    return or_(ts_sql < bound, tie)


@dataclass
class _Row:
    book: str
    key: tuple
    movement: object
    extra: tuple


async def journal(
    db: AsyncSession,
    *,
    book: str = "both",
    product_id: int | None = None,
    item_id: int | None = None,
    kind: str | None = None,
    cursor: str | None = None,
    limit: int = 50,
) -> StockJournalPage:
    sqlite = db.get_bind().dialect.name == "sqlite"
    position = decode_cursor(cursor) if cursor else None
    rows: list[_Row] = []

    if book in ("both", FINISHED):
        ts = _sql_ts(StockItemMovement.created_at, sqlite, legacy=False)
        q = select(StockItemMovement, StockItem.product_id).join(StockItem, StockItem.id == StockItemMovement.item_id)
        if product_id is not None:
            q = q.where(StockItem.product_id == product_id)
        if item_id is not None:
            q = q.where(StockItemMovement.item_id == item_id)
        if kind:
            q = q.where(StockItemMovement.kind == kind)
        if position:
            q = q.where(_older_than(ts, StockItemMovement.id, _RANK[FINISHED], position, sqlite))
        q = q.order_by(ts.desc(), StockItemMovement.id.desc()).limit(limit)
        for move, pid in (await db.execute(q)).all():
            rows.append(_Row(FINISHED, (move.created_at, _RANK[FINISHED], move.id), move, (pid,)))

    if book in ("both", PARTS):
        ts = _sql_ts(ProductPartStockMovement.created_at, sqlite, legacy=True)
        q = select(ProductPartStockMovement, ProductPart.name, ProductPart.product_id).join(
            ProductPart, ProductPart.id == ProductPartStockMovement.product_part_id
        )
        if product_id is not None:
            q = q.where(ProductPart.product_id == product_id)
        if item_id is not None:
            q = q.where(ProductPartStockMovement.stock_item_id == item_id)
        if kind:
            q = q.where(ProductPartStockMovement.reason == kind)
        if position:
            q = q.where(_older_than(ts, ProductPartStockMovement.id, _RANK[PARTS], position, sqlite))
        q = q.order_by(ts.desc(), ProductPartStockMovement.id.desc()).limit(limit)
        for move, part_name, pid in (await db.execute(q)).all():
            rows.append(_Row(PARTS, (move.created_at, _RANK[PARTS], move.id), move, (pid, part_name)))

    rows.sort(key=lambda r: r.key, reverse=True)
    rows = rows[:limit]

    # Names — one read per kind of name, whatever the page.
    product_ids = {r.extra[0] for r in rows}
    products = (
        dict((await db.execute(select(Product.id, Product.name).where(Product.id.in_(product_ids)))).all())
        if product_ids
        else {}
    )
    item_ids = {r.movement.item_id for r in rows if r.book == FINISHED} | {
        r.movement.stock_item_id for r in rows if r.book == PARTS and r.movement.stock_item_id
    }
    items = (await db.execute(select(StockItem).where(StockItem.id.in_(item_ids)))).scalars().all() if item_ids else []
    refs = await configuration_refs(db, items)
    user_ids = {r.movement.created_by for r in rows if r.movement.created_by}
    users = (
        dict((await db.execute(select(User.id, User.username).where(User.id.in_(user_ids)))).all()) if user_ids else {}
    )
    customer_ids = {r.movement.customer_id for r in rows if r.book == FINISHED and r.movement.customer_id}
    customers = (
        dict((await db.execute(select(Customer.id, Customer.name).where(Customer.id.in_(customer_ids)))).all())
        if customer_ids
        else {}
    )
    project_ids = {r.movement.project_id for r in rows if r.book == FINISHED and r.movement.project_id}
    projects = (
        dict((await db.execute(select(Project.id, Project.name).where(Project.id.in_(project_ids)))).all())
        if project_ids
        else {}
    )
    orders = await orders_of_lines(
        db, {r.movement.project_line_id for r in rows if r.book == PARTS and r.movement.project_line_id}
    )

    def item_ref(item_ref_id):
        if item_ref_id not in refs:
            return None
        code, configuration = refs[item_ref_id]
        return StockJournalItemRef(id=item_ref_id, code=code, configuration=configuration)

    out: list[StockJournalRow] = []
    for r in rows:
        m = r.movement
        user = StockJournalUser(id=m.created_by, username=users[m.created_by]) if m.created_by in users else None
        if r.book == FINISHED:
            project = (
                StockJournalOrder(
                    id=m.project_id, code=code_for("order", m.project_id), name=projects.get(m.project_id)
                )
                if m.project_id
                else None
            )
            out.append(
                StockJournalRow(
                    book=FINISHED,
                    id=m.id,
                    created_at=m.created_at,
                    product_id=r.extra[0],
                    product_name=products.get(r.extra[0]),
                    item=item_ref(m.item_id),
                    kind=m.kind,
                    delta_on_hand=m.delta_on_hand,
                    delta_reserved=m.delta_reserved,
                    note=m.note,
                    customer=StockJournalCustomer(id=m.customer_id, name=customers[m.customer_id])
                    if m.customer_id in customers
                    else None,
                    project=project,
                    issue=_issue_ref(m.stock_issue_id),
                    user=user,
                )
            )
        else:
            order = orders.get(m.project_line_id) if m.project_line_id else None
            out.append(
                StockJournalRow(
                    book=PARTS,
                    id=m.id,
                    created_at=m.created_at,
                    product_id=r.extra[0],
                    product_name=products.get(r.extra[0]),
                    item=item_ref(m.stock_item_id) if m.stock_item_id else None,
                    part_name=r.extra[1],
                    kind=m.reason,
                    delta=m.delta,
                    note=m.note,
                    project=StockJournalOrder(id=order[0], code=code_for("order", order[0]), name=order[1])
                    if order
                    else None,
                    issue=_issue_ref(m.stock_issue_id),
                    user=user,
                )
            )
    next_cursor = (
        encode_cursor(rows[-1].movement.created_at, rows[-1].book, rows[-1].movement.id) if len(rows) == limit else None
    )
    return StockJournalPage(items=out, next_cursor=next_cursor)
