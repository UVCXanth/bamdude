"""The Stock tab: the farm-wide shelf and its journal, read-only.

Everything here reads the ledger through ``services/part_stock.py``'s batch
readers — one grouped query per question for the whole page, the pass-6
discipline — and nothing here writes (``inv-stock-ledger-single-writer``).
"""

from typing import Literal, NoReturn

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import and_, exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.app.core.auth import RequirePermission
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.customer import Customer
from backend.app.models.finished_stock import StockItem, StockItemChoice
from backend.app.models.product import Product, ProductPart
from backend.app.models.product_variant import ProductVariantGroup, ProductVariantOption
from backend.app.models.project import Project
from backend.app.models.project_line import ProjectLine
from backend.app.models.user import User
from backend.app.schemas.finished_stock import (
    StockAssembleIn,
    StockItemDetail,
    StockItemOut,
    StockItemParamsIn,
    StockItemsPage,
    StockItemsSummary,
    StockJournalPage,
    StockLookupOut,
    StockMoveIn,
)
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
from backend.app.services import finished_stock, finished_stock_views, line_config, part_stock, stock_journal
from backend.app.services.configuration_views import configuration_out, groups_by_product
from backend.app.services.entity_codes import id_from_query
from backend.app.services.line_composition import (
    LineConfig,
    composition,
    default_options,
    line_composition,
    load_line_configs,
    per_by_line,
    standard_composition,
    standard_per,
)
from backend.app.services.list_paging import (
    SortSpec,
    apply_sql_sort,
    like_contains,
    page_meta,
    resolve_sort,
    slice_page,
    sort_computed,
)
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


# ---------- finished goods (spec workshop-finished-goods, rules 16–21) ----------

_ITEM_SORT = SortSpec(
    sql={
        "product": (func.lower(Product.name), False),
        "code": (StockItem.id, False),
        "location": (func.lower(StockItem.location), True),
        "on_hand": (StockItem.on_hand, False),
        "reserved": (StockItem.reserved, False),
        "available": (StockItem.on_hand - StockItem.reserved, False),
        "min": (StockItem.min_qty, False),
    },
    default="product-asc",
)
_BELOW_MIN = and_(StockItem.min_qty > 0, StockItem.on_hand - StockItem.reserved < StockItem.min_qty)
_TRACKED = or_(StockItem.on_hand > 0, StockItem.reserved > 0, StockItem.min_qty > 0)
_MODES = {"tracked": _TRACKED, "low": _BELOW_MIN, "reserved": StockItem.reserved > 0, "all": None}


def _item_word_matches(word: str):
    """One search word against a position: product name, SKU, location, the
    name of a chosen option, or the position's code."""
    needle = like_contains(word)

    def like(column):
        return column.ilike(needle, escape="\\")

    fields = [
        like(Product.name),
        like(Product.sku),
        like(StockItem.location),
        exists().where(
            StockItemChoice.item_id == StockItem.id,
            ProductVariantOption.id == StockItemChoice.option_id,
            like(ProductVariantOption.name),
        ),
    ]
    if (item_id := id_from_query("stock_item", word)) is not None:
        fields.append(StockItem.id == item_id)
    return or_(*fields)


def _raise(e: Exception) -> NoReturn:
    raise HTTPException(status_code=getattr(e, "status", 409), detail=str(e)) from e


async def _choices_from_options(db: AsyncSession, product_id: int, options: list[int]) -> dict[int, int]:
    """``{group: option}`` for the picked options — a foreign one is 422."""
    if not options:
        return {}
    rows = dict(
        (
            await db.execute(
                select(ProductVariantOption.id, ProductVariantOption.group_id)
                .join(ProductVariantGroup, ProductVariantGroup.id == ProductVariantOption.group_id)
                .where(ProductVariantOption.id.in_(options), ProductVariantGroup.product_id == product_id)
            )
        ).all()
    )
    if any(option_id not in rows for option_id in options):
        raise HTTPException(status_code=422, detail="That option does not belong to this product")
    return {rows[option_id]: option_id for option_id in options}


