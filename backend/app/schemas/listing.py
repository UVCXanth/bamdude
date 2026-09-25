"""Paged envelopes of the projects section's three lists (spec: projects-lists-parity).

The element types are the SAME models the flat lists answer with — a list
already carries only what its card draws, so a second, slimmer shape would be
drift without a saving. ``PaginationMeta`` is the archive's.
"""

from pydantic import BaseModel

from backend.app.schemas.archive import PaginationMeta
from backend.app.schemas.customer import CustomerResponse
from backend.app.schemas.product import ProductListItem
from backend.app.schemas.project import ProjectListResponse


class OrderListTotals(BaseModel):
    """Tab counts over the current filters WITHOUT the status filter."""

    active: int
    completed: int
    cancelled: int
    all: int


class OrderListPage(BaseModel):
    items: list[ProjectListResponse]
    meta: PaginationMeta
    totals: OrderListTotals


class ProductListPage(BaseModel):
    items: list[ProductListItem]
    meta: PaginationMeta


class CustomerListPage(BaseModel):
    items: list[CustomerResponse]
    meta: PaginationMeta


class OrdersSummary(BaseModel):
    """``GET /projects/summary`` — the orders page's tiles: the farm's ACTIVE
    orders, never the list's filters (spec workshop-lists, rules 1–2)."""

    active: int
    overdue: int
    urgent: int
    printing: int
    queued: int
    remaining: int
    all_covered: int


class CustomersSummary(BaseModel):
    """``GET /customers/summary`` — the customers page's tiles (spec
    workshop-lists, rule 3). ``total_price`` excludes cancelled orders (rule 6);
    orders without a customer are not the customers' business."""

    customers: int
    with_active: int
    active_orders: int
    total_price: float
