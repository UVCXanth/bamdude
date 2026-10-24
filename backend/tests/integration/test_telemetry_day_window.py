"""The day the anonymous telemetry snapshot describes (telemetry-day-window spec T01–T09).

A snapshot's ``usage`` counts the archives created on ONE calendar day of the server's own zone
(``core.timezones.server_timezone``: ``TZ``, UTC when it is unset or unusable), and its
``snapshot_date`` names that same day. The moment is read once, through ``telemetry._utc_now``;
the day's bounds are UTC instants, half-open, and the same for all three counters.

These tests drive that one seam and refuse every other clock: a naive ``date.today()`` or
``datetime.now()`` in the telemetry module raises, so does ``core.timezones.start_of_today``
(a helper with a clock of its own), and an instant built by ``_moment`` refuses to be read in
the OS's own zone. Archives carry an explicit ``created_at`` — never the server default — so no
test depends on the hour it runs at. PostgreSQL runs the same bodies through
``test_telemetry_day_window_on_postgres.py``.
"""

from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import event

from backend.app.core import timezones
from backend.app.models.archive import PrintArchive
from backend.app.services import telemetry
from backend.app.utils.failure_reasons import DISPATCH_NO_ACKNOWLEDGEMENT

US = timedelta(microseconds=1)


class _Moment(datetime):
    """An aware UTC moment that refuses to be read in the OS's own zone — the OS date is no source."""

    def astimezone(self, tz=None):
        if tz is None:
            raise AssertionError("the telemetry day was read in the OS's own zone")
        return super().astimezone(tz)


class _NoToday(date):
    @classmethod
    def today(cls):
        raise AssertionError("a naive date.today() was read")


class _NoNow(datetime):
    @classmethod
    def now(cls, tz=None):
        raise AssertionError("a clock other than telemetry._utc_now was read")

    @classmethod
    def utcnow(cls):
        raise AssertionError("a naive datetime.utcnow() was read")

    @classmethod
    def today(cls):
        raise AssertionError("a naive datetime.today() was read")


def _refuse(*_args, **_kwargs):
    raise AssertionError("core.timezones.start_of_today reads a clock of its own")


class _Clock:
    """``telemetry._utc_now`` for a test: the moment it answers, and how often it was asked."""

    def __init__(self):
        self.now: datetime | None = None
        self.reads = 0

    def __call__(self) -> datetime:
        self.reads += 1
        return self.now


def _moment(text: str) -> _Moment:
    moment = _Moment.fromisoformat(text)
    assert moment.utcoffset() == timedelta(0)
    return moment


def _utc(text: str) -> datetime:
    return datetime.fromisoformat(text).replace(tzinfo=timezone.utc)


def _usage(n: int) -> dict:
    return {"prints_completed": n, "prints_failed": n, "dispatch_errors": n}


@pytest.fixture
def clock(monkeypatch):
    seam = _Clock()
    monkeypatch.setattr(telemetry, "_utc_now", seam)
    monkeypatch.setattr(telemetry, "get_install_id", lambda: "day-window")
    monkeypatch.setattr(telemetry, "_ams_unit_count", lambda: 0)
    monkeypatch.setattr(telemetry, "date", _NoToday, raising=False)
    monkeypatch.setattr(telemetry, "datetime", _NoNow, raising=False)
    monkeypatch.setattr(timezones, "start_of_today", _refuse)
    return seam


def _zone(monkeypatch, name: str | None) -> None:
    if name is None:
        monkeypatch.delenv("TZ", raising=False)
    else:
        monkeypatch.setenv("TZ", name)


async def _prints(db, printer, *instants: datetime, status_dates: dict | None = None) -> None:
    """A completed print, a physical failure and a dispatch error created at each instant."""
    for instant in instants:
        created = instant.astimezone(timezone.utc).replace(tzinfo=None)
        for status, reason in (("completed", None), ("failed", None), ("failed", DISPATCH_NO_ACKNOWLEDGEMENT)):
            db.add(
                PrintArchive(
                    printer_id=printer.id,
                    filename="p.3mf",
                    print_name="p",
                    file_path="",
                    file_size=1,
                    status=status,
                    failure_reason=reason,
                    created_at=created,
                    **(status_dates or {}),
                )
            )
    await db.commit()


