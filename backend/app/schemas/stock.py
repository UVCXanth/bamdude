"""Wire shapes of the Stock tab — the farm-wide shelf and its journal.

Read-only: the ledger's single writer is ``services/part_stock.py`` and the
only write the tab offers is the product route's own ``stock/adjust``.
"""

from enum import Enum

from pydantic import BaseModel

from backend.app.schemas.product import KitsByOptionOut, StockBalanceOut, StockMovementOut
from backend.app.services.part_stock import REASONS

#: The five reasons as a query-parameter enum, built from the ledger's own
#: tuple so the two cannot drift: an unknown reason is a 422 from validation,
#: with no sentence to translate.
StockReason = Enum("StockReason", {r: r for r in REASONS}, type=str)


class StockCatalogOption(BaseModel):
    id: int
    name: str


class StockCatalogGroup(BaseModel):
    id: int
    name: str
    #: The standard option — what a dialog shows chosen; null when the group has none.
    default_option_id: int | None = None
    options: list[StockCatalogOption] = []


class StockCatalogProduct(BaseModel):
    """``GET /stock/catalog`` — what a stock dialog needs to pick a product and its options
    (WS-13 E13 O12, STK-10): no prices, no part shelf, no order counts. ``origin`` tells a
    one-off product (assembly treats it apart)."""

    id: int
    code: str
    name: str
    sku: str | None = None
    origin: str
    has_cover: bool = False
    variant_groups: list[StockCatalogGroup] = []


class StockReservationOut(BaseModel):
    """An ACTIVE order's line holding kits of this product off the shelf.

    Only active orders are listed: a completed order's kits went out inside the
    units the customer received, and a cancelled order has already released.
    ``kits`` is always > 0 — a line holding nothing is not a reservation.
    """

    line_id: int
    order_id: int
    #: WS-13 E1 ST4 — ``OR-0042``.
    order_code: str = ""
    order_name: str
    kits: int


class StockProductOut(BaseModel):
    id: int
    name: str
    #: The catalog flag rides along so the page can MARK a hidden product; it
    #: never filters — a hidden product's parts are on the shelf all the same.
    is_active: bool
    #: ``catalog`` | ``adhoc_job`` | ``adhoc_plate`` — informational.
    origin: str
    kits_available: int
    #: Counted parts only, in the product's own part order — the same rows the
    #: product page's shelf shows.
    parts: list[StockBalanceOut] = []
    reservations: list[StockReservationOut] = []
    #: WS-13 E1 ST4.
    sku: str | None = None
    #: Σ the counted parts' balances — what lies on the shelf, kits or not.
    parts_on_shelf: int = 0
    #: One option of one group at a time, the others at their standard (Q12); read
    #: for the page's rows only — the flat answer leaves it empty.
    kits_by_option: list[KitsByOptionOut] = []


class StockListItem(StockProductOut):
    """A row of the PAGED list (spec workshop-lists, rules 9, 20): the flat row
    plus what its reservations add up to, so the table can show and sort a
    «Reserved» column without adding anything itself. The flat answer keeps the
    plain ``StockProductOut``."""

    reserved_kits: int = 0


class StockSummaryOut(BaseModel):
    """``GET /stock`` — every product with a shelf, kits descending, then name."""

    products: list[StockProductOut] = []


class StockMovementRowOut(StockMovementOut):
    """A ledger row as the farm journal shows it: the product page's row plus
    the product it belongs to, because the journal spans every product."""

    product_id: int
    product_name: str


class StockMovementsPageOut(BaseModel):
    """``GET /stock/movements`` — one keyset page, newest first.

    ``next_before_id`` is the last row's id when the page was full, and
    ``None`` when the ledger is exhausted; the client passes it back as
    ``before_id`` to load the older page.
    """

    items: list[StockMovementRowOut] = []
    next_before_id: int | None = None
