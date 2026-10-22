"""Order intent and durable publication receipts; no physical execution state."""

from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class OrderWorkingPlan(Base):
    __tablename__ = "order_working_plans"

    id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    schema_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    entries: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    facts: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    saved_revision: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    saved_entries: Mapped[list | None] = mapped_column(JSON, nullable=True)
    saved_facts: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    saved_epoch: Mapped[int | None] = mapped_column(Integer, nullable=True)
    saved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    saved_by: Mapped[str | None] = mapped_column(String(128), nullable=True)
    epoch: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    active_operation: Mapped[str | None] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_by: Mapped[str | None] = mapped_column(String(128), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class OrderPlanSubmission(Base):
    __tablename__ = "order_plan_submissions"

    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    plan_id: Mapped[int] = mapped_column(ForeignKey("order_working_plans.id", ondelete="CASCADE"), index=True)
    actor: Mapped[str] = mapped_column(String(128), nullable=False)
    request_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    request: Mapped[dict] = mapped_column(JSON, nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
    epoch_advanced: Mapped[bool] = mapped_column(nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class OrderPlanReceipt(Base):
    __tablename__ = "order_plan_receipts"

    # An immutable part identity. Queue cleanup never cascades into this table.
    id: Mapped[str] = mapped_column(String(210), primary_key=True)
    operation_id: Mapped[str] = mapped_column(ForeignKey("order_plan_submissions.id", ondelete="CASCADE"), index=True)
    entry_id: Mapped[str] = mapped_column(String(100), nullable=False)
    count: Mapped[int] = mapped_column(Integer, nullable=False)
    outcome: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
