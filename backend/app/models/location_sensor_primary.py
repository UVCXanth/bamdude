"""Explicit compact inventory reading when several sources cover one place."""

from sqlalchemy import ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class LocationSensorPrimary(Base):
    __tablename__ = "location_sensor_primary"

    location_id: Mapped[int] = mapped_column(ForeignKey("locations.id", ondelete="CASCADE"), primary_key=True)
    category: Mapped[str] = mapped_column(String(16), primary_key=True)
    source: Mapped[str] = mapped_column(String(16), nullable=False)
    binding_id: Mapped[int] = mapped_column(Integer, nullable=False)
