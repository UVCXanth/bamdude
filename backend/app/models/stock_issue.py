"""An issue of goods to a customer — one «Виконати» of an order's «Склад і видача»,
or a manual issue off the stock page (spec workshop-order-issue, rule 1).

Written only by ``services/stock_issues.py``. The issue keeps a SNAPSHOT of the
customer's name, the recipient and the delivery, because the contact and the
delivery directory may change or go; its lines are the issue movements of both
ledgers that name it (``stock_issue_id``).

WS-12: the issue IS the dispatch note ``DN-<id>``; ``stock_issues.seal`` writes its
snapshot — lines, supplier, basis, performer, units — once (spec workshop-dispatch-notes).
"""

from datetime import datetime

from sqlalchemy import JSON, CheckConstraint, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base
from backend.app.models.finished_stock import utcnow

#: The waybill (ТТН) number a carrier gives — the owner's ceiling.
WAYBILL_MAX = 24


class StockIssue(Base):
    __tablename__ = "stock_issues"
    __table_args__ = (
        Index("ix_stock_issues_customer_created", "customer_id", "created_at"),
        Index("ix_stock_issues_project_id", "project_id"),
        # WS-12 derives the dispatch note's code from the id — never reissued.
        {"sqlite_autoincrement": True},
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id", ondelete="SET NULL"), nullable=True)
    #: Required when the issue is written; NULL only after the customer was deleted.
    customer_id: Mapped[int | None] = mapped_column(ForeignKey("customers.id", ondelete="SET NULL"), nullable=True)
    customer_name: Mapped[str] = mapped_column(String(255), nullable=False, default="", server_default="")
    recipient_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    recipient_phone: Mapped[str | None] = mapped_column(String(255), nullable=True)
    delivery_method: Mapped[str | None] = mapped_column(String(255), nullable=True)
    delivery_details: Mapped[str | None] = mapped_column(String(255), nullable=True)
    waybill: Mapped[str | None] = mapped_column(String(WAYBILL_MAX), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)
    # WS-12 (spec workshop-dispatch-notes, rule 2) — the dispatch note's snapshot,
    # written once by ``stock_issues.seal`` and never changed afterwards.
    supplier: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_by_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    #: The basis as the note says it — kept after the order is renamed or deleted.
    order_code: Mapped[str | None] = mapped_column(String(32), nullable=True)
    order_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    #: Σ quantity of the lines — stored so the list sorts and shows it without a join.
    units: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")


class StockIssueLine(Base):
    """One line of a dispatch note — what was handed over, as it was named then (rule 3).

    A product's row: its name, SKU and configuration (the wire shape of
    ``LineConfigurationOut``). A parts line's row: the part's name beside its
    product's; configuration ``{}``. ``product_id`` is only the link and goes
    NULL with the product (``stock_issues.detach_product``).
    """

    __tablename__ = "stock_issue_lines"
    __table_args__ = (
        Index("ix_stock_issue_lines_issue_position", "issue_id", "position"),
        Index("ix_stock_issue_lines_product_id", "product_id"),
        CheckConstraint("quantity > 0", name="ck_stock_issue_lines_quantity"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    issue_id: Mapped[int] = mapped_column(ForeignKey("stock_issues.id", ondelete="CASCADE"), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id", ondelete="SET NULL"), nullable=True)
    product_name: Mapped[str] = mapped_column(String(255), nullable=False)
    sku: Mapped[str | None] = mapped_column(String(64), nullable=True)
    configuration: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    part_name: Mapped[str | None] = mapped_column(String(512), nullable=True)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
