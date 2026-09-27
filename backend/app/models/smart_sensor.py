from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.core.database import Base

if TYPE_CHECKING:
    from backend.app.models.printer import Printer
    from backend.app.models.printer_location import PrinterLocation
    from backend.app.models.smart_sensor_binding import SmartSensorBinding


class SmartSensor(Base):
    """A sensor the operator has adopted. Mirrors ``SmartPlug`` on purpose.

    Its existence IS adoption — a paired sensor with no row here stays on the
    mesh, keeps its settings and goes on being configured, but is not something
    the farm shows or acts on. That is the same rule plugs have always had, and
    it is why there is no ``adopted`` flag anywhere.

    ``bindings`` is the source of truth for where readings are shown. One
    device can have several explicit printer, room and spool-storage targets.
    The old ``location_id``/``printer_id`` columns are a compatibility
    projection for 0/1 bindings; both are null for a multi-bound device.
    """

    __tablename__ = "smart_sensors"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    location_id: Mapped[int | None] = mapped_column(ForeignKey("printer_locations.id", ondelete="RESTRICT"))
    location: Mapped["PrinterLocation | None"] = relationship(lazy="selectin")
    # Legacy scalar projection. The physical sensor outlives a printer; deleting
    # it removes only that printer's binding rows.
    printer_id: Mapped[int | None] = mapped_column(ForeignKey("printers.id", ondelete="SET NULL"), index=True)
    # Keep this relationship for old 0/1 rows until the scalar columns are
    # removed in a separate table rebuild. SQLite needs it to null the legacy
    # projection when a printer is deleted.
    printer: Mapped["Printer | None"] = relationship(back_populates="smart_sensors", lazy="selectin")
    zigbee_ieee: Mapped[str] = mapped_column(String(23), unique=True, index=True)
    bindings: Mapped[list["SmartSensorBinding"]] = relationship(
        back_populates="sensor", cascade="all, delete-orphan", lazy="selectin"
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    # Silence is about the device, not about any one quantity, so it cannot
    # live in a per-quantity threshold row. NULL means "speaking".
    silent_since: Mapped[datetime | None] = mapped_column(DateTime)
    silence_notified_at: Mapped[datetime | None] = mapped_column(DateTime)
