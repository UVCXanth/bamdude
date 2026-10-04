"""Customers — who an order is for. Lives under the projects permissions:
one domain, no new Permission (spec §API)."""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import delete, exists, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.app.api.routes._workshop_rights import (
    WorkshopView,
    bind_workshop_credentials,
    ensure_consequence,
    read_required,
    workshop_view,
)
from backend.app.core.auth import RequestCredentials, RequireAnyPermission, RequirePermission, request_credentials
from backend.app.core.database import get_db, take_write_lock
from backend.app.core.permissions import Permission
from backend.app.models.customer import CONTACT_DATA_FIELDS, Customer, CustomerContact, DeliveryMethod
from backend.app.models.project import Project
from backend.app.models.user import User
from backend.app.schemas.customer import (
    ContactOption,
    CustomerContactIn,
    CustomerContactOut,
    CustomerCreate,
    CustomerFigures,
    CustomerKind,
    CustomerListFigures,
    CustomerOption,
    CustomerResponse,
    CustomerUpdate,
)
from backend.app.schemas.listing import CustomerListPage, CustomersSummary
from backend.app.schemas.project import RecipientOut
from backend.app.services import finished_stock, stock_issues
from backend.app.services.entity_codes import code_for, id_from_query
from backend.app.services.list_paging import (
    SortSpec,
    apply_sql_sort,
    like_contains,
    page_meta,
    resolve_sort,
    slice_page,
    sort_computed,
)
from backend.app.services.order_metrics import customer_figures

router = APIRouter(prefix="/customers", tags=["customers"], dependencies=[Depends(bind_workshop_credentials)])


def _customers_query():
    """Customers with their contacts and each contact's method name — two IN queries, never one per customer."""
    return select(Customer).options(selectinload(Customer.contacts).selectinload(CustomerContact.delivery_method))


async def _contact_orders(db: AsyncSession, customer_id: int | None = None) -> dict[int, int]:
    """Orders naming each contact — one GROUP BY for the whole answer.

    For one customer the group is narrowed to its contacts through a subquery
    (never a bound list of ids, which a big flat list would push past SQLite's
    parameter limit); a list answer groups the table once, whatever its size.
    """
    query = select(Project.contact_id, func.count(Project.id)).where(Project.contact_id.is_not(None))
    if customer_id is not None:
        query = query.where(
            Project.contact_id.in_(select(CustomerContact.id).where(CustomerContact.customer_id == customer_id))
        )
    rows = await db.execute(query.group_by(Project.contact_id))
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


