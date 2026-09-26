"""A product category — a directory entry, renamed in one place (spec workshop-product-catalog, rule 2)."""

from datetime import datetime

from sqlalchemy import DateTime, String, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


def category_key(name: str) -> str:
    """The directory's uniqueness key — Python's Unicode-aware fold, whatever the database folds."""
    return name.strip().casefold()


class ProductCategory(Base):
    __tablename__ = "product_categories"
    __table_args__ = {"sqlite_autoincrement": True}

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    # ``category_key(name)`` — the duplicate check, computed in Python; wide
    # enough for casefold(), which may lengthen a name threefold.
    name_key: Mapped[str] = mapped_column(String(512), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
