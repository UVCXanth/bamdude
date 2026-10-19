"""Append-only operator decisions; target deletion must preserve this evidence."""

from datetime import datetime

from sqlalchemy import JSON, DateTime, Index, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class PrintStateRecoveryAction(Base):
    __tablename__ = "print_state_recovery_actions"
    __table_args__ = (Index("ix_print_state_recovery_printer_created", "printer_id", "created_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    actor: Mapped[str] = mapped_column(String(100))
    actor_label: Mapped[str] = mapped_column(String(100))
    printer_id: Mapped[int] = mapped_column(Integer)
    queue_id: Mapped[int] = mapped_column(Integer)
    item_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    archive_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    action: Mapped[str] = mapped_column(String(40))
    input_hash: Mapped[str] = mapped_column(String(64))
    # Bounded, server-owned fields only; no file paths or credential material.
    result: Mapped[dict] = mapped_column(JSON)
