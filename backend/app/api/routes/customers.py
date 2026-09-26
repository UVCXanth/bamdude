"""Customers — who an order is for. Lives under the projects permissions:
one domain, no new Permission (spec §API)."""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import delete, exists, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.app.core.auth import RequirePermission
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.customer import CONTACT_DATA_FIELDS, Customer, CustomerContact, DeliveryMethod
from backend.app.models.project import Project
from backend.app.models.user import User
from backend.app.schemas.customer import (
    CustomerContactIn,
    CustomerContactOut,
    CustomerCreate,
    CustomerFigures,
    CustomerKind,
    CustomerListFigures,
    CustomerResponse,
    CustomerUpdate,
)
from backend.app.schemas.listing import CustomerListPage, CustomersSummary
from backend.app.services.entity_codes import code_for, id_from_query
from backend.app.services.list_paging import (
    SortSpec,
    apply_sql_sort,
    page_meta,
    resolve_sort,
    slice_page,
    sort_computed,
)
from backend.app.services.order_metrics import customer_figures

router = APIRouter(prefix="/customers", tags=["customers"])


def _customers_query():
    """Customers with their contacts and each contact's method name — two IN queries, never one per customer."""
    return select(Customer).options(selectinload(Customer.contacts).selectinload(CustomerContact.delivery_method))


async def _contact_orders(db: AsyncSession) -> dict[int, int]:
    """Orders naming each contact — one GROUP BY for the whole answer."""
    rows = await db.execute(
        select(Project.contact_id, func.count(Project.id))
        .where(Project.contact_id.is_not(None))
        .group_by(Project.contact_id)
    )
    return dict(rows.all())


def _contact_out(contact: CustomerContact, orders: dict[int, int]) -> CustomerContactOut:
    return CustomerContactOut(
        id=contact.id,
        code=code_for("contact", contact.id),
        name=contact.name,
        role=contact.role,
        phone=contact.phone,
        email=contact.email,
        city=contact.city,
        delivery_method_id=contact.delivery_method_id,
        delivery_method_name=contact.delivery_method.name if contact.delivery_method else None,
        delivery_details=contact.delivery_details,
        note=contact.note,
        orders_count=orders.get(contact.id, 0),
    )


def _customer_out(customer: Customer, figures, orders: dict[int, int]) -> CustomerResponse:
    return CustomerResponse(
        id=customer.id,
        code=code_for("customer", customer.id),
        name=customer.name,
        kind=customer.kind,
        notes=customer.notes,
        created_at=customer.created_at,
        updated_at=customer.updated_at,
        contacts=[_contact_out(c, orders) for c in customer.contacts],
        figures=figures,
    )


async def _sync_contacts(db: AsyncSession, customer_id: int, items: list[CustomerContactIn]) -> None:
    """The form's list, synced by id (spec rule 13): an id updates its row, no id
    creates one, a contact missing from the list is removed — and every order
    that named it loses its contact (SQLite runs no SET NULL). The list's order
    is the new ``position``; the first row is the main contact. Every refusal is
    raised before the first write, so a refused save changes nothing."""
    kept = [item for item in items if not item.is_empty()]
    existing = {
        c.id: c
        for c in (await db.execute(select(CustomerContact).where(CustomerContact.customer_id == customer_id))).scalars()
    }
    seen: set[int] = set()
    for item in kept:
        if item.id is None:
            continue
        if item.id in seen:
            raise HTTPException(status_code=422, detail=f"Contact {item.id} is listed twice")
        if item.id not in existing:
            raise HTTPException(status_code=422, detail=f"Contact {item.id} does not belong to this customer")
        seen.add(item.id)
    method_ids = {item.delivery_method_id for item in kept if item.delivery_method_id is not None}
    if method_ids:
        known = set((await db.execute(select(DeliveryMethod.id).where(DeliveryMethod.id.in_(method_ids)))).scalars())
        for missing in sorted(method_ids - known):
            raise HTTPException(status_code=422, detail=f"Delivery method {missing} not found")
    for position, item in enumerate(kept):
        row = existing[item.id] if item.id is not None else CustomerContact(customer_id=customer_id)
        for field in CONTACT_DATA_FIELDS:
            setattr(row, field, getattr(item, field))
        row.position = position
        db.add(row)
    gone = sorted(set(existing) - seen)
    if gone:
        await db.execute(update(Project).where(Project.contact_id.in_(gone)).values(contact_id=None))
        await db.execute(delete(CustomerContact).where(CustomerContact.id.in_(gone)))
    await db.flush()


async def _response(db: AsyncSession, customer_id: int) -> CustomerResponse:
    customer = await _get_or_404(db, customer_id)
    figures = CustomerFigures.model_validate(await customer_figures(db, customer.id))
    return _customer_out(customer, figures, await _contact_orders(db))


def _empty_light_figures() -> CustomerListFigures:
    """A customer with no orders at all: zeros, never a missing key."""
    return CustomerListFigures(projects=0, active=0, completed=0, cancelled=0, total_price=0.0)


