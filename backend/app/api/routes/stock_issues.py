"""Issues of goods — since WS-12 each is a dispatch note: the notes' list and document
(spec workshop-dispatch-notes, rules 12–15), and the waybill and the note written afterwards
(spec workshop-order-issue, rule 21). Everything else about an issue is its snapshot and does
not change."""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes._workshop_rights import bind_workshop_credentials, read_required, workshop_view
from backend.app.core.auth import RequireAnyPermission, RequirePermission
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.stock_issue import StockIssue, StockIssueLine
from backend.app.models.user import User
from backend.app.schemas.listing import DispatchNoteOut, StockIssuePage, StockIssueRow, StockIssueUpdate
from backend.app.services import stock_issues
from backend.app.services.entity_codes import id_from_query
from backend.app.services.list_paging import SortSpec, like_contains, page_meta, resolve_sort
from backend.app.services.stock_issue_views import issue_rows, note_out

router = APIRouter(prefix="/stock-issues", tags=["stock"], dependencies=[Depends(bind_workshop_credentials)])

_ISSUE_SORT = SortSpec(
    sql={
        "created": (StockIssue.created_at, False),
        "code": (StockIssue.id, False),
        "customer": (func.lower(StockIssue.customer_name), False),
        "units": (StockIssue.units, False),
    },
    default="created-desc",
)


def _search(q: str, *, sensitive: bool = True):
    """The note's code, the order's, the names and the lines' text (spec workshop-dispatch-notes, rule 12).
    The recipient only for a caller who may see it (WS-13 E13 O25) — a search is an oracle too."""
    needle = like_contains(q)
    columns = [StockIssue.customer_name, StockIssue.waybill, StockIssue.order_code, StockIssue.order_name]
    if sensitive:
        columns.insert(1, StockIssue.recipient_name)
    matches = [column.ilike(needle, escape="\\") for column in columns]
    matches.append(
        exists(
            select(StockIssueLine.id).where(
                StockIssueLine.issue_id == StockIssue.id,
                or_(
                    StockIssueLine.product_name.ilike(needle, escape="\\"),
                    StockIssueLine.sku.ilike(needle, escape="\\"),
                    StockIssueLine.part_name.ilike(needle, escape="\\"),
                ),
            )
        )
    )
    note_id = id_from_query("dispatch_note", q)
    if note_id is not None:
        matches.append(StockIssue.id == note_id)
    order_id = id_from_query("order", q, require_prefix=True)
    if order_id is not None:
        matches.append(StockIssue.project_id == order_id)
    return or_(*matches)


@router.get("/", response_model=StockIssuePage)
async def list_stock_issues(
    q: str | None = Query(
        None, description="DN code, OR code, customer, recipient, waybill, order, product, SKU, part"
    ),
    customer_id: int | None = Query(None),
    project_id: int | None = Query(None),
    sort_by: str | None = Query(None, description="'<created|code|customer|units>-<asc|desc>'; unknown → created-desc"),
    page: int = Query(1, ge=1),
    per_page: int = Query(24, ge=1, le=200),
    all: bool = Query(False, description="Skip pagination and return every matching note"),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequireAnyPermission(Permission.STOCK_READ, Permission.ORDERS_READ, Permission.CUSTOMERS_READ),
):
    """Dispatch notes — the stock page's tab, an order's «Видачі», a customer's issues (rules 12, 20–22).

    Every note is the stock's; an order's notes are its readers' too, a customer's notes the
    customer's readers'. The recipient's block and the note go to whoever keeps the contacts
    or ships (WS-13 E13 O25); anyone else gets minimal rows."""
    view = await workshop_view()
    in_context = view.stock or (project_id is not None and view.orders) or (customer_id is not None and view.customers)
    if not in_context:
        raise read_required("stock")
    query = select(StockIssue)
    if customer_id is not None:
        query = query.where(StockIssue.customer_id == customer_id)
    if project_id is not None:
        query = query.where(StockIssue.project_id == project_id)
    if q and q.strip():
        query = query.where(_search(q.strip(), sensitive=view.recipient))
    total = await db.scalar(select(func.count()).select_from(query.subquery())) or 0
    key, direction, _computed = resolve_sort(_ISSUE_SORT, sort_by)
    column, _nulls_last = _ISSUE_SORT.sql[key]
    # Ties go the key's own way: «newest first» on one timestamp still reads DN-0007 above
    # DN-0006 (final review M6). The id is unique, so pages never overlap either way.
    if direction == "desc":
        query = query.order_by(column.desc(), StockIssue.id.desc())
    else:
        query = query.order_by(column.asc(), StockIssue.id.asc())
    if not all:
        query = query.limit(per_page).offset((page - 1) * per_page)
    issues = (await db.execute(query)).scalars().all()
    rows = await issue_rows(db, issues)
    if not view.recipient:
        rows = [_restricted(row) for row in rows]
    return StockIssuePage(items=rows, meta=page_meta(total, page, per_page, all))


_SENSITIVE = ("recipient_name", "recipient_phone", "delivery_method", "delivery_details", "note")


def _restricted(row):
    return row.model_copy(update={**dict.fromkeys(_SENSITIVE, None), "restricted": True})


@router.get("/{issue_id}", response_model=DispatchNoteOut)
async def get_dispatch_note(
    issue_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequireAnyPermission(Permission.STOCK_READ, Permission.ORDERS_READ, Permission.CUSTOMERS_READ),
):
    """The document, drawn only from its snapshot (rule 14).

    Its reader's context as the list's; the document IS the recipient and the supplier's
    details, so it opens only for whoever keeps the contacts or ships (WS-13 E13 O25) — never
    printed masked as if whole."""
    issue = await db.get(StockIssue, issue_id)
    view = await workshop_view()
    if issue is None:
        # A missing note answers a caller outside the stock as a note out of its reach does —
        # the id tells it nothing (WS-13 E13 O25).
        if not view.stock:
            raise read_required("stock")
        raise HTTPException(status_code=404, detail="Dispatch note not found")
    in_context = (
        view.stock
        or (issue.project_id is not None and view.orders)
        or (issue.customer_id is not None and view.customers)
    )
    if not in_context:
        raise read_required("stock")
    if not view.recipient:
        raise HTTPException(
            status_code=403,
            detail={
                "error": "dispatch_note_restricted",
                "message": "Opening a dispatch note needs the customers' read or the stock's move right",
            },
        )
    return await note_out(db, issue)


@router.patch("/{issue_id}", response_model=StockIssueRow)
async def update_stock_issue(
    issue_id: int,
    data: StockIssueUpdate,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.STOCK_MOVE),
):
    """The waybill number (at most 24 characters) and the note — nothing else."""
    issue = await db.get(StockIssue, issue_id)
    if issue is None:
        raise HTTPException(status_code=404, detail="Issue not found")
    fields = {name: getattr(data, name) for name in data.model_fields_set & {"waybill", "note"}}
    try:
        await stock_issues.update(db, issue, **fields)
    except stock_issues.StockIssueError as e:
        raise HTTPException(status_code=e.status, detail=str(e)) from e
    await db.flush()
    [row] = await issue_rows(db, [issue])
    return row
