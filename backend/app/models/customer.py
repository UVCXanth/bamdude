"""Customer — who an order (project) is for — with its contacts and the
delivery-method reference the contacts pick from (spec workshop-customers)."""

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.core.database import Base

CUSTOMER_KINDS = ("company", "regular", "private")
# The eight fields a contact holds. A contact with every one of them empty is not kept.
CONTACT_DATA_FIELDS = ("name", "role", "phone", "email", "city", "delivery_method_id", "delivery_details", "note")


def delivery_method_key(name: str) -> str:
    """The reference's uniqueness key — Python's Unicode-aware fold, whatever the database folds."""
    return name.strip().casefold()


class Customer(Base):
    __tablename__ = "customers"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255))
    # company | regular | private — the list's «Regular» filter reads it.
    kind: Mapped[str] = mapped_column(String(16), default="company", server_default="company")
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    projects: Mapped[list["Project"]] = relationship(back_populates="customer")
    # The main contact is the lowest ``position``. SQLite runs no FK actions: the
    # routes delete contacts in code; the CASCADE is PostgreSQL's backstop.
    contacts: Mapped[list["CustomerContact"]] = relationship(
        back_populates="customer", order_by="CustomerContact.position"
    )


class DeliveryMethod(Base):
    """How a contact receives goods — a reference the owner edits for their country.

    The details (branch number, parcel locker, address) belong to each contact
    (``CustomerContact.delivery_details``), not here.
    """

    __tablename__ = "delivery_methods"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255))
    name_key: Mapped[str] = mapped_column(String(255), unique=True)
    position: Mapped[int] = mapped_column(Integer, default=0, server_default="0")


class CustomerContact(Base):
    __tablename__ = "customer_contacts"
    __table_args__ = (Index("ix_customer_contacts_customer_position", "customer_id", "position"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id", ondelete="CASCADE"))
    position: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    role: Mapped[str | None] = mapped_column(String(255), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(255), nullable=True)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    city: Mapped[str | None] = mapped_column(String(255), nullable=True)
    delivery_method_id: Mapped[int | None] = mapped_column(
        ForeignKey("delivery_methods.id", ondelete="SET NULL"), nullable=True
    )
    delivery_details: Mapped[str | None] = mapped_column(String(255), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)

    customer: Mapped[Customer] = relationship(back_populates="contacts")
    delivery_method: Mapped[DeliveryMethod | None] = relationship()


from backend.app.models.project import Project  # noqa: E402
