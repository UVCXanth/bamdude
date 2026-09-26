"""An order line's configuration — ONE writer: ``services/line_config.py``
(spec workshop-product-variants, rules 4–6, 11).

A ``product`` line chooses an option in EVERY group of its product (the
standard one too, written explicitly, so a changed standard or a new group
never changes a saved order) and may change per-unit counts; a ``parts`` line
wants a count of each part. Every reader goes through
``services/line_composition.py``.
"""

from sqlalchemy import ForeignKey, Integer
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base

LINE_MODES = ("product", "parts")


class ProjectLineChoice(Base):
    """The option a line chose in one group."""

    __tablename__ = "project_line_choices"

    line_id: Mapped[int] = mapped_column(ForeignKey("project_lines.id", ondelete="CASCADE"), primary_key=True)
    group_id: Mapped[int] = mapped_column(ForeignKey("product_variant_groups.id", ondelete="CASCADE"), primary_key=True)
    option_id: Mapped[int] = mapped_column(ForeignKey("product_variant_options.id"), index=True)


class ProjectLinePartCount(Base):
    """``product`` mode: a per-unit count that differs from the part's standard
    (0 = not in the kit). ``parts`` mode: how many of that part the line wants."""

    __tablename__ = "project_line_part_counts"

    line_id: Mapped[int] = mapped_column(ForeignKey("project_lines.id", ondelete="CASCADE"), primary_key=True)
    part_id: Mapped[int] = mapped_column(
        ForeignKey("product_parts.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    qty: Mapped[int] = mapped_column(Integer, nullable=False)
