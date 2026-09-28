"""Observed Home Assistant values owned by exactly one binding revision."""

from datetime import datetime

from sqlalchemy import BigInteger, CheckConstraint, DateTime, Float, ForeignKey, Index, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class HASensorHistory(Base):
    __tablename__ = "ha_sensor_history"
    __table_args__ = (
        CheckConstraint("(printer_sensor_id IS NULL) != (location_sensor_id IS NULL)", name="ck_ha_history_one_owner"),
        Index("ix_ha_history_printer_time", "printer_sensor_id", "observed_at"),
        Index("ix_ha_history_location_time", "location_sensor_id", "observed_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True)
    printer_sensor_id: Mapped[int | None] = mapped_column(ForeignKey("printer_ha_sensors.id", ondelete="CASCADE"))
    location_sensor_id: Mapped[int | None] = mapped_column(ForeignKey("location_ha_sensors.id", ondelete="CASCADE"))
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    entity_id: Mapped[str] = mapped_column(String(255), nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    unit: Mapped[str | None] = mapped_column(String(16))
    state: Mapped[str] = mapped_column(String(64), nullable=False)
    value: Mapped[float | None] = mapped_column(Float)
    observed_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now())
