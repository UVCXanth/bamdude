"""An issue of goods to a customer — one «Виконати» of an order's «Склад і видача»,
or a manual issue off the stock page (spec workshop-order-issue, rule 1).

Written only by ``services/stock_issues.py``. The issue keeps a SNAPSHOT of the
customer's name, the recipient and the delivery, because the contact and the
delivery directory may change or go; its lines are the issue movements of both
ledgers that name it (``stock_issue_id``).
"""

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, Text
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