def _parse_options(options: str | None) -> list[int]:
    try:
        return [int(item) for item in (options or "").split(",") if item.strip()]
    except ValueError as e:
        raise HTTPException(status_code=422, detail="Options and counts must be numbers") from e


async def _item_or_404(db: AsyncSession, item_id: int) -> StockItem:
    item = await db.get(StockItem, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Stock position not found")
    return item


async def _resolve_item(
    db: AsyncSession, *, item_id: int | None, product_id: int | None, options: list[int], create: bool
) -> StockItem:
    if item_id is not None:
        return await _item_or_404(db, item_id)
    if product_id is None:
        raise HTTPException(status_code=422, detail="Name a stock position or a product")
    choices = await _choices_from_options(db, product_id, options)
    try:
        item = await finished_stock.item_for(db, product_id, choices, create=create)
    except finished_stock.FinishedStockError as e:
        _raise(e)
    if item is None:
        raise HTTPException(status_code=404, detail="Stock position not found")
    return item


async def _fresh_out(db: AsyncSession, item: StockItem) -> StockItemOut:
    await db.flush()
    await db.refresh(item)
    return (await finished_stock_views.items_out(db, [item]))[0]


@router.get("/items", response_model=StockItemsPage)
async def list_stock_items(
    mode: Literal["tracked", "low", "reserved", "all"] = Query("tracked"),
    q: str | None = Query(None, max_length=200),
    product_id: int | None = Query(None),
    sort_by: str | None = Query(None, description="'<key>-<asc|desc>'; unknown → product-asc"),
    page: int = Query(1, ge=1),
    per_page: int = Query(24, ge=1, le=200),
    all: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_READ),
):
    """The finished-goods positions — filtered, searched, sorted and paged in SQL."""
    query = select(StockItem).join(Product, Product.id == StockItem.product_id)
    if _MODES[mode] is not None:
        query = query.where(_MODES[mode])
    if product_id is not None:
        query = query.where(StockItem.product_id == product_id)
    for word in (q or "").split():
        query = query.where(_item_word_matches(word))
    total = await db.scalar(select(func.count()).select_from(query.subquery())) or 0
    key, direction, _computed = resolve_sort(_ITEM_SORT, sort_by)
    query = apply_sql_sort(query, _ITEM_SORT, key, direction, StockItem.id)
    if not all:
        query = query.limit(per_page).offset((page - 1) * per_page)
    items = (await db.execute(query)).scalars().all()
    return StockItemsPage(
        items=await finished_stock_views.items_out(db, items), meta=page_meta(total, page, per_page, all)
    )


@router.get("/items/summary", response_model=StockItemsSummary)
async def stock_items_summary(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_READ),
):
    """The finished-goods tiles — the whole farm, never the list's filters."""
    on_hand, reserved = (
        await db.execute(
            select(func.coalesce(func.sum(StockItem.on_hand), 0), func.coalesce(func.sum(StockItem.reserved), 0))
        )
    ).one()
    tracked = await db.scalar(select(func.count(StockItem.id)).where(_TRACKED)) or 0
    low = await db.scalar(select(func.count(StockItem.id)).where(_BELOW_MIN)) or 0
    return StockItemsSummary(
        on_hand=int(on_hand),
        reserved=int(reserved),
        available=int(on_hand) - int(reserved),
        tracked=tracked,
        below_min=low,
    )


@router.get("/items/lookup", response_model=StockLookupOut)
async def lookup_stock_item(
    product_id: int = Query(...),
    options: str | None = Query(
        None, description="Chosen option ids, comma-separated; other groups take their standard"
    ),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_READ),
):
    """What a dialog shows for a product and its options before anything moves."""
    choices = await _choices_from_options(db, product_id, _parse_options(options))
    try:
        item = await finished_stock.item_for(db, product_id, choices, create=False)
    except finished_stock.FinishedStockError as e:
        _raise(e)
    if item is not None:
        row = (await finished_stock_views.items_out(db, [item]))[0]
        return StockLookupOut(item=row, configuration=row.configuration, can_assemble=row.can_assemble)
    try:
        _key, new_choices, new_counts = await line_config.resolve(db, product_id, choices, {})
    except line_config.LineConfigError as e:
        _raise(e)
    parts = (await db.execute(select(ProductPart).where(ProductPart.product_id == product_id))).scalars().all()
    groups = (await groups_by_product(db, [product_id])).get(product_id, [])
    defaults = (await default_options(db, [product_id])).get(product_id, {})
    kit = composition(list(parts), "product", set({**defaults, **new_choices}.values()), new_counts)
    return StockLookupOut(
        item=None,
        configuration=configuration_out(groups, list(parts), LineConfig(new_choices, new_counts), defaults),
        can_assemble=part_stock.kits_of(await part_stock.balances(db, product_id), kit),
    )