async def test_kyiv_just_after_local_midnight_counts_the_new_day(db_session, printer_factory, clock, monkeypatch):
    """T01: 00:40 in Kyiv is 21:40 UTC the evening before — a print made then is today's."""
    _zone(monkeypatch, "Europe/Kyiv")
    clock.now = _moment("2026-10-23T21:40:00+00:00")
    printer = await printer_factory()
    await _prints(db_session, printer, _utc("2026-10-23T21:40:00"), _utc("2026-10-23T20:59:59"))

    payload = await telemetry._build_payload(db_session)

    assert payload["snapshot_date"] == "2026-10-24"
    assert payload["usage"] == _usage(1)


async def test_west_of_utc_after_utc_midnight_is_still_the_local_day_before(
    db_session, printer_factory, clock, monkeypatch
):
    """T02: 02:40 UTC is 19:40 the day before in Los Angeles; the local day before THAT is excluded."""
    _zone(monkeypatch, "America/Los_Angeles")
    clock.now = _moment("2026-10-24T02:40:00+00:00")
    printer = await printer_factory()
    await _prints(db_session, printer, _utc("2026-10-24T02:40:00"), _utc("2026-10-23T06:59:59"))

    payload = await telemetry._build_payload(db_session)

    assert payload["snapshot_date"] == "2026-10-23"
    assert payload["usage"] == _usage(1)


@pytest.mark.parametrize("tz", ["UTC", "", "Not/A_Zone", None], ids=["utc", "empty", "invalid", "unset"])
async def test_without_a_usable_tz_the_day_is_utc_never_the_os_date(
    db_session, printer_factory, clock, monkeypatch, tz
):
    """T03: UTC, and the UTC fallback of an empty, unknown or absent TZ — 22:30 UTC is already the next
    day at UTC+3, and the snapshot still names the UTC date (the instant refuses an OS-zone read)."""
    _zone(monkeypatch, tz)
    clock.now = _moment("2026-10-23T22:30:00+00:00")
    printer = await printer_factory()
    await _prints(db_session, printer, _utc("2026-10-23T22:30:00"), _utc("2026-10-24T00:00:00"))

    payload = await telemetry._build_payload(db_session)

    assert payload["snapshot_date"] == "2026-10-23"
    assert payload["usage"] == _usage(1)


@pytest.mark.parametrize(
    "created,counted",
    [
        ("2026-10-23T06:59:59.999999", False),  # the last instant of the local day before
        ("2026-10-23T07:00:00", True),  # local midnight, PDT
        ("2026-10-24T06:59:59.999999", True),  # the last instant of the day
        ("2026-10-24T07:00:00", False),  # the next local midnight
    ],
    ids=["start-1us", "start", "end-1us", "end"],
)
async def test_the_day_is_half_open_for_all_three_counters(
    db_session, printer_factory, clock, monkeypatch, created, counted
):
    """T04: [start, end) — the start is in, the next local midnight is not."""
    _zone(monkeypatch, "America/Los_Angeles")
    clock.now = _moment("2026-10-24T02:40:00+00:00")
    printer = await printer_factory()
    await _prints(db_session, printer, _utc(created))

    payload = await telemetry._build_payload(db_session)

    assert payload["snapshot_date"] == "2026-10-23"
    assert payload["usage"] == _usage(int(counted))


# (zone, a moment of the day, the day's first instant, the next day's first instant, both runs of a
# repeated local time) — literal UTC instants, so the test does not lean on core.timezones.day_bounds.
_DST_DAYS = {
    # Kyiv springs forward at 03:00: a 23-hour day.
    "kyiv-spring": ("Europe/Kyiv", "2026-03-29T09:00:00", "2026-03-28T22:00:00", "2026-03-29T21:00:00", ()),
    # Kyiv falls back at 04:00: 25 hours, and 03:30 happens twice (00:30 and 01:30 UTC).
    "kyiv-autumn": (
        "Europe/Kyiv",
        "2026-10-25T09:00:00",
        "2026-10-24T21:00:00",
        "2026-10-25T22:00:00",
        ("2026-10-25T00:30:00", "2026-10-25T01:30:00"),
    ),
    # Havana springs forward AT midnight: there is no 00:00, the day starts at 01:00 CDT.
    "havana-no-midnight": ("America/Havana", "2026-03-08T15:00:00", "2026-03-08T05:00:00", "2026-03-09T04:00:00", ()),
    # Havana falls back from 01:00 to midnight: 00:30 happens twice (04:30 and 05:30 UTC).
    "havana-midnight-twice": (
        "America/Havana",
        "2026-11-01T15:00:00",
        "2026-11-01T04:00:00",
        "2026-11-02T05:00:00",
        ("2026-11-01T04:30:00", "2026-11-01T05:30:00"),
    ),
}


