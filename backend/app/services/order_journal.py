"""The order journal's one writer (spec workshop-order-stage, part В).

Every operator action on an order is recorded here, in the caller's session and
transaction — this module never commits. ``payload`` holds codes, ids, numbers
and name snapshots; the sentence is the frontend's (``orders.timeline.events``).
A ``kind`` outside ``EVENT_KINDS`` is a programming error, not a user's.
"""

from datetime import datetime, timezone

from sqlalchemy import delete, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.project import ProjectEvent
from backend.app.models.user import User

EVENT_KINDS: tuple[str, ...] = (
    "order_created", "status_changed", "fields_changed", "responsible_changed", "stage_changed",
    "line_added", "line_changed", "line_removed", "line_configured",
    "prints_filed", "prints_unfiled", "prints_relined", "print_trashed", "print_restored", "defects_recorded",
    "queue_items_filed", "plan_enqueued", "line_rebalanced",
    "surplus_banked", "procurement_updated",
    "kits_assembled", "goods_received", "goods_issued", "stock_taken", "goods_written_off", "goods_stocked",
    "attachment_added", "attachment_removed", "cover_changed",
)  # fmt: skip

# English, for API callers only — the frontend renders each kind in the reader's language.
TITLES: dict[str, str] = {
    "order_created": "Order created",
    "status_changed": "Status changed",
    "fields_changed": "Order details changed",
    "responsible_changed": "Responsible changed",
    "stage_changed": "Stage changed",
    "line_added": "Line added",
    "line_changed": "Line changed",
    "line_removed": "Line removed",
    "line_configured": "Line configuration changed",
    "prints_filed": "Prints filed under the order",
    "prints_unfiled": "Prints taken out of the order",
    "prints_relined": "Prints moved to another line of the order",
    "print_trashed": "Print moved to the trash",
    "print_restored": "Print restored from the trash",
    "defects_recorded": "Defects recorded",
    "queue_items_filed": "Queue jobs filed under the order",
    "plan_enqueued": "Plan sent to the queue",
    "line_rebalanced": "Line rebalanced",
    "surplus_banked": "Surplus banked to free stock",
    "procurement_updated": "Purchased part updated",
    "kits_assembled": "Kits assembled for the order",
    "goods_received": "Goods received for the order",
    "goods_issued": "Goods issued to the customer",
    "stock_taken": "Taken from stock for the order",
    "goods_written_off": "Goods written off",
    "goods_stocked": "Goods moved to free stock",
    "attachment_added": "Attachment added",
    "attachment_removed": "Attachment removed",
    "cover_changed": "Cover image changed",
}


async def record(
    db: AsyncSession,
    project_id: int,
    kind: str,
    payload: dict | None = None,
    *,
    actor: User | None = None,
    actor_id: int | None = None,
) -> ProjectEvent:
    """Add one journal row for ``project_id``; the caller's transaction owns it.

    ``created_at`` is stamped HERE, in UTC (spec rule 14) — the clock print
    events use (``started_at``/``completed_at`` are Python UTC). A database
    default would be the server's clock, which on a PostgreSQL whose timezone is
    not UTC stores local time and shifts the journal against the prints.
    """
    if kind not in EVENT_KINDS:
        raise ValueError(f"unknown order journal kind: {kind}")
    user_id = user_name = None
    if actor is not None:
        user_id, user_name = actor.id, actor.username
    elif actor_id is not None:
        user = await db.get(User, actor_id)
        if user is not None:
            user_id, user_name = user.id, user.username
    event = ProjectEvent(
        project_id=project_id,
        created_at=datetime.now(timezone.utc).replace(tzinfo=None),
        user_id=user_id,
        user_name=user_name,
        kind=kind,
        payload=payload or {},
    )
    db.add(event)
    return event


async def delete_for_project(db: AsyncSession, project_id: int) -> None:
    """An order's journal goes with the order — in code, SQLite runs no CASCADE."""
    await db.execute(delete(ProjectEvent).where(ProjectEvent.project_id == project_id))


async def detach_user(db: AsyncSession, user_id: int) -> None:
    """A deleted user stops being named by id; the name snapshot keeps the line readable."""
    await db.execute(update(ProjectEvent).where(ProjectEvent.user_id == user_id).values(user_id=None))