@router.get("/journal", response_model=StockJournalPage)
async def get_stock_journal(
    book: Literal["both", "finished", "parts"] = Query("both"),
    product_id: int | None = Query(None),
    item_id: int | None = Query(None),
    kind: str | None = Query(None, max_length=32),
    cursor: str | None = Query(None, max_length=100),
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_READ),
):
    """Both stock ledgers as one feed, newest first, one keyset page at a time."""
    try:
        return await stock_journal.journal(
            db, book=book, product_id=product_id, item_id=item_id, kind=kind, cursor=cursor, limit=limit
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail="Unreadable journal cursor") from e


@router.get("/items/{item_id}", response_model=StockItemDetail)
async def get_stock_item(
    item_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_READ),
):
    return await finished_stock_views.item_detail(db, await _item_or_404(db, item_id))


@router.patch("/items/{item_id}", response_model=StockItemOut)
async def update_stock_item(
    item_id: int,
    data: StockItemParamsIn,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_UPDATE),
):
    """Комірка й мінімум — parameters of the position, not stock."""
    item = await _item_or_404(db, item_id)
    try:
        await finished_stock.set_params(db, item, {k: getattr(data, k) for k in data.model_fields_set})
    except finished_stock.FinishedStockError as e:
        _raise(e)
    return await _fresh_out(db, item)


@router.post("/moves", response_model=StockItemOut)
async def move_stock(
    data: StockMoveIn,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermission(Permission.PROJECTS_UPDATE),
):
    """One movement of a position: receipt, stocktake, reserve, release or issue."""
    item = await _resolve_item(
        db,
        item_id=data.item_id,
        product_id=data.product_id,
        options=data.options,
        create=data.kind in ("receipt", "stocktake"),
    )
    if data.customer_id is not None and await db.get(Customer, data.customer_id) is None:
        raise HTTPException(status_code=404, detail="Customer not found")
    qty = data.qty if data.qty is not None else 0
    try:
        if data.kind == "receipt":
            await finished_stock.receive(db, item, qty, note=data.note, actor=current_user)
        elif data.kind == "stocktake":
            counted = data.counted if data.counted is not None else -1
            await finished_stock.stocktake(db, item, counted, note=data.note, actor=current_user)
        elif data.kind == "reserve":
            await finished_stock.reserve(db, item, qty, note=data.note, actor=current_user)
        elif data.kind == "release":
            await finished_stock.release(db, item, qty, note=data.note, actor=current_user)
        else:
            await finished_stock.issue(
                db,
                item,
                qty,
                from_reserve=data.from_reserve,
                customer_id=data.customer_id,
                note=data.note,
                actor=current_user,
            )
    except finished_stock.FinishedStockError as e:
        _raise(e)
    return await _fresh_out(db, item)


@router.post("/assemble", response_model=StockItemOut)
async def assemble_stock(
    data: StockAssembleIn,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermission(Permission.PROJECTS_UPDATE),
):
    """Зібрати з деталей — the kit's parts leave the shelf, the position grows."""
    item = await _resolve_item(db, item_id=data.item_id, product_id=data.product_id, options=data.options, create=True)
    try:
        await finished_stock.assemble(db, item, data.qty, note=data.note, actor=current_user)
    except (finished_stock.FinishedStockError, part_stock.PartStockError) as e:
        _raise(e)
    return await _fresh_out(db, item)
