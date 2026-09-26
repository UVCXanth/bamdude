from datetime import datetime

from backend.app.services.order_deadlines import attention_reason, eta_is_late

DUE = datetime(2026, 10, 5)  # a deadline is a day, stored at midnight


def test_late_means_after_the_end_of_the_deadline_day():
    assert eta_is_late(datetime(2026, 10, 5, 23, 59), DUE) is False
    assert eta_is_late(datetime(2026, 10, 6, 0, 0), DUE) is True
    assert eta_is_late(None, DUE) is False and eta_is_late(datetime(2026, 12, 1), None) is False


def test_attention_reasons_in_their_order():
    today = datetime(2026, 10, 10)
    assert attention_reason(datetime(2026, 10, 9), None, today) == "overdue"
    assert attention_reason(datetime(2026, 10, 12), datetime(2026, 10, 14), today) == "late_eta"
    assert attention_reason(None, None, today) == "no_due"
    assert attention_reason(datetime(2026, 10, 12), datetime(2026, 10, 11), today) is None
    assert attention_reason(datetime(2026, 10, 10), None, today) is None  # due today is not overdue yet
