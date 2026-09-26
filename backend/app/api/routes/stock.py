"""The Stock tab: the farm-wide shelf and its journal, read-only.

Everything here reads the ledger through ``services/part_stock.py``'s batch
readers — one grouped query per question for the whole page, the pass-6
discipline — and nothing here writes (``inv-stock-ledger-single-writer``).
"""

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.app.core.auth import RequirePermission
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.product import Product
from backend.app.models.project import Project
from backend.app.models.project_line import ProjectLine
from backend.app.models.user import User
from backend.app.schemas.listing import StockFigures, StockListPage
from backend.app.schemas.product import StockBalanceOut
from backend.app.schemas.stock import (
    StockListItem,
    StockMovementRowOut,
    StockMovementsPageOut,
    StockProductOut,
    StockReason,
    StockReservationOut,
    StockSummaryOut,
)
from backend.app.services import part_stock
from backend.app.services.line_composition import (
    default_options,
    line_composition,
    load_line_configs,
    per_by_line,
    standard_composition,
    standard_per,
)
from backend.app.services.list_paging import SortSpec, page_meta, resolve_sort, slice_page, sort_computed
from backend.app.services.stock_views import movement_out, orders_of_lines

router = APIRouter(prefix="/stock", tags=["stock"])

# All three keys are computed: the ``with_stock`` filter needs the balances, so
# the set is built in Python whole before it can be sorted or cut (spec
# workshop-lists, rule 9). ``kits-desc`` is the flat answer's own order.
_STOCK_SORT = SortSpec(sql={}, computed={"kits", "name", "reserved"}, default="kits-desc")
_STOCK_KEYS = {
    "kits": lambda r: r.kits_available,
    "name": lambda r: r.name.lower(),
    "reserved": lambda r: r.reserved_kits,
}


async def _stock_rows(db: AsyncSession, *, q: str | None, with_stock: bool) -> list[StockProductOut]:
    """Every product with a shelf: its kits, its counted parts' balances, and
    the ACTIVE orders' lines holding its kits in reserve — kits descending,
    then name. The flat answer's rows, and the source of the paged list and
    the tiles alike, so a tile and the table cannot disagree.

    ``with_stock`` keeps a product only while its shelf holds anything — a
    counted part above zero, or a live reservation: kits out on loan are still
    the shelf's business, and a product whose whole stock is reserved reads as
    zero balances with a reservation, never as absent.

    The product select is pre-filtered in SQL to those with at least one
    counted printed part — the EXISTS keeps part-less one-off products (adhoc
    plate products are created with no parts) out of the load.
    """
    stmt = (
        select(Product).options(selectinload(Product.parts)).where(Product.parts.any(part_stock.counted_part_clause()))
    )
    if q and q.strip():
        stmt = stmt.where(Product.name.ilike(f"%{q.strip()}%"))
    products = [p for p in (await db.execute(stmt)).scalars().all() if any(part_stock.is_counted(pt) for pt in p.parts)]
    if not products:
        return []

    ids = [p.id for p in products]
    balances = await part_stock.balances_for_products(db, ids)

    # Reservations: the lines of ACTIVE orders on these products, then ONE
    # ledger read for all of them — the same read the order pages use.
    line_rows = (
        await db.execute(
            select(ProjectLine.id, ProjectLine.product_id, Project.id, Project.name)
            .join(Project, Project.id == ProjectLine.project_id)
            .where(ProjectLine.product_id.in_(ids), Project.status == "active")
        )
    ).all()
    # Each line's reservation is read through ITS composition (spec
    # workshop-product-variants): a line holding angled tails holds no straight.
    defaults = await default_options(db, ids)
    parts_of = {p.id: list(p.parts) for p in products}
    line_objs = (
        (await db.execute(select(ProjectLine).where(ProjectLine.id.in_([row[0] for row in line_rows])))).scalars().all()
        if line_rows
        else []
    )
    configs = await load_line_configs(db, [line.id for line in line_objs])
    compositions = {
        line.id: line_composition(
            parts_of.get(line.product_id, []), line.mode, configs[line.id], defaults.get(line.product_id, {})
        )
        for line in line_objs
    }
    reads = await part_stock.line_ledger_reads(db, [row[0] for row in line_rows], per_by_line(compositions))
    reservations: dict[int, list[StockReservationOut]] = {}
    for line_id, product_id, order_id, order_name in line_rows:
        kits = reads.reserved_units.get(line_id, 0)
        if kits > 0:
            reservations.setdefault(product_id, []).append(
                StockReservationOut(line_id=line_id, order_id=order_id, order_name=order_name, kits=kits)
            )

    out: list[StockProductOut] = []
    for p in products:
        part_balances = balances.get(p.id, {})
        held = sorted(reservations.get(p.id, []), key=lambda r: (-r.kits, r.order_name.lower()))
        if with_stock and not any(v > 0 for v in part_balances.values()) and not held:
            continue
        out.append(
            StockProductOut(
                id=p.id,
                name=p.name,
                is_active=p.is_active,
                origin=p.origin,
                kits_available=part_stock.kits_of(
                    part_balances, standard_composition(list(p.parts), set(defaults.get(p.id, {}).values()))
                ),
                parts=[
                    StockBalanceOut(
                        part_id=pt.id, name=pt.name, qty_per_unit=standard_per(pt), balance=part_balances[pt.id]
                    )
                    for pt in sorted(p.parts, key=lambda pt: (pt.sort_order, pt.id))
                    if pt.id in part_balances
                ],
                reservations=held,
            )
        )
    out.sort(key=lambda row: (-row.kits_available, row.name.lower()))
    return out


