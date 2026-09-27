"""Issues of goods — the waybill and the note written afterwards (spec workshop-order-issue,
rule 21). Everything else about an issue is its movements and does not change."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import RequirePermission
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.stock_issue import StockIssue
from backend.app.models.user import User
from backend.app.schemas.listing import StockIssueRow, StockIssueUpdate
from backend.app.services import stock_issues
from backend.app.services.stock_issue_views import issue_rows

router = APIRouter(prefix="/stock-issues", tags=["stock"])


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
