"""Deadlines against the forecast — the ONE late rule (spec workshop-order-views, rule 16).

A deadline is a day (stored at midnight); the forecast's ``now_eta`` is an
instant. «Late» = the forecast lands after the END of the deadline day. The
deadlines board asks this module both for each card's flag and for why an
order needs attention, so the two can never disagree.
"""

from datetime import datetime, timedelta
from typing import Literal

AttentionReason = Literal["overdue", "late_eta", "no_due"]
ATTENTION_ORDER: tuple[AttentionReason, ...] = ("overdue", "late_eta", "no_due")


def eta_is_late(eta: datetime | None, due: datetime | None) -> bool:
    """The forecast lands after the end of the deadline day; no forecast or no deadline is never late."""
    if eta is None or due is None:
        return False
    return eta >= datetime.combine(due.date(), datetime.min.time()) + timedelta(days=1)


def attention_reason(due: datetime | None, eta: datetime | None, start_of_today: datetime) -> AttentionReason | None:
    """Why an ACTIVE order needs attention, or None. «Overdue» is the orders
    summary's rule — due before the start of today; a deadline of today is not
    overdue yet."""
    if due is None:
        return "no_due"
    if due < start_of_today:
        return "overdue"
    if eta_is_late(eta, due):
        return "late_eta"
    return None
