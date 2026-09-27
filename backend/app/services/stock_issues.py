"""Issues of goods — the ONE writer of ``stock_issues`` (spec workshop-order-issue, rule 10).

An issue is one «Виконати» of an order's «Склад і видача» that hands units over,
or a manual issue off the stock page. It is written with a SNAPSHOT — the
customer's name, the recipient, the delivery — because the contact and the
delivery directory may change or go; afterwards only the waybill number and the
note may change. Its lines are the issue movements of both ledgers that name it.
``tests/unit/test_stock_issues_have_one_writer.py`` keeps every other module out.

Never commits. Refusals are :class:`StockIssueError` — an English sentence the
route forwards verbatim (translated at the boundary) with its HTTP status.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select, update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.app.models.customer import Customer, CustomerContact
from backend.app.models.project import Project
from backend.app.models.stock_issue import WAYBILL_MAX, StockIssue
from backend.app.models.user import User

#: «Leave it alone» for :func:`update` — ``None`` is a real value there (clear it).
UNSET = object()


class StockIssueError(Exception):
    """An issue the writer refuses; ``status`` is the HTTP answer."""

    def __init__(self, detail: str, status: int = 409) -> None:
        super().__init__(detail)
        self.status = status


@dataclass(frozen=True, slots=True)
class Recipient:
    """Who takes the goods and how they travel — copied into the issue as text."""

    name: str | None = None
    phone: str | None = None
    delivery_method: str | None = None
    delivery_details: str | None = None


def _clean(value: str | None) -> str | None:
    return (value or "").strip() or None


def _waybill(value: str | None) -> str | None:
    value = _clean(value)
    if value is not None and len(value) > WAYBILL_MAX:
        raise StockIssueError("A waybill number is at most 24 characters", 422)
    return value


async def _contact(db: AsyncSession, contact_id: int | None, customer_id: int) -> CustomerContact | None:
    """The order's contact when it is still this customer's, else the customer's main one."""
    load = selectinload(CustomerContact.delivery_method)
    if contact_id is not None:
        found = (
            await db.execute(select(CustomerContact).options(load).where(CustomerContact.id == contact_id))
        ).scalar_one_or_none()
        if found is not None and found.customer_id == customer_id:
            return found
    return (
        await db.execute(
            select(CustomerContact)
            .options(load)
            .where(CustomerContact.customer_id == customer_id)
            .order_by(CustomerContact.position, CustomerContact.id)
            .limit(1)
        )
    ).scalar_one_or_none()


async def default_recipient(db: AsyncSession, *, project: Project | None, customer_id: int) -> Recipient:
    """The order's contact person, else the customer's main contact (spec rule 18)."""
    contact = await _contact(db, project.contact_id if project is not None else None, customer_id)
    if contact is None:
        return Recipient()
    method = contact.delivery_method.name if contact.delivery_method is not None else None
    return Recipient(contact.name, contact.phone, method, contact.delivery_details)


async def create(
    db: AsyncSession,
    *,
    customer_id: int,
    project_id: int | None,
    recipient: Recipient,
    waybill: str | None,
    note: str | None,
    actor: User | None,
) -> StockIssue:
    """A new issue with its snapshot. The customer is required (spec rule 16)."""
    customer = await db.get(Customer, customer_id)
    if customer is None:
        raise StockIssueError("Customer not found", 404)
    issue = StockIssue(
        project_id=project_id,
        customer_id=customer.id,
        customer_name=customer.name,
        recipient_name=_clean(recipient.name),
        recipient_phone=_clean(recipient.phone),
        delivery_method=_clean(recipient.delivery_method),
        delivery_details=_clean(recipient.delivery_details),
        waybill=_waybill(waybill),
        note=_clean(note),
        created_by=actor.id if actor is not None else None,
    )
    db.add(issue)
    await db.flush()
    return issue


async def update(db: AsyncSession, issue: StockIssue, *, waybill: object = UNSET, note: object = UNSET) -> None:
    """The waybill number and the note — the only things an issue lets change (spec rule 21)."""
    if waybill is not UNSET:
        issue.waybill = _waybill(waybill)  # type: ignore[arg-type]
    if note is not UNSET:
        issue.note = _clean(note)  # type: ignore[arg-type]
    await db.flush()


async def detach_customer(db: AsyncSession, customer_id: int) -> None:
    """A deleted customer leaves its issues with the snapshot of its name (SQLite runs no FK actions)."""
    await db.execute(sa_update(StockIssue).where(StockIssue.customer_id == customer_id).values(customer_id=None))


async def detach_project(db: AsyncSession, project_id: int) -> None:
    """A deleted order leaves its issues with the customer."""
    await db.execute(sa_update(StockIssue).where(StockIssue.project_id == project_id).values(project_id=None))


async def detach_user(db: AsyncSession, user_id: int) -> None:
    """A deleted user leaves the issues it wrote without a performer."""
    await db.execute(sa_update(StockIssue).where(StockIssue.created_by == user_id).values(created_by=None))
