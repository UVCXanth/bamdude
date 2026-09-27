"""The rows of issues as the customer page and the waybill editor read them (spec
workshop-order-issue, rules 21–22). Read-only — ``services/stock_issues.py`` writes.

An issue's units are its movements' — Σ −``delta_on_hand`` of its finished-goods rows and
Σ −``delta`` of its ``issued_for_order`` parts rows — one grouped statement per book for a
page, whatever its size.
"""

from __future__ import annotations

from collections.abc import Sequence

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.finished_stock import StockItemMovement
from backend.app.models.part_stock import ProductPartStockMovement
from backend.app.models.stock_issue import StockIssue
from backend.app.models.user import User
from backend.app.schemas.listing import StockIssueRow
from backend.app.services.entity_codes import code_for


async def units_by_issue(db: AsyncSession, issue_ids: Sequence[int]) -> dict[int, int]:
    """``issue_id → units`` (a parts line's parts count as they were issued)."""
    ids = sorted(set(issue_ids))
    if not ids:
        return {}
    out: dict[int, int] = {}
    finished = await db.execute(
        select(StockItemMovement.stock_issue_id, func.sum(StockItemMovement.delta_on_hand))
        .where(StockItemMovement.stock_issue_id.in_(ids))
        .group_by(StockItemMovement.stock_issue_id)
    )
    for issue_id, delta in finished.all():
        out[issue_id] = out.get(issue_id, 0) - int(delta or 0)
    parts = await db.execute(
        select(ProductPartStockMovement.stock_issue_id, func.sum(ProductPartStockMovement.delta))
        .where(
            ProductPartStockMovement.stock_issue_id.in_(ids),
            ProductPartStockMovement.reason == "issued_for_order",
        )
        .group_by(ProductPartStockMovement.stock_issue_id)
    )
    for issue_id, delta in parts.all():
        out[issue_id] = out.get(issue_id, 0) - int(delta or 0)
    return out


async def issue_rows(db: AsyncSession, issues: Sequence[StockIssue]) -> list[StockIssueRow]:
    """The rows for ``issues``, in the order given."""
    units = await units_by_issue(db, [issue.id for issue in issues])
    user_ids = {issue.created_by for issue in issues if issue.created_by is not None}
    names = (
        dict((await db.execute(select(User.id, User.username).where(User.id.in_(user_ids)))).all()) if user_ids else {}
    )
    return [
        StockIssueRow(
            id=issue.id,
            created_at=issue.created_at,
            project_id=issue.project_id,
            project_code=code_for("order", issue.project_id) if issue.project_id is not None else None,
            customer_id=issue.customer_id,
            customer_name=issue.customer_name,
            units=units.get(issue.id, 0),
            recipient_name=issue.recipient_name,
            recipient_phone=issue.recipient_phone,
            delivery_method=issue.delivery_method,
            delivery_details=issue.delivery_details,
            waybill=issue.waybill,
            note=issue.note,
            created_by_name=names.get(issue.created_by),
        )
        for issue in issues
    ]
