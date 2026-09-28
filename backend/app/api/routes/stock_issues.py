"""Issues of goods — since WS-12 each is a dispatch note: the notes' list and document
(spec workshop-dispatch-notes, rules 12–15), and the waybill and the note written afterwards
(spec workshop-order-issue, rule 21). Everything else about an issue is its snapshot and does
not change."""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import RequirePermission
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.stock_issue import StockIssue, StockIssueLine
from backend.app.models.user import User
from backend.app.schemas.listing import DispatchNoteOut, StockIssuePage, StockIssueRow, StockIssueUpdate
from backend.app.services import stock_issues
from backend.app.services.entity_codes import id_from_query
from backend.app.services.list_paging import SortSpec, like_contains, page_meta, resolve_sort
from backend.app.services.stock_issue_views import issue_rows, note_out

router = APIRouter(prefix="/stock-issues", tags=["stock"])

_ISSUE_SORT = SortSpec(
    sql={
        "created": (StockIssue.created_at, False),
        "code": (StockIssue.id, False),
        "customer": (func.lower(StockIssue.customer_name), False),
        "units": (StockIssue.units, False),
    },
    default="created-desc",
)


def _search(q: str):
    """The note's code, the order's, the names and the lines' text (spec workshop-dispatch-notes, rule 12)."""
    needle = like_contains(q)
    matches = [
        column.ilike(needle, escape="\\")
        for column in (
            StockIssue.customer_name,
            StockIssue.recipient_name,
            StockIssue.waybill,
            StockIssue.order_code,
            StockIssue.order_name,
        )
    ]
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
    _: User | None = RequirePermission(Permission.PROJECTS_READ),
):
    """Dispatch notes — the stock page's tab, an order's «Видачі», a customer's issues (rules 12, 20–22)."""
    query = select(StockIssue)
    if customer_id is not None:
        query = query.where(StockIssue.customer_id == customer_id)
    if project_id is not None:
        query = query.where(StockIssue.project_id == project_id)
    if q and q.strip():
        query = query.where(_search(q.strip()))
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
    return StockIssuePage(items=await issue_rows(db, issues), meta=page_meta(total, page, per_page, all))


@router.get("/{issue_id}", response_model=DispatchNoteOut)
async def get_dispatch_note(
    issue_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_READ),
):
    """The document, drawn only from its snapshot (rule 14)."""
    issue = await db.get(StockIssue, issue_id)
    if issue is None:
        raise HTTPException(status_code=404, detail="Dispatch note not found")
    return await note_out(db, issue)


@router.patch("/{issue_id}", response_model=StockIssueRow)
async def update_stock_issue(
    issue_id: int,
    data: StockIssueUpdate,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_UPDATE),
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