def _masked(row: CustomerResponse, view: WorkshopView) -> CustomerResponse:
    """A customer as this caller may see it (WS-13 E13 O12): the orders' counts and money
    are the orders' — null without ``orders:read``."""
    if view.orders:
        return row
    return row.model_copy(
        update={
            "figures": None,
            "contacts": [c.model_copy(update={"orders_count": None}) for c in row.contacts],
        }
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
    return _masked(_customer_out(customer, figures, await _contact_orders(db, customer.id)), await workshop_view())


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
    _: User | None = RequirePermission(Permission.CUSTOMERS_READ),
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
    view = await workshop_view()
    # The computed keys are order counts and money (WS-13 E13 O12).
    if computed and not view.orders:
        raise read_required("orders")
    query = _customers_query()
    if not paged:
        query = query.order_by(Customer.name)
    total = 0
    if paged:
        if q:
            # ``%``, ``_`` and ``\`` of the query are taken literally (WS-13 E11 A02).
            needle = like_contains(q.strip())
            contact_matches = exists(
                select(CustomerContact.id).where(
                    CustomerContact.customer_id == Customer.id,
                    or_(
                        CustomerContact.name.ilike(needle, escape="\\"),
                        CustomerContact.role.ilike(needle, escape="\\"),
                        CustomerContact.phone.ilike(needle, escape="\\"),
                        CustomerContact.email.ilike(needle, escape="\\"),
                        CustomerContact.city.ilike(needle, escape="\\"),
                        CustomerContact.delivery_details.ilike(needle, escape="\\"),
                        CustomerContact.note.ilike(needle, escape="\\"),
                        CustomerContact.delivery_method_id.in_(
                            select(DeliveryMethod.id).where(DeliveryMethod.name.ilike(needle, escape="\\"))
                        ),
                    ),
                )
            )
            conditions = [Customer.name.ilike(needle, escape="\\"), contact_matches]
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
    items = [_masked(_customer_out(c, figures.get(c.id, _empty_light_figures()), orders), view) for c in rows]
    if not paged:
        return items
    if computed:
        items = sort_computed(items, _CUSTOMER_COMPUTED[key], direction, id_fn=lambda r: r.id)
        total = len(items)
        items = slice_page(items, page, per_page, all)
    return CustomerListPage(items=items, meta=page_meta(total, page, per_page, all))


async def _warn_of_namesake(db: AsyncSession, name: str, own_id: int | None = None) -> None:
    """A customer whose name another one already has is a warning, not a ban (WS-13 E11
    A01; the owner, 2026-10-03): names stay non-unique (WS-03), so the caller may repeat
    the request with ``allow_duplicate_name``. The oldest namesake is named; the fold is
    the database's Unicode-aware ``lower`` (inv-unicode-case-folding). Asked before any
    write, so a refused request leaves nothing behind."""
    query = select(Customer.id).where(func.lower(Customer.name) == func.lower(name))
    if own_id is not None:
        query = query.where(Customer.id != own_id)
    namesake = await db.scalar(query.order_by(Customer.id).limit(1))
    if namesake is not None:
        raise HTTPException(
            status_code=409,
            detail={
                "error": "name_taken",
                "message": f"A customer with this name already exists: {code_for('customer', namesake)}",
                "customer": namesake,
            },
        )


@router.post("", response_model=CustomerResponse)
@router.post("/", response_model=CustomerResponse)
async def create_customer(
    data: CustomerCreate,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.CUSTOMERS_CREATE),
):
    if not data.allow_duplicate_name:
        await _warn_of_namesake(db, data.name)
    customer = Customer(name=data.name, kind=data.kind, notes=data.notes)
    db.add(customer)
    await db.flush()
    await _sync_contacts(db, customer.id, data.contacts)
    return await _response(db, customer.id)


# Whoever needs a customer's NAME — an order form, the orders filter, a stock issue — and
# not the directory (WS-13 E13 O12, CUS-03 / CUS-10).
_NAMES_A_CUSTOMER = (
    Permission.CUSTOMERS_READ,
    Permission.ORDERS_READ,
    Permission.ORDERS_CREATE,
    Permission.ORDERS_UPDATE,
    Permission.STOCK_MOVE,
)


@router.get("/options", response_model=list[CustomerOption])
async def customer_options(
    q: str | None = Query(None, description="Name or CU code"),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequireAnyPermission(*_NAMES_A_CUSTOMER),
):
    """Every customer as a picker names it — id, code, name; nothing of the directory.
    Declared above ``/{customer_id}``."""
    query = select(Customer.id, Customer.name)
    if q and q.strip():
        matches = [Customer.name.ilike(f"%{q.strip()}%")]
        customer_id = id_from_query("customer", q.strip())
        if customer_id is not None:
            matches.append(Customer.id == customer_id)
        query = query.where(or_(*matches))
    rows = (await db.execute(query.order_by(Customer.name, Customer.id))).all()
    return [CustomerOption(id=row.id, code=code_for("customer", row.id), name=row.name) for row in rows]


@router.get("/summary", response_model=CustomersSummary)
async def customers_summary(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.CUSTOMERS_READ),
):
    """The customers page's tiles — the whole farm, never the list's search
    (spec workshop-lists, rules 1, 3). One grouped query, the list's own.
    Declared above ``/{customer_id}``, or ``summary`` would be parsed as an id."""
    figures = (await _light_figures_by_customer(db)).values()
    # The order tiles are the orders' (WS-13 E13 O12).
    orders = (await workshop_view()).orders
    return CustomersSummary(
        customers=await db.scalar(select(func.count(Customer.id))) or 0,
        regular=await db.scalar(select(func.count(Customer.id)).where(Customer.kind == "regular")) or 0,
        with_active=sum(1 for f in figures if f.active > 0) if orders else None,
        active_orders=sum(f.active for f in figures) if orders else None,
        total_price=round(sum(f.total_price for f in figures), 2) if orders else None,
    )


