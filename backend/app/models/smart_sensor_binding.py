"""Explicit targets for one adopted Zigbee sensor.

The radio, measurements and history belong to SmartSensor. A binding only
answers where that device's reading is shown and how that target is alerted.
"""

from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, Float, ForeignKey, Index, String, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.core.database import Base


class SmartSensorBinding(Base):
    __tablename__ = "smart_sensor_bindings"

    id: Mapped[int] = mapped_column(primary_key=True)
    sensor_id: Mapped[int] = mapped_column(
        ForeignKey("smart_sensors.id", ondelete="CASCADE"), nullable=False, index=True
    )
    printer_id: Mapped[int | None] = mapped_column(ForeignKey("printers.id", ondelete="CASCADE"))
    printer_location_id: Mapped[int | None] = mapped_column(ForeignKey("printer_locations.id", ondelete="RESTRICT"))
    storage_location_id: Mapped[int | None] = mapped_column(ForeignKey("locations.id", ondelete="RESTRICT"))
    display_name: Mapped[str | None] = mapped_column(String(100))
    visible: Mapped[bool] = mapped_column(Boolean, default=True, server_default="1")
    sort_order: Mapped[int] = mapped_column(default=0, server_default="0")
    notify_enabled: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")

    sensor = relationship("SmartSensor", back_populates="bindings")
    printer = relationship("Printer", lazy="selectin")
    printer_location = relationship("PrinterLocation", lazy="selectin")
    storage_location = relationship("Location", lazy="selectin")
    thresholds: Mapped[list["SmartSensorBindingThreshold"]] = relationship(
        back_populates="binding", cascade="all, delete-orphan", lazy="selectin"
    )

    __table_args__ = (
        CheckConstraint(
            "(CASE WHEN printer_id IS NOT NULL THEN 1 ELSE 0 END) + "
            "(CASE WHEN printer_location_id IS NOT NULL THEN 1 ELSE 0 END) + "
            "(CASE WHEN storage_location_id IS NOT NULL THEN 1 ELSE 0 END) = 1",
            name="ck_smart_sensor_binding_one_target",
        ),
        Index(
            "ux_smart_sensor_binding_printer",
            "sensor_id",
            "printer_id",
            unique=True,
            sqlite_where=text("printer_id IS NOT NULL"),
            postgresql_where=text("printer_id IS NOT NULL"),
        ),
        Index(
            "ux_smart_sensor_binding_room",
            "sensor_id",
            "printer_location_id",
            unique=True,
            sqlite_where=text("printer_location_id IS NOT NULL"),
            postgresql_where=text("printer_location_id IS NOT NULL"),
        ),
        Index(
            "ux_smart_sensor_binding_storage",
            "sensor_id",
            "storage_location_id",
            unique=True,
            sqlite_where=text("storage_location_id IS NOT NULL"),
            postgresql_where=text("storage_location_id IS NOT NULL"),
        ),
    )


class SmartSensorBindingThreshold(Base):
    """Per-target state; null limits inherit the sensor's current default rule."""

    __tablename__ = "smart_sensor_binding_thresholds"

    id: Mapped[int] = mapped_column(primary_key=True)
    binding_id: Mapped[int] = mapped_column(ForeignKey("smart_sensor_bindings.id", ondelete="CASCADE"), nullable=False)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    custom: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    min_value: Mapped[float | None] = mapped_column(Float)
    max_value: Mapped[float | None] = mapped_column(Float)
    deadband: Mapped[float] = mapped_column(Float, default=0.0, server_default="0")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, server_default="1")
    state: Mapped[str] = mapped_column(String(8), default="ok", server_default="ok")
    state_since: Mapped[datetime | None] = mapped_column(DateTime)
    notified_at: Mapped[datetime | None] = mapped_column(DateTime)

    binding: Mapped[SmartSensorBinding] = relationship(back_populates="thresholds")

    __table_args__ = (Index("ux_smart_sensor_binding_threshold_kind", "binding_id", "kind", unique=True),)
