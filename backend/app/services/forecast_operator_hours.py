"""Daily operator absence in the existing advisory forecast, never a dispatch gate."""

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo


@dataclass(frozen=True)
class OperatorHours:
    origin: datetime
    start: time
    end: time
    zone: ZoneInfo

    def __post_init__(self):
        if self.start == self.end:
            raise ValueError("Operator absence start and end must differ.")

    def service_finish(self, seconds: float, duration: float) -> float:
        """Move only manual plate work into available hours, retaining its duration.

        datetime/zoneinfo already handle the timezone database. A recurrence
        engine or BusinessHour dependency would duplicate a single daily window.
        A repeated end time uses its later occurrence; a missing one normalizes
        forward through UTC, so neither admits work before the absence ends.
        """
        origin = (self.origin.replace(tzinfo=timezone.utc) if self.origin.tzinfo is None else self.origin).astimezone(
            timezone.utc
        )
        at = origin + timedelta(seconds=seconds)
        remaining = max(0.0, duration)
        while True:
            day = at.astimezone(self.zone).date()
            intervals = [self._absence(day + timedelta(days=offset)) for offset in (-1, 0, 1)]
            start, end = min((interval for interval in intervals if interval[1] > at), key=lambda interval: interval[0])
            if start <= at:
                at = end
                continue
            available = (start - at).total_seconds()
            if remaining <= available:
                return (at + timedelta(seconds=remaining) - origin).total_seconds()
            remaining -= available
            at = start

    def _absence(self, day: date) -> tuple[datetime, datetime]:
        end_day = day + timedelta(days=int(self.start > self.end))
        start = datetime.combine(day, self.start, self.zone)
        end = datetime.combine(end_day, self.end, self.zone)
        # Conservative UTC boundaries cover both occurrences of a repeated clock
        # time and the spring gap; every iteration advances to a real instant.
        return (
            min(start.replace(fold=fold).astimezone(timezone.utc) for fold in (0, 1)),
            max(end.replace(fold=fold).astimezone(timezone.utc) for fold in (0, 1)),
        )
