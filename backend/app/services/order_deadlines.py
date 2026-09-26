"""Deadlines against the forecast — the ONE late rule (spec workshop-order-views, rule 16).

A deadline is a day (stored at midnight); the forecast's ``now_eta`` is an
instant — naive UTC. «Late» = the forecast lands after the END of the deadline
day. The deadlines board asks this module both for each card's flag and for why
an order needs attention, so the two can never disagree.

⚠️ The day is the SERVER's calendar day — the one «today» and «overdue» are read
in (the orders summary's rule) — never the UTC day: on a farm at UTC+3 a print
finishing at 01:30 local after the deadline day ends at 22:30 UTC ON it, and a
UTC comparison called it on time. Every comparison goes through
``server_wall_time`` first; ``tz`` exists for the tests.
"""

from datetime import datetime, timedelta, timezone, tzinfo
from typing import Literal

AttentionReason = Literal["overdue", "late_eta", "no_due"]
ATTENTION_ORDER: tuple[AttentionReason, ...] = ("overdue", "late_eta", "no_due")


def server_tz() -> tzinfo | None:
    """The server's own timezone — ``None`` makes ``astimezone`` use the system's."""
    return None


def server_wall_time(eta: datetime | None, tz: tzinfo | None = None) -> datetime | None:
    """A naive-UTC instant as the server's naive wall-clock time, in which deadline days are counted."""
    if eta is None:
        return None
    return eta.replace(tzinfo=timezone.utc).astimezone(tz if tz is not None else server_tz()).replace(tzinfo=None)


def eta_is_late(eta: datetime | None, due: datetime | None, tz: tzinfo | None = None) -> bool:
    """The forecast lands after the end of the deadline day; no forecast or no deadline is never late."""
    if eta is None or due is None:
        return False
    return server_wall_time(eta, tz) >= datetime.combine(due.date(), datetime.min.time()) + timedelta(days=1)


def attention_reason(
    due: datetime | None, eta: datetime | None, start_of_today: datetime, tz: tzinfo | None = None
) -> AttentionReason | None:
    """Why an ACTIVE order needs attention, or None. «Overdue» is the orders
    summary's rule — due before the start of today; a deadline of today is not
    overdue yet."""
    if due is None:
        return "no_due"
    if due < start_of_today:
        return "overdue"
    if eta_is_late(eta, due, tz):
        return "late_eta"
    return None
