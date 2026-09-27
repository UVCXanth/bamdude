"""Paged envelopes of the projects section's lists (spec: projects-lists-parity)
and the farm summaries their tiles read (spec: workshop-lists).

The element types are the SAME models the flat lists answer with — a list
already carries only what its card draws, so a second, slimmer shape would be
drift without a saving. ``PaginationMeta`` is the archive's.
"""

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field

from backend.app.models.stock_issue import WAYBILL_MAX
from backend.app.schemas.archive import PaginationMeta
from backend.app.schemas.customer import CustomerResponse
from backend.app.schemas.product import ProductListItem
from backend.app.schemas.project import ProjectListResponse
from backend.app.schemas.stock import StockListItem


class OrderStageCounts(BaseModel):
    """Active orders per stage under every filter but status and stage (spec workshop-order-stage, rule 27)."""

    prep: int = 0
    printing: int = 0
    qc: int = 0


class OrderListTotals(BaseModel):
    """Tab counts over the current filters WITHOUT the status filter."""

    active: int
    completed: int
    cancelled: int
    all: int
    stages: OrderStageCounts


class OrderBoardColumn(BaseModel):
    """One kanban column: the cards shown and how many the column holds (spec workshop-order-views, rule 5)."""

    items: list[ProjectListResponse]
    total: int


class OrderBoard(BaseModel):
    """``GET /projects/board`` — three active stages and the latest completed orders."""

    prep: OrderBoardColumn
    printing: OrderBoardColumn
    qc: OrderBoardColumn
    done: OrderBoardColumn


class DeadlineOrder(BaseModel):
    """An order due inside the window, with the forecast and the server's late verdict."""

    order: ProjectListResponse
    eta: datetime | None
    late: bool


class EtaMark(BaseModel):
    """An active order whose forecast lands inside the window while its deadline does not."""

    id: int
    code: str
    name: str
    eta: datetime


class AttentionOrder(BaseModel):
    order: ProjectListResponse
    reason: Literal["overdue", "late_eta", "no_due"]
    eta: datetime | None


class OrderDeadlines(BaseModel):
    """``GET /projects/deadlines`` (spec workshop-order-views, rules 14–16)."""

    start: date
    days: int
    due: list[DeadlineOrder]
    eta_marks: list[EtaMark]
    attention: list[AttentionOrder]


class OrderListPage(BaseModel):
    items: list[ProjectListResponse]
    meta: PaginationMeta
    totals: OrderListTotals


class CategoryCount(BaseModel):
    id: int
    name: str
    count: int


class ProductPartVariantOut(BaseModel):
    group: str
    option: str


class ProductPartProductOut(BaseModel):
    id: int
    code: str
    name: str
    sku: str | None = None


class ProductPartRow(BaseModel):
    """A printed part of a catalogue product — the add-to-order dialog's «parts» tab
    (spec workshop-add-to-order, rule 16)."""

    part_id: int
    name: str
    #: The option the part is bound to, when it is — «angled tail» belongs to «Tail: angled».
    variant: ProductPartVariantOut | None = None
    product: ProductPartProductOut
    #: The product's printer models (stored facets).
    models: list[str] = []


class ProductPartsPage(BaseModel):
    items: list[ProductPartRow]
    meta: PaginationMeta


class ProductListPage(BaseModel):
    items: list[ProductListItem]
    meta: PaginationMeta
    # The catalog's category panel (spec workshop-product-catalog, rule 11):
    # counts under every filter of the request except the category itself. A
    # category with nothing under the filters is absent; ``uncategorized``
    # counts the products without one.
    categories: list[CategoryCount] = []
    uncategorized: int = 0


class ProductFacetsOut(BaseModel):
    """``GET /products/facets`` — the values the catalog's filters offer."""

    materials: list[str]
    colors: list[str]
    models: list[str]


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
    # customers of kind "regular" — the tile's «N regular» line (spec workshop-customers, rule 15)
    regular: int
    with_active: int
    active_orders: int
    total_price: float


class StockListPage(BaseModel):
    items: list[StockListItem]
    meta: PaginationMeta


class StockFigures(BaseModel):
    """``GET /stock/figures`` — the stock page's tiles over the free-parts ledger
    (spec workshop-lists, rule 4). Read-only: the ledger's one writer is
    ``services/part_stock.py``."""

    kits: int
    kit_products: int
    parts: int
    reserved_kits: int
    incomplete: int


class ProjectsNavBadges(BaseModel):
    """``GET /projects/nav-badges`` — the sidebar's counts for the Projects
    section (spec workshop-nav, rule 9). One COUNT per field; WS-07 adds
    ``draft_products``, WS-09 ``stock_below_min``."""

    active_orders: int
    # Active catalog products still in draft (spec workshop-product-catalog, rule 18).
    draft_products: int = 0
    # Finished-goods positions whose free quantity is under their minimum (spec workshop-finished-goods, rule 19).
    stock_below_min: int = 0


# ---------- issues of goods (spec workshop-order-issue, rules 21–22) ----------


class StockIssueRow(BaseModel):
    id: int
    created_at: datetime
    #: None — a manual issue, without an order.
    project_id: int | None = None
    project_code: str | None = None
    customer_id: int | None = None
    customer_name: str = ""
    #: Units, and a parts line's parts, the issue handed over — from its movements.
    units: int = 0
    recipient_name: str | None = None
    recipient_phone: str | None = None
    delivery_method: str | None = None
    delivery_details: str | None = None
    waybill: str | None = None
    note: str | None = None
    created_by_name: str | None = None


class StockIssuePage(BaseModel):
    items: list[StockIssueRow]
    meta: PaginationMeta


class StockIssueUpdate(BaseModel):
    """The two things an issue may change afterwards."""

    waybill: str | None = Field(default=None, max_length=WAYBILL_MAX)
    note: str | None = Field(default=None, max_length=2000)