@router.get("", response_model=StockSummaryOut | StockListPage)
async def stock_summary(
    q: str | None = Query(None, max_length=200),
    with_stock: bool = Query(True),
    sort_by: str | None = Query(None, description="With page set: '<key>-<asc|desc>'; unknown → kits-desc"),
    page: int | None = Query(None, ge=1, description="Omit entirely for the flat {products} answer"),
    per_page: int = Query(24, ge=1, le=200),
    all: bool = Query(False, description="With page set, skip pagination and return every matching row"),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_READ),
):
    """Every product with a shelf (see ``_stock_rows``). ``page`` is the compat
    switch every list of the section has (spec projects-lists-parity rule 1,
    workshop-lists rule 9): without it the flat ``{products}`` exactly as
    before; with it the envelope, whose rows also carry ``reserved_kits``."""
    rows = await _stock_rows(db, q=q, with_stock=with_stock)
    if page is None:
        return StockSummaryOut(products=rows)
    key, direction, _computed = resolve_sort(_STOCK_SORT, sort_by)
    items = [StockListItem(**row.model_dump(), reserved_kits=sum(r.kits for r in row.reservations)) for row in rows]
    items = sort_computed(items, _STOCK_KEYS[key], direction, id_fn=lambda r: r.id)
    return StockListPage(items=slice_page(items, page, per_page, all), meta=page_meta(len(items), page, per_page, all))


@router.get("/figures", response_model=StockFigures)
async def stock_figures(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_READ),
):
    """The stock page's tiles — the whole shelf, never the list's search or its
    «only with stock» (spec workshop-lists, rules 1, 4). The same rows the list
    reads, so a tile and the table cannot disagree."""
    rows = await _stock_rows(db, q=None, with_stock=False)
    return StockFigures(
        kits=sum(r.kits_available for r in rows),
        kit_products=sum(1 for r in rows if r.kits_available > 0),
        parts=sum(b.balance for r in rows for b in r.parts),
        reserved_kits=sum(res.kits for r in rows for res in r.reservations),
        incomplete=sum(1 for r in rows if r.kits_available == 0 and any(b.balance > 0 for b in r.parts)),
    )


@router.get("/movements", response_model=StockMovementsPageOut)
async def stock_movements(
    product_id: int | None = Query(None),
    part_id: int | None = Query(None),
    reason: StockReason | None = Query(None),
    before_id: int | None = Query(None, ge=1),
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_READ),
):
    """The farm's ledger, newest first, one keyset page at a time.

    ``next_before_id`` is set only when the page came back full — a short page
    IS the end, and the client stops asking. A filter naming nothing yields an
    empty page, not a 404: a journal filter is not a lookup.
    """
    rows = await part_stock.movements_across(
        db,
        product_id=product_id,
        part_id=part_id,
        reason=reason.value if reason is not None else None,
        before_id=before_id,
        limit=limit,
    )
    names = {movement.product_part_id: part_name for movement, part_name, _pid, _pname in rows}
    orders = await orders_of_lines(db, {m.project_line_id for m, *_ in rows if m.project_line_id is not None})
    items = [
        StockMovementRowOut(**movement_out(movement, names, orders).model_dump(), product_id=pid, product_name=pname)
        for movement, _part_name, pid, pname in rows
    ]
    return StockMovementsPageOut(items=items, next_before_id=items[-1].id if len(items) == limit else None)