def _dst_rows():
    for day, (_zone_name, _now, start, end, repeated) in _DST_DAYS.items():
        first, after = _utc(start), _utc(end)
        rows = [("start-1us", first - US, False), ("start", first, True), ("end-1us", after - US, True)]
        rows += [("end", after, False)] + [(f"repeated-{n}", _utc(t), True) for n, t in enumerate(repeated, 1)]
        for name, created, counted in rows:
            yield pytest.param(day, created, counted, id=f"{day}-{name}")


@pytest.mark.parametrize("day,created,counted", list(_dst_rows()))
async def test_a_dst_day_has_its_real_bounds(db_session, printer_factory, clock, monkeypatch, day, created, counted):
    """T05: a 23- or 25-hour day keeps its real first and last instants, and each run of a repeated
    local hour belongs to that day — row by row, so a lost start cannot hide behind a captured end."""
    zone, now = _DST_DAYS[day][:2]
    _zone(monkeypatch, zone)
    clock.now = _moment(f"{now}+00:00")
    printer = await printer_factory()
    await _prints(db_session, printer, created)

    payload = await telemetry._build_payload(db_session)

    assert payload["snapshot_date"] == now[:10]
    assert payload["usage"] == _usage(int(counted))


async def test_the_clock_is_read_once_even_when_it_crosses_midnight_mid_build(
    db_session, test_engine, printer_factory, clock, monkeypatch
):
    """T06: the clock jumps past midnight right after the first SQL statement; the key and all three
    counters still describe the day the build began on."""
    _zone(monkeypatch, "UTC")
    clock.now = _moment("2026-10-23T23:59:59+00:00")
    printer = await printer_factory()
    await _prints(db_session, printer, _utc("2026-10-23T12:00:00"), _utc("2026-10-24T00:30:00"))

    def midnight_passes(*_args, **_kwargs):
        clock.now = _moment("2026-10-24T00:30:00+00:00")

    event.listen(test_engine.sync_engine, "before_cursor_execute", midnight_passes)
    try:
        payload = await telemetry._build_payload(db_session)
    finally:
        event.remove(test_engine.sync_engine, "before_cursor_execute", midnight_passes)

    assert payload["snapshot_date"] == "2026-10-23"
    assert payload["usage"] == _usage(1)
    assert clock.reads == 1


async def test_the_window_bounds_usage_only_never_the_totals(db_session, printer_factory, clock, monkeypatch):
    """T07: the archive totals count every archive, whatever day it was created on."""
    _zone(monkeypatch, "UTC")
    clock.now = _moment("2026-10-23T12:00:00+00:00")
    printer = await printer_factory()
    await _prints(db_session, printer, _utc("2026-10-23T08:00:00"), _utc("2026-10-20T08:00:00"))

    payload = await telemetry._build_payload(db_session)

    assert payload["usage"] == _usage(1)
    assert payload["counts"]["archives"] == 6
    assert payload["counts"]["archives_completed"] == 2


async def test_a_print_created_yesterday_and_finished_today_is_not_todays(
    db_session, printer_factory, clock, monkeypatch
):
    """T09: the window is created_at, as before — finishing today does not move yesterday's print."""
    _zone(monkeypatch, "UTC")
    clock.now = _moment("2026-10-23T12:00:00+00:00")
    printer = await printer_factory()
    await _prints(
        db_session,
        printer,
        _utc("2026-10-22T23:00:00"),
        status_dates={"completed_at": datetime(2026, 10, 23, 1, 0)},
    )

    payload = await telemetry._build_payload(db_session)

    assert payload["usage"] == _usage(0)