async def _light_figures_by_customer(db: AsyncSession) -> dict[int, CustomerListFigures]:
    """Figures for the LIST endpoint, in one grouped query.

    ``customer_figures`` loads a full ``OrderContext`` per PROJECT — several
    queries plus every archive row — which is right for one customer and wrong
    once per row of a list. Everything the list actually shows is counts and a
    price sum, and one GROUP BY answers that for the whole table.

    The archive-derived keys (``ordered`` / ``printed`` / ``total_cost``) are
    deliberately ABSENT rather than zero: an absent key cannot be mistaken for a
    measured zero, and the detail endpoint is where the frontend asks for them.
    Unknown statuses are counted under their own key, as ``customer_figures``
    does, so a status added later shows up instead of vanishing.
    """
    rows = await db.execute(
        select(
            Project.customer_id,
            Project.status,
            func.count(Project.id),
            func.coalesce(func.sum(Project.price), 0.0),
        )
        .where(Project.customer_id.is_not(None))
        .group_by(Project.customer_id, Project.status)
    )
    out: dict[int, dict] = {}
    for customer_id, status, count, price_sum in rows:
        figures = out.get(customer_id)
        if figures is None:
            # Not ``setdefault``: its default is evaluated on EVERY row, so a
            # customer with six statuses built (and threw away) five models.
            figures = out[customer_id] = _empty_light_figures().model_dump()
        figures["projects"] += count
        figures[status] = figures.get(status, 0) + count
        # A cancelled order is not revenue (spec workshop-lists, rule 6).
        if status != "cancelled":
            figures["total_price"] += float(price_sum or 0)
    for figures in out.values():
        figures["total_price"] = round(figures["total_price"], 2)
    return {customer_id: CustomerListFigures.model_validate(figures) for customer_id, figures in out.items()}


async def _get_or_404(db: AsyncSession, customer_id: int) -> Customer:
    # ``populate_existing``: after a write this re-reads the contacts instead of
    # handing back the collection the session loaded before it.
    customer = (
        await db.execute(_customers_query().where(Customer.id == customer_id).execution_options(populate_existing=True))
    ).scalar_one_or_none()
    if customer is None:
        raise HTTPException(status_code=404, detail="Customer not found")
    return customer


_CUSTOMER_SORT = SortSpec(
    sql={"name": (func.lower(Customer.name), False), "created": (Customer.created_at, False)},
    computed={"orders", "active", "completed", "cancelled", "total_price"},
    default="name-asc",
)
# ``orders`` is the light figures' ``projects`` — every order of the customer.
_CUSTOMER_COMPUTED = {
    "orders": lambda r: r.figures.projects,
    "active": lambda r: r.figures.active,
    "completed": lambda r: r.figures.completed,
    "cancelled": lambda r: r.figures.cancelled,
    "total_price": lambda r: r.figures.total_price,
}


@router.get("", response_model=list[CustomerResponse] | CustomerListPage)
@router.get("/", response_model=list[CustomerResponse] | CustomerListPage)
async def list_customers(
    q: str | None = Query(None, description="With page set: ilike on the name or any contact field, or a CU/CT code"),
    with_active: bool = Query(False, description="With page set: only customers with an active order"),
    kind: CustomerKind | None = Query(None, description="With page set: only customers of this kind"),
    sort_by: str | None = Query(None, description="With page set: '<key>-<asc|desc>'; unknown → name-asc"),
    page: int | None = Query(None, ge=1, description="Omit entirely for the legacy flat-array response"),
    per_page: int = Query(24, ge=1, le=200),
    all: bool = Query(False, description="With page set, skip pagination and return every matching row"),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_READ),
):
    """The customers list. ``page`` is the compat switch (the inventory's contract).

    Without it the flat array the customer picker and the orders page's filter
    read — unchanged. With it ``{items, meta}``, ``q`` (name, any contact field,
    a contact's delivery method, the customer's ``CU`` code or a contact's ``CT``
    code), ``with_active`` (only customers with an active order), ``kind`` and
    ``sort_by``.
    The light figures are one GROUP BY over the whole table either
    way; a computed key (an order count or the price sum) sorts the built rows
    here and slices, a SQL key (``name``, ``created``) pages in the database.
    """
    paged = page is not None
    key, direction, computed = resolve_sort(_CUSTOMER_SORT, sort_by)
    query = _customers_query()
    if not paged:
        query = query.order_by(Customer.name)
    total = 0
    if paged:
        if q:
            needle = f"%{q.strip()}%"
            contact_matches = exists(
                select(CustomerContact.id).where(
                    CustomerContact.customer_id == Customer.id,
                    or_(
                        CustomerContact.name.ilike(needle),
                        CustomerContact.role.ilike(needle),
                        CustomerContact.phone.ilike(needle),
                        CustomerContact.email.ilike(needle),
                        CustomerContact.city.ilike(needle),
                        CustomerContact.delivery_details.ilike(needle),
                        CustomerContact.note.ilike(needle),
                        CustomerContact.delivery_method_id.in_(
                            select(DeliveryMethod.id).where(DeliveryMethod.name.ilike(needle))
                        ),
                    ),
                )
            )
            conditions = [Customer.name.ilike(needle), contact_matches]
            if (customer_id := id_from_query("customer", q)) is not None:
                conditions.append(Customer.id == customer_id)
            # A contact's code needs its prefix: a bare number is the customer's (spec rule 3).
            if (contact_id := id_from_query("contact", q, require_prefix=True)) is not None:
                conditions.append(
                    exists(
                        select(CustomerContact.id).where(
                            CustomerContact.customer_id == Customer.id, CustomerContact.id == contact_id
                        )
                    )
                )
            query = query.where(or_(*conditions))
        if with_active:
            query = query.where(Customer.id.in_(select(Project.customer_id).where(Project.status == "active")))
        if kind:
            query = query.where(Customer.kind == kind)
        if not computed:
            total = await db.scalar(select(func.count()).select_from(query.subquery())) or 0
            query = apply_sql_sort(query, _CUSTOMER_SORT, key, direction, Customer.id)
            if not all:
                query = query.limit(per_page).offset((page - 1) * per_page)
    rows = (await db.execute(query)).scalars().all()
    figures = await _light_figures_by_customer(db)
    orders = await _contact_orders(db)
    # ``.get(default)``, never ``or``: the question is whether the customer HAS
    # a row in the grouped result, not whether the model it holds is truthy —
    # two different questions that happen to agree.
    items = [_customer_out(c, figures.get(c.id, _empty_light_figures()), orders) for c in rows]
    if not paged:
        return items
    if computed:
        items = sort_computed(items, _CUSTOMER_COMPUTED[key], direction, id_fn=lambda r: r.id)
        total = len(items)
        items = slice_page(items, page, per_page, all)
    return CustomerListPage(items=items, meta=page_meta(total, page, per_page, all))


