"""Finished goods on the wire (spec workshop-finished-goods, rules 16–22).

Every figure is the server's; the frontend draws it. A position's
configuration travels in the same shape as an order line's, so one caption
helper serves both.
"""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from backend.app.schemas.archive import PaginationMeta
from backend.app.schemas.project import LineConfigurationOut


class StockProductRef(BaseModel):
    id: int
    name: str
    sku: str | None = None
    has_cover: bool = False


class StockItemOut(BaseModel):
    id: int
    code: str
    product: StockProductRef
    configuration: LineConfigurationOut
    location: str | None = None
    on_hand: int
    reserved: int
    available: int
    min_qty: int
    below_min: bool
    #: Whole units of this configuration the free-parts shelf can make.
    can_assemble: int = 0


class StockItemsPage(BaseModel):
    items: list[StockItemOut]
    meta: PaginationMeta


class StockItemsSummary(BaseModel):
    """The tiles — the whole farm, never the list's filters (WS-01)."""

    on_hand: int = 0
    reserved: int = 0
    available: int = 0
    tracked: int = 0
    below_min: int = 0


class StockReservationOut(BaseModel):
    """A reservation group; ``project_line_id`` None — held without an order."""

    project_line_id: int | None = None
    project_id: int | None = None
    project_code: str | None = None
    qty: int


class StockItemSibling(BaseModel):
    id: int
    code: str
    configuration: LineConfigurationOut
    on_hand: int
    available: int


class StockItemPartOut(BaseModel):
    part_id: int
    name: str
    per: int
    on_shelf: int


class StockItemDetail(StockItemOut):
    reservations: list[StockReservationOut] = []
    siblings: list[StockItemSibling] = []
    parts: list[StockItemPartOut] = []


class StockLookupOut(BaseModel):
    """What a dialog shows for a picked product and options before anything moves."""

    item: StockItemOut | None = None
    configuration: LineConfigurationOut
    can_assemble: int = 0


StockMoveKind = Literal["receipt", "stocktake", "reserve", "release", "issue"]


class StockMoveIn(BaseModel):
    """``POST /stock/moves`` — a position by id, or a product and its options."""

    kind: StockMoveKind
    item_id: int | None = None
    product_id: int | None = None
    options: list[int] = Field(default_factory=list)
    qty: int | None = None
    #: Інвентаризація — the counted quantity.
    counted: int | None = None
    note: str | None = Field(default=None, max_length=500)
    customer_id: int | None = None
    from_reserve: bool = False


class StockAssembleIn(BaseModel):
    item_id: int | None = None
    product_id: int | None = None
    options: list[int] = Field(default_factory=list)
    qty: int
    note: str | None = Field(default=None, max_length=500)


class StockItemParamsIn(BaseModel):
    location: str | None = Field(default=None, max_length=64)
    min_qty: int | None = None


class StockJournalItemRef(BaseModel):
    id: int
    code: str
    configuration: LineConfigurationOut


class StockJournalCustomer(BaseModel):
    id: int
    name: str


class StockJournalOrder(BaseModel):
    id: int
    code: str
    name: str | None = None


class StockJournalUser(BaseModel):
    id: int
    username: str


class StockJournalRow(BaseModel):
    """One movement of either ledger. ``delta`` is a part row's; the two
    ``delta_*`` columns are a finished row's."""

    book: Literal["finished", "parts"]
    id: int
    created_at: datetime
    product_id: int | None = None
    product_name: str | None = None
    item: StockJournalItemRef | None = None
    part_name: str | None = None
    kind: str
    delta: int = 0
    delta_on_hand: int = 0
    delta_reserved: int = 0
    note: str | None = None
    customer: StockJournalCustomer | None = None
    project: StockJournalOrder | None = None
    user: StockJournalUser | None = None


class StockJournalPage(BaseModel):
    items: list[StockJournalRow]
    #: Set only when the page came back full — a short page is the end.
    next_cursor: str | None = None
