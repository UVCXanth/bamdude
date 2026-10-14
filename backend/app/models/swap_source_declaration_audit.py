"""The append-only journal of operators' swap declarations (swap-source-declaration spec r3 §3).

One row per operation -- a declaration, a refresh of selected jobs, a restore -- written in the same transaction
as the change it records: no success without its journal line. The source is named as a snapshot (kind + id), not
a foreign key: deleting a source must not delete its history, and a recycled id never opens it (the history is
read only through the current declaration's chain). Never an authority for a reader.
"""

from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class SwapSourceDeclarationAudit(Base):
    __tablename__ = "swap_source_declaration_audit"
    __table_args__ = (Index("ix_swap_source_declaration_audit_source", "source_kind", "source_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    #: The client's operation id: an exact replay answers the first result, a changed payload under it is a 409.
    operation_id: Mapped[str] = mapped_column(String(36), unique=True)
    #: ``declare`` | ``refresh_jobs`` | ``restore``.
    action: Mapped[str] = mapped_column(String(16))
    #: ``archive`` | ``library``, and the id it had -- a snapshot, never a foreign key.
    source_kind: Mapped[str] = mapped_column(String(16))
    source_id: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    old_value: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    new_value: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    #: The declaration this operation wrote (or applied, for a refresh) and the one it replaced: the history chain.
    declaration_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    previous_declaration_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    #: The actor as a snapshot: no foreign key, so a deleted user keeps their line and a reused id never inherits it.
    actor_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    actor_label: Mapped[str] = mapped_column(String(255), default="")
    actor_kind: Mapped[str] = mapped_column(String(16))
    revision_before: Mapped[str | None] = mapped_column(String(64), nullable=True)
    revision_after: Mapped[str | None] = mapped_column(String(64), nullable=True)
    #: A digest of the request, so a replayed operation id with another payload is told apart.
    request_digest: Mapped[str | None] = mapped_column(String(64), nullable=True)
    #: For a refresh: the jobs it really changed, ``[{"kind": "queue" | "auto_queue", "id": n}]``.
    jobs: Mapped[list | None] = mapped_column(JSON, nullable=True)
    #: Stamped by the writer in Python UTC, never a server default (local time on a non-UTC PostgreSQL).
    created_at: Mapped[datetime] = mapped_column(DateTime)
