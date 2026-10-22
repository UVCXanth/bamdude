"""«Dispatch errors» are counted apart and never in a print success or failure rate (post-rebuild D-R7, D10).

One set of predicates (``services/statistics/outcomes``) classifies every counted
archive as completed, physical failure, dispatch error or stopped. The web overview,
Failure Analysis and Telegram ``/stats`` read it, so they agree on the same rows —
including a legacy failed row with no reason (a plain ``NOT IN`` would lose it) and
an empty farm (no division by zero).
"""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock

import pytest
from httpx import AsyncClient

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]


async def a_farm(archive_factory, printer_factory):
    printer = await printer_factory(name="P")
    rows = [
        {"status": "completed"},
        {"status": "completed"},
        {"status": "failed", "failure_reason": None},  # legacy: a physical failure with no class
        {"status": "failed", "failure_reason": "layerShift"},
        {"status": "aborted", "failure_reason": "other"},
        {"status": "failed", "failure_reason": "dispatchUploadFailed"},
        {"status": "failed", "failure_reason": "dispatchAcceptedNotStarted"},
        {"status": "cancelled", "failure_reason": "userCancelled"},
        {"status": "skipped"},
        # Never counted: a legacy upload and a row in the trash.
        {"status": "archived"},
        {"status": "failed", "failure_reason": "dispatchInternalError", "deleted_at": datetime.now(timezone.utc)},
    ]
    for row in rows:
        await archive_factory(printer.id, **row)
    return printer


async def test_every_counted_archive_lands_in_exactly_one_class(db_session, archive_factory, printer_factory):
    from backend.app.services.statistics import outcomes

    await a_farm(archive_factory, printer_factory)

    counts = await outcomes.outcome_counts(db_session)

    assert counts.total == 9
    assert (counts.completed, counts.physical_failures, counts.dispatch_failures, counts.stopped) == (2, 3, 2, 2)
    assert counts.completed + counts.physical_failures + counts.dispatch_failures + counts.stopped == counts.total
    assert counts.success_rate == pytest.approx(40.0)  # 2 / (2 + 3), dispatch and stopped outside


async def test_an_empty_farm_has_a_zero_rate_not_a_division(db_session):
    from backend.app.services.statistics import outcomes

    counts = await outcomes.outcome_counts(db_session)
    assert counts.total == 0 and counts.success_rate == 0.0
    assert outcomes.failure_rate(0, 0) == 0.0


async def test_the_web_overview_and_failure_analysis_count_the_same_classes(
    async_client: AsyncClient, archive_factory, printer_factory
):
    await a_farm(archive_factory, printer_factory)

    overview = (await async_client.get("/api/v1/statistics/overview")).json()
    assert overview["total_prints"] == 9
    assert overview["successful_prints"] == 2
    assert overview["failed_prints"] == 3
    assert overview["dispatch_failed_prints"] == 2
    assert overview["cancelled_prints"] == 2

    analysis = (await async_client.get("/api/v1/statistics/failures")).json()
    assert analysis["failed_prints"] == 3
    assert analysis["dispatch_failed_prints"] == 2
    assert analysis["failure_rate"] == pytest.approx(60.0)  # 3 / (2 + 3)
    # The physical breakdown never shows a dispatch class.
    assert not set(analysis["failures_by_reason"]) & {"dispatchUploadFailed", "dispatchAcceptedNotStarted"}
    assert analysis["failures_by_reason"]["Unknown"] == 1  # the legacy row is kept


async def test_telegram_stats_say_what_the_web_says(
    db_session, archive_factory, printer_factory, monkeypatch, async_client: AsyncClient
):
    from backend.app.core import database
    from backend.app.services.telegram_handlers import stats

    await a_farm(archive_factory, printer_factory)
    overview = (await async_client.get("/api/v1/statistics/overview")).json()

    class Session:
        async def __aenter__(self):
            return db_session

        async def __aexit__(self, *exc):
            return False

    monkeypatch.setattr(database, "async_session", lambda: Session())
    monkeypatch.setattr(stats, "has_perm", lambda *_: True)
    monkeypatch.setattr(stats, "get_language", AsyncMock(return_value="en"))
    message = AsyncMock()

    await stats.render_stats(message)

    text = message.answer.await_args.args[0]
    rate = round(overview["successful_prints"] / (overview["successful_prints"] + overview["failed_prints"]) * 100)
    assert f"Total prints: {overview['total_prints']}" in text
    assert f"Successful: {overview['successful_prints']}" in text
    assert f"Failed: {overview['failed_prints']}" in text
    assert f"Stopped or cancelled: {overview['cancelled_prints']}" in text
    assert f"Dispatch errors: {overview['dispatch_failed_prints']}" in text
    assert f"Success rate: {rate}%" in text