@router.post("", response_model=CustomerResponse)
@router.post("/", response_model=CustomerResponse)
async def create_customer(
    data: CustomerCreate,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_CREATE),
):
    customer = Customer(name=data.name, kind=data.kind, notes=data.notes)
    db.add(customer)
    await db.flush()
    await _sync_contacts(db, customer.id, data.contacts)
    return await _response(db, customer.id)


@router.get("/summary", response_model=CustomersSummary)
async def customers_summary(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_READ),
):
    """The customers page's tiles — the whole farm, never the list's search
    (spec workshop-lists, rules 1, 3). One grouped query, the list's own.
    Declared above ``/{customer_id}``, or ``summary`` would be parsed as an id."""
    figures = (await _light_figures_by_customer(db)).values()
    return CustomersSummary(
        customers=await db.scalar(select(func.count(Customer.id))) or 0,
        regular=await db.scalar(select(func.count(Customer.id)).where(Customer.kind == "regular")) or 0,
        with_active=sum(1 for f in figures if f.active > 0),
        active_orders=sum(f.active for f in figures),
        total_price=round(sum(f.total_price for f in figures), 2),
    )


@router.get("/{customer_id}", response_model=CustomerResponse)
async def get_customer(
    customer_id: int, db: AsyncSession = Depends(get_db), _: User | None = RequirePermission(Permission.PROJECTS_READ)
):
    return await _response(db, customer_id)


@router.patch("/{customer_id}", response_model=CustomerResponse)
async def update_customer(
    customer_id: int,
    data: CustomerUpdate,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_UPDATE),
):
    customer = await _get_or_404(db, customer_id)
    for field_name in ("name", "kind", "notes"):
        if field_name in data.model_fields_set:  # explicit null clears; absent leaves alone
            setattr(customer, field_name, getattr(data, field_name))
    if "contacts" in data.model_fields_set:
        await _sync_contacts(db, customer.id, data.contacts)
    await db.flush()
    return await _response(db, customer.id)


@router.delete("/{customer_id}")
async def delete_customer(
    customer_id: int, db: AsyncSession = Depends(get_db), _: User | None = RequirePermission(Permission.PROJECTS_DELETE)
):
    # A plain ``get``, not ``_get_or_404``: that one loads the contacts, and the
    # ORM would then try to null out the very rows deleted below.
    customer = await db.get(Customer, customer_id)
    if customer is None:
        raise HTTPException(status_code=404, detail="Customer not found")
    # SQLite runs no FK actions: every order's pointer at the customer and at its
    # contacts, and the contacts themselves, go in code (the CASCADE / SET NULL
    # are PostgreSQL's backstop).
    contact_ids = select(CustomerContact.id).where(CustomerContact.customer_id == customer_id)
    await db.execute(update(Project).where(Project.contact_id.in_(contact_ids)).values(contact_id=None))
    await db.execute(update(Project).where(Project.customer_id == customer_id).values(customer_id=None))
    await db.execute(delete(CustomerContact).where(CustomerContact.customer_id == customer_id))
    await db.delete(customer)
    return {"message": "Customer deleted"}
