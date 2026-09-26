from datetime import datetime, timedelta, timezone

from backend.app.services.order_deadlines import attention_reason, eta_is_late, server_wall_time

DUE = datetime(2026, 10, 5)  # a deadline is a day, stored at midnight
UTC = timezone.utc
KYIV = timezone(timedelta(hours=3))
NEW_YORK = timezone(timedelta(hours=-5))


def test_late_means_after_the_end_of_the_deadline_day():
    assert eta_is_late(datetime(2026, 10, 5, 23, 59), DUE, tz=UTC) is False
    assert eta_is_late(datetime(2026, 10, 6, 0, 0), DUE, tz=UTC) is True
    assert eta_is_late(None, DUE, tz=UTC) is False and eta_is_late(datetime(2026, 12, 1), None, tz=UTC) is False


def test_the_deadline_day_is_the_servers_calendar_day_not_the_utc_one():
    # The forecast is a naive UTC instant; a deadline and «today» are days of the
    # server's own calendar. 22:30 UTC on the deadline day is 01:30 NEXT day in Kyiv…
    assert eta_is_late(datetime(2026, 10, 5, 22, 30), DUE, tz=KYIV) is True
    # …and 02:00 UTC the day after is still 21:00 ON the deadline day in New York.
    assert eta_is_late(datetime(2026, 10, 6, 2, 0), DUE, tz=NEW_YORK) is False
    assert server_wall_time(datetime(2026, 10, 5, 22, 30), tz=KYIV) == datetime(2026, 10, 6, 1, 30)
    assert server_wall_time(None, tz=KYIV) is None


def test_attention_reasons_in_their_order():
    today = datetime(2026, 10, 10)
    assert attention_reason(datetime(2026, 10, 9), None, today, tz=UTC) == "overdue"
    assert attention_reason(datetime(2026, 10, 12), datetime(2026, 10, 14), today, tz=UTC) == "late_eta"
    assert attention_reason(None, None, today, tz=UTC) == "no_due"
    assert attention_reason(datetime(2026, 10, 12), datetime(2026, 10, 11), today, tz=UTC) is None
    assert attention_reason(datetime(2026, 10, 10), None, today, tz=UTC) is None  # due today is not overdue yet
    # The same local-day rule as the card: a finish after local midnight is late.
    assert attention_reason(datetime(2026, 10, 12), datetime(2026, 10, 12, 22, 30), today, tz=KYIV) == "late_eta"