@router.get("/{customer_id}/contact-options", response_model=list[ContactOption])
async def contact_options(
    customer_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequireAnyPermission(*_NAMES_A_CUSTOMER),
):
    """A customer's contacts as an order form picks one: name and role (WS-13 E13 R12)."""
    if await db.get(Customer, customer_id) is None:
        raise HTTPException(status_code=404, detail="Customer not found")
    rows = (
        await db.execute(
            select(CustomerContact)
            .where(CustomerContact.customer_id == customer_id)
            .order_by(CustomerContact.position, CustomerContact.id)
        )
    ).scalars()
    return [ContactOption(id=c.id, code=code_for("contact", c.id), name=c.name, role=c.role) for c in rows]


@router.get("/{customer_id}/recipient", response_model=RecipientOut)
async def customer_recipient(
    customer_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequireAnyPermission(Permission.CUSTOMERS_READ, Permission.STOCK_MOVE),
):
    """Who receives a manual issue by default — the main contact's name, phone and
    delivery: for whoever keeps the contacts or ships the goods (WS-13 E13 O25)."""
    if await db.get(Customer, customer_id) is None:
        raise HTTPException(status_code=404, detail="Customer not found")
    recipient = await stock_issues.default_recipient(db, project=None, customer_id=customer_id)
    return RecipientOut(
        name=recipient.name,
        phone=recipient.phone,
        delivery_method=recipient.delivery_method,
        delivery_details=recipient.delivery_details,
    )


@router.get("/{customer_id}", response_model=CustomerResponse)
async def get_customer(
    customer_id: int, db: AsyncSession = Depends(get_db), _: User | None = RequirePermission(Permission.CUSTOMERS_READ)
):
    return await _response(db, customer_id)


@router.patch("/{customer_id}", response_model=CustomerResponse)
async def update_customer(
    customer_id: int,
    data: CustomerUpdate,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.CUSTOMERS_UPDATE),
):
    customer = await _get_or_404(db, customer_id)
    # Only a request that CHANGES the name is asked — the same name again, or its case
    # alone, is not a new namesake (WS-13 E11 A01).
    renamed = "name" in data.model_fields_set and data.name.lower() != customer.name.lower()
    if renamed and not data.allow_duplicate_name:
        await _warn_of_namesake(db, data.name, own_id=customer.id)
    for field_name in ("name", "kind", "notes"):
        if field_name in data.model_fields_set:  # explicit null clears; absent leaves alone
            setattr(customer, field_name, getattr(data, field_name))
    if "contacts" in data.model_fields_set:
        await _sync_contacts(db, customer.id, data.contacts)
    await db.flush()
    return await _response(db, customer.id)


@router.delete("/{customer_id}")
async def delete_customer(
    customer_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.CUSTOMERS_DELETE),
    creds: RequestCredentials = Depends(request_credentials),
):
    # A plain read, not ``_get_or_404``: that one loads the contacts, and the
    # ORM would then try to null out the very rows deleted below. Locked: an order
    # created for this customer meanwhile waits (its foreign key takes the row on
    # PostgreSQL; ``take_write_lock`` is SQLite's writer).
    await take_write_lock(db, Customer.__table__, customer_id)
    customer = (await db.execute(select(Customer).where(Customer.id == customer_id).with_for_update())).scalar()
    if customer is None:
        raise HTTPException(status_code=404, detail="Customer not found")
    # Its ACTIVE orders lose their customer and would close to stock instead of being
    # issued — an orders consequence, asked before anything is written (WS-13 E13 O24).
    active = await db.scalar(
        select(func.count(Project.id)).where(Project.customer_id == customer_id, Project.status == "active")
    )
    if active:
        await ensure_consequence(creds, Permission.ORDERS_UPDATE)
    # SQLite runs no FK actions: every order's pointer at the customer and at its
    # contacts, and the contacts themselves, go in code (the CASCADE / SET NULL
    # are PostgreSQL's backstop).
    contact_ids = select(CustomerContact.id).where(CustomerContact.customer_id == customer_id)
    await db.execute(update(Project).where(Project.contact_id.in_(contact_ids)).values(contact_id=None))
    await db.execute(update(Project).where(Project.customer_id == customer_id).values(customer_id=None))
    await db.execute(delete(CustomerContact).where(CustomerContact.customer_id == customer_id))
    # The finished-goods issues keep their rows and lose the customer — its id
    # would otherwise pass to the next customer (``customers`` reuses ids).
    await finished_stock.detach_customer(db, customer_id)
    # Its issues stay with the snapshot of its name (spec workshop-order-issue, rule 1).
    await stock_issues.detach_customer(db, customer_id)
    await db.delete(customer)
    return {"message": "Customer deleted"}
