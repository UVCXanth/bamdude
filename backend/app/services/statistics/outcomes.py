"""One classification of a print archive's outcome for every success / failure rate (post-rebuild D-R7).

Four disjoint classes of a counted archive:

* **completed** — the print succeeded;
* **physical failure** — ``failed`` / ``aborted`` without a dispatch class: the printer
  ran the job and it went wrong. A legacy failed row with no ``failure_reason`` is one;
* **dispatch error** — ``failed`` / ``aborted`` with a key of
  ``failure_reasons.DISPATCH_FAILURE_REASONS``: the attempt to START the print ended,
  which says nothing about printing («Помилки відправки» / «Dispatch errors»);
* **stopped** — ``stopped`` / ``cancelled`` / ``skipped``: interrupted by a person or
  the queue (#1390).

Success and failure RATES divide by completed + physical failures only; every class
stays in Total Prints. The web overview, Failure Analysis, the export and the
Telegram ``/stats`` all ask these predicates, so no two of them count differently.

⚠️ The physical predicate is NULL-safe on purpose: ``failure_reason NOT IN (…)`` is
UNKNOWN for a NULL reason in SQL, and a plain NOT IN would drop every legacy failure.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import and_, case, func, or_, select

from backend.app.models.archive import PrintArchive
from backend.app.utils.failure_reasons import DISPATCH_FAILURE_REASONS

FAILED_STATUSES = ("failed", "aborted")
STOPPED_STATUSES = ("stopped", "cancelled", "skipped")


def completed():
    return PrintArchive.status == "completed"


def dispatch_failure():
    return and_(
        PrintArchive.status.in_(FAILED_STATUSES),
        PrintArchive.failure_reason.in_(sorted(DISPATCH_FAILURE_REASONS)),
    )


def not_dispatch_failure():
    """Every row that is not a dispatch error — NULL-safe, so a failed row with no reason stays in."""
    return or_(
        PrintArchive.status.notin_(FAILED_STATUSES),
        PrintArchive.failure_reason.is_(None),
        PrintArchive.failure_reason.notin_(sorted(DISPATCH_FAILURE_REASONS)),
    )


def physical_failure():
    return and_(
        PrintArchive.status.in_(FAILED_STATUSES),
        or_(
            PrintArchive.failure_reason.is_(None),
            PrintArchive.failure_reason.notin_(sorted(DISPATCH_FAILURE_REASONS)),
        ),
    )


def stopped():
    return PrintArchive.status.in_(STOPPED_STATUSES)


def success_rate(successful: int, physical_failures: int) -> float:
    """Percent of completed prints among those whose printing reached an outcome; 0 with nothing to divide."""
    outcome = successful + physical_failures
    return (successful / outcome * 100) if outcome > 0 else 0.0


def failure_rate(successful: int, physical_failures: int) -> float:
    outcome = successful + physical_failures
    return (physical_failures / outcome * 100) if outcome > 0 else 0.0


def counted():
    """The archives every statistic counts: neither a legacy «archived» upload nor a row in the trash."""
    return and_(PrintArchive.status != "archived", PrintArchive.deleted_at.is_(None))


@dataclass(frozen=True)
class OutcomeCounts:
    total: int
    completed: int
    physical_failures: int
    dispatch_failures: int
    stopped: int

    @property
    def success_rate(self) -> float:
        return success_rate(self.completed, self.physical_failures)


async def outcome_counts(db, *conditions) -> OutcomeCounts:
    """Every class of :mod:`outcomes` over the counted archives that meet ``conditions``, in one query."""
    row = (
        await db.execute(
            select(
                func.count(PrintArchive.id),
                func.sum(case((completed(), 1), else_=0)),
                func.sum(case((physical_failure(), 1), else_=0)),
                func.sum(case((dispatch_failure(), 1), else_=0)),
                func.sum(case((stopped(), 1), else_=0)),
            ).where(counted(), *conditions)
        )
    ).one()
    return OutcomeCounts(*(int(value or 0) for value in row))
