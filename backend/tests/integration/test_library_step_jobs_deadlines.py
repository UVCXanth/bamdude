"""One absolute first-wait deadline covers everything before a STEP job's admission (spec §4.1, Codex A-R3): its
prechecks, the source's stat on a slow share, the bundle lookup and the slot. A job whose stat returns after that
deadline never starts CAD; a stat that never returns gives the user the job's terminal on time while its owned I/O
goes on, starts no other reader on the share, and keeps a stop from claiming a proof."""

from __future__ import annotations

import asyncio
import threading
from contextlib import asynccontextmanager
from pathlib import Path

import pytest

from backend.app.services import library_preview_jobs as j, preview_runtime as r


class Checks:
    async def authority_holds(self, *args, **kwargs):
        return True

    async def source_holds(self, source):
        return True


async def _entered(event: threading.Event, seconds: float = 5.0) -> None:
    for _ in range(int(seconds / 0.01)):
        if event.is_set():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("barrier never entered")


async def _ended(receipt, seconds: float = 5.0) -> None:
    for _ in range(int(seconds / 0.01)):
        if not receipt.live:
            return
        await asyncio.sleep(0.01)
    raise AssertionError("receipt never ended")


def _source(tmp_path: Path, n: int = 1) -> j.StepSource:
    return j.StepSource(n, f"{n}.step", "step", str(tmp_path / f"{n}.step"), f"{n:x}" * 64, None, None)


@pytest.mark.asyncio
async def test_a_stat_returning_after_the_first_wait_never_admits_the_job(tmp_path, monkeypatch):
    started, release = threading.Event(), threading.Event()
    admissions = []

    def slow_stat(path):
        started.set()
        assert release.wait(5)
        return None

    @asynccontextmanager
    async def attempt(inputs, **kwargs):
        admissions.append(kwargs["on_admit"]())
        yield r.PreviewResult(outcome="render_failed")

    monkeypatch.setattr(j, "WAIT_BEFORE_START", 0.05)
    monkeypatch.setattr(j, "source_state", slow_stat)
    monkeypatch.setattr(r, "preview_attempt", attempt)
    jobs = j.LibraryPreviewJobs(checks=Checks())
    jobs.start()
    receipt = jobs.enqueue(_source(tmp_path), j.Authority.user(1), "manual")
    try:
        await _entered(started)
        await asyncio.sleep(0.2)
        release.set()
        await _ended(receipt)
        assert admissions == []  # the share answered too late: no CAD
        assert receipt.error_code == "expired_before_start"
    finally:
        release.set()
        await jobs.stop()


@pytest.mark.asyncio
async def test_a_bundle_lookup_slower_than_the_wait_takes_no_slot(tmp_path):
    runtime = r.PreviewRuntime(tmp_path / "runtime", app_dir=tmp_path / "app")
    await runtime.start()
    try:

        async def slow_descriptor():
            await asyncio.sleep(0.3)
            return {"manifest_digest": "a" * 64, "bundle_key": "win-x64-cp312"}

        runtime.cad_descriptor = slow_descriptor
        async with runtime.attempt({"mesh": (b"ISO-10303-21;", "step")}, wait_seconds=0.1) as result:
            assert result.outcome == "busy"
            assert not runtime.slot.locked()  # the lookup spent its wait: no admission, no command
    finally:
        await runtime.stop()


@pytest.mark.asyncio
async def test_a_stat_that_never_returns_ends_the_job_on_time_and_starts_no_other_reader(tmp_path, monkeypatch):
    stuck, release = threading.Event(), threading.Event()
    stats = []

    def hung_stat(path):
        stats.append(path)
        if len(stats) == 1:
            stuck.set()
            assert release.wait(30)
        return None

    @asynccontextmanager
    async def attempt(inputs, **kwargs):
        kwargs["on_admit"]()
        yield r.PreviewResult(outcome="render_failed")

    monkeypatch.setattr(j, "WAIT_BEFORE_START", 0.3)
    monkeypatch.setattr(j, "STUCK_MARGIN", 0.2)
    monkeypatch.setattr(j, "WATCH_TICK", 0.05)
    monkeypatch.setattr(j, "source_state", hung_stat)
    monkeypatch.setattr(r, "preview_attempt", attempt)
    jobs = j.LibraryPreviewJobs(checks=Checks())
    jobs.start()
    first = jobs.enqueue(_source(tmp_path, 1), j.Authority.user(1), "manual")
    second = jobs.enqueue(_source(tmp_path, 2), j.Authority.user(1), "manual")
    stopping = None
    try:
        await _entered(stuck)
        await _ended(first, seconds=3)
        assert first.error_code == "expired_before_start"  # the user's terminal, on time
        await _ended(second, seconds=3)
        assert second.error_code == "expired_before_start"  # the queue behind it ends on time too
        assert len(stats) == 1  # no second reader on the hung share
        stopping = asyncio.ensure_future(jobs.stop("shutdown"))
        done, _ = await asyncio.wait({stopping}, timeout=0.3)
        assert not done  # its owned I/O still runs: no proof yet
    finally:
        release.set()
        stopping = stopping or asyncio.ensure_future(jobs.stop("shutdown"))
        assert await stopping is True  # the share answered: the stuck attempt's end is proven


@pytest.mark.asyncio
async def test_a_retry_whose_stat_hangs_past_the_wall_ends_job_expired(tmp_path, monkeypatch):
    stuck, release = threading.Event(), threading.Event()
    stats = []

    def stat(path):
        stats.append(path)
        if len(stats) == 2:  # the retry after a preemption meets a hung share
            stuck.set()
            assert release.wait(30)
        return None

    @asynccontextmanager
    async def attempt(inputs, **kwargs):
        kwargs["on_admit"]()
        yield r.PreviewResult(outcome="preempted")

    monkeypatch.setattr(j, "WALL_SECONDS", 0.3)
    monkeypatch.setattr(j, "STUCK_MARGIN", 0.2)
    monkeypatch.setattr(j, "WATCH_TICK", 0.05)
    monkeypatch.setattr(j, "source_state", stat)
    monkeypatch.setattr(r, "preview_attempt", attempt)
    jobs = j.LibraryPreviewJobs(checks=Checks())
    jobs.start()
    receipt = jobs.enqueue(_source(tmp_path), j.Authority.user(1), "manual")
    try:
        await _entered(stuck)
        await _ended(receipt, seconds=3)
        assert receipt.error_code == "job_expired"  # the wall runs from the first admission, retries included
    finally:
        release.set()
        assert await jobs.stop() is True
