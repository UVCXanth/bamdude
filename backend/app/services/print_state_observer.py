"""One read-only background pass over the farm's print-state rows (spec printer-runtime-stall r3 R5).

Every ``interval`` seconds it reads ONE page of ``print_state_recovery_store.list_issues_page`` -- the same
reader Info uses -- and continues with the next page on the next tick, round-robin, so a large farm is walked
in turn rather than its first printers every time. Its cache feeds the short System Health mention and the
support bundle; Info itself always reads fresh. It repairs nothing and opens no printer session.

What it can vouch for is part of its answer: when it last read, whether a whole cycle has completed, which
printers it has seen, and whether the last read failed -- an incomplete pass is never "no problems". A session
lives for one page read only. One tick runs at a time; missed ticks are not made up.
"""

from __future__ import annotations

import asyncio
import logging
from collections import Counter
from datetime import datetime, timezone

from backend.app.core import database
from backend.app.services import print_state_recovery_store as store, queue_sources

logger = logging.getLogger(__name__)

DEFAULT_INTERVAL_SECONDS = 15.0


class PrintStateObserver:
    def __init__(self, *, session_factory=None, interval: float = DEFAULT_INTERVAL_SECONDS):
        self._session_factory = session_factory
        self._interval = interval
        self._task: asyncio.Task | None = None
        self._reset()

    def _reset(self) -> None:
        self._epoch = queue_sources.current_epoch()
        self._cursor: str | None = None
        self._cache: dict[int, list[dict]] = {}
        self._checked: dict[int, datetime] = {}
        self._cycle_seen: set[int] = set()
        self._cycle_complete = False
        self._checked_at: datetime | None = None
        self._error: str | None = None

    def _check_epoch(self) -> None:
        # A restore replaced the database: nothing read before it describes this farm.
        if queue_sources.current_epoch() != self._epoch:
            self._reset()

    def _factory(self):
        return self._session_factory or database.async_session

    async def tick(self) -> None:
        """Read one page and fold it into the cache."""
        self._check_epoch()
        try:
            async with self._factory()() as db:
                page, pids = await store.list_issues_page(db, None, cursor=self._cursor)
        except Exception:  # noqa: BLE001 - an unreadable page is reported, never a crash of the loop
            logger.warning("print-state observer could not read a page", exc_info=True)
            self._error = "unavailable"
            self._cursor = None
            self._cycle_seen = set()
            self._cycle_complete = False
            return
        now = datetime.now(timezone.utc)
        if self._cursor is None:
            self._cycle_seen = set()  # a new cycle begins at the first printer
        found: dict[int, list[dict]] = {pid: [] for pid in pids}
        for issue in page["issues"]:
            found.setdefault(issue["printer_id"], []).append(issue)
        for pid, issues in found.items():
            # A printer whose rows continue on the next page is extended, not replaced.
            self._cache[pid] = self._cache.get(pid, []) + issues if pid in self._cycle_seen else issues
            self._checked[pid] = now
        self._cycle_seen.update(found)
        self._checked_at = now
        self._error = None
        self._cursor = page["next_cursor"]
        if self._cursor is None:
            for pid in list(self._cache):
                if pid not in self._cycle_seen:  # deleted, or no longer in the farm
                    self._cache.pop(pid, None)
                    self._checked.pop(pid, None)
            self._cycle_complete = True

    def summary(self, scope) -> dict:
        """What the cache says, narrowed to the caller's printer scope (``None`` = every printer)."""
        self._check_epoch()
        by_code: Counter = Counter()
        observations: Counter = Counter()
        printers = []
        for pid in sorted(self._cache):
            if scope is not None and pid not in scope:
                continue
            # An observation (a phase still under way, a stall that went quiet) is shown in Info, never counted
            # as a problem here.
            observations.update(issue["code"] for issue in self._cache[pid] if issue.get("observation"))
            issues = [issue for issue in self._cache[pid] if not issue.get("observation")]
            if not issues:
                continue
            by_code.update(issue["code"] for issue in issues)
            printers.append({"printer_id": pid, "codes": sorted({issue["code"] for issue in issues})})
        checked = sorted(pid for pid in self._checked if scope is None or pid in scope)
        from backend.app.services import dispatch_stall_tracker

        return {
            "by_code": dict(by_code),
            "observations": dict(observations),
            "stall_tracking": dispatch_stall_tracker.coverage_view(),
            "printers": printers,
            "checked_at": self._checked_at,
            "error": self._error,
            "coverage": {
                "cycle_complete": self._cycle_complete,
                "truncated": not self._cycle_complete,
                "checked": len(checked),
                "printer_ids": checked,
            },
        }

    def public_summary(self, scope) -> dict:
        """The summary as it may leave the process: counts and codes, never the list of printers checked."""
        summary = self.summary(scope)
        coverage = {k: v for k, v in summary["coverage"].items() if k != "printer_ids"}
        checked_at = summary["checked_at"]
        return {**summary, "coverage": coverage, "checked_at": checked_at.isoformat() if checked_at else None}

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run(), name="print-state-observer")

    async def stop(self) -> None:
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def _run(self) -> None:
        while True:
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                logger.warning("print-state observer tick failed", exc_info=True)
            await asyncio.sleep(self._interval)


print_state_observer = PrintStateObserver()
