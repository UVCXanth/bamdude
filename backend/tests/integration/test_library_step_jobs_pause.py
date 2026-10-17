"""A backup pausing the library's pictures and the STEP jobs (Codex A-r3, the owner's choice (b)): a STEP that cannot
publish is DEFERRED — requeued with its order, never counted as a preemption — and while the pictures are paused no
attempt starts: the runner waits without a preview slot, a session or a lease, and a restore's close or a stop
ends that wait. Waiting spends no active budget, while nothing already spent is reset: the first-wait and wall
limits keep running, and a job whose limit passes during the backup says so (``backup_in_progress``), never that
its file is at fault."""

from __future__ import annotations

import asyncio
import time

import pytest

from backend.app.services import library_preview_jobs as j
from backend.app.services.library_preview import PublicationGate

pytestmark = pytest.mark.integration


class Checks:
    async def authority_holds(self, *args, **kwargs):
        return True

    async def source_holds(self, source):
        return True


class Backup:
    """A backup holding the pictures paused until ``lift()``."""

    def __init__(self, gate: PublicationGate):
        self.gate, self.entered, self.lifted, self.task = gate, asyncio.Event(), asyncio.Event(), None

    async def begin(self) -> Backup:
        self.task = asyncio.create_task(self._hold())
        await self.entered.wait()
        return self

    async def _hold(self):
        async with self.gate.pause(1):
            self.entered.set()
            await self.lifted.wait()

    async def lift(self):
        self.lifted.set()
        if self.task is not None:
            await self.task


def _source(n: int = 1) -> j.StepSource:
    return j.StepSource(n, f"{n}.step", "step", f"library/{n}.step", f"{n:x}" * 64, None, None)


async def _until(predicate, seconds: float = 10.0):
    for _ in range(int(seconds / 0.01)):
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("condition never reached")


def _jobs(gate, perform, **kwargs) -> j.LibraryPreviewJobs:
    jobs = j.LibraryPreviewJobs(perform=perform, checks=Checks(), publication=gate, **kwargs)
    jobs.start()
    return jobs


@pytest.mark.asyncio
async def test_a_deferred_step_is_requeued_without_a_preemption_and_nothing_runs_while_paused():
    gate = PublicationGate()
    backups, calls = [], []

    async def perform(source, *, order, wait_seconds, on_admit, on_hand_off, before_attach):
        calls.append(gate.paused())
        on_admit()
        if len(calls) == 1:
            backups.append(await Backup(gate).begin())  # the backup began while this STEP converted
            return "publication_deferred"
        return "succeeded"

    jobs = _jobs(gate, perform)
    receipt = jobs.enqueue(_source(), j.Authority.user(1), "manual")
    try:
        await _until(lambda: backups and receipt.state == "queued")
        await asyncio.sleep(0.3)
        assert calls == [False] and receipt.execution.preemptions == 0  # no hot loop, no quota spent
        await backups[0].lift()
        await _until(lambda: not receipt.live)
        assert (receipt.state, receipt.error_code, calls) == ("succeeded", None, [False, False])
    finally:
        for backup in backups:
            await backup.lift()
        await jobs.stop()


@pytest.mark.asyncio
async def test_a_paused_gate_holds_a_new_job_before_it_reads_anything():
    gate = PublicationGate()
    calls = []

    async def perform(source, **kwargs):
        calls.append(gate.paused())
        kwargs["on_admit"]()
        return "succeeded"

    backup = await Backup(gate).begin()
    jobs = _jobs(gate, perform)
    receipt = jobs.enqueue(_source(), j.Authority.user(1), "manual")
    try:
        await asyncio.sleep(0.3)
        assert calls == [] and receipt.state == "queued"  # no stat, no slot, no conversion during the backup
        await backup.lift()
        await _until(lambda: not receipt.live)
        assert receipt.state == "succeeded" and calls == [False]
    finally:
        await backup.lift()
        await jobs.stop()


@pytest.mark.asyncio
async def test_repeated_pauses_neither_spin_nor_exhaust_the_preemption_quota():
    gate = PublicationGate()
    backups, calls = [], []

    async def perform(source, *, order, wait_seconds, on_admit, on_hand_off, before_attach):
        calls.append(gate.paused())
        on_admit()
        if len(calls) <= j.PREEMPTION_LIMIT + 1:
            backups.append(await Backup(gate).begin())
            return "publication_deferred"
        return "succeeded"

    jobs = _jobs(gate, perform)
    receipt = jobs.enqueue(_source(), j.Authority.user(1), "manual")
    try:
        for n in range(1, j.PREEMPTION_LIMIT + 2):
            await _until(lambda n=n: len(backups) == n and receipt.state == "queued")
            await asyncio.sleep(0.1)
            assert len(calls) == n  # one attempt per backup, none while it holds
            await backups[-1].lift()
        await _until(lambda: not receipt.live)
        assert receipt.state == "succeeded" and receipt.execution.preemptions == 0
    finally:
        for backup in backups:
            await backup.lift()
        await jobs.stop()


@pytest.mark.asyncio
async def test_the_wait_for_a_backup_spends_no_active_budget_and_resets_nothing(monkeypatch):
    gate = PublicationGate()
    now = [1000.0]
    seen, backups = [], []

    async def perform(source, *, order, wait_seconds, on_admit, on_hand_off, before_attach):
        execution = receipt.execution
        seen.append((execution.active_used, execution.first_admission))
        on_admit()
        if len(seen) == 1:
            now[0] += 5.0  # five seconds of conversion
            backups.append(await Backup(gate).begin())
            return "publication_deferred"
        return "succeeded"

    monkeypatch.setattr(j, "WATCH_TICK", 0.01)
    jobs = _jobs(gate, perform, clock=lambda: now[0])
    receipt = jobs.enqueue(_source(), j.Authority.user(1), "manual")
    try:
        await _until(lambda: backups and receipt.state == "queued")
        now[0] += 100.0  # a long backup
        await asyncio.sleep(0.1)
        await backups[0].lift()
        await _until(lambda: not receipt.live)
        assert seen == [(0.0, None), (5.0, 1000.0)]  # the conversion counted, the wait did not; nothing reset
        assert receipt.state == "succeeded"
    finally:
        for backup in backups:
            await backup.lift()
        await jobs.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("limit", ["first_wait", "wall"])
async def test_a_job_whose_limit_passes_during_the_backup_names_the_backup(monkeypatch, limit):
    gate = PublicationGate()
    now = [1000.0]
    backups = []

    async def perform(source, *, order, wait_seconds, on_admit, on_hand_off, before_attach):
        on_admit()
        backups.append(await Backup(gate).begin())
        return "publication_deferred"

    monkeypatch.setattr(j, "WATCH_TICK", 0.01)
    if limit == "first_wait":
        backups.append(await Backup(gate).begin())  # the backup was there before the job
    jobs = _jobs(gate, perform, clock=lambda: now[0])
    receipt = jobs.enqueue(_source(), j.Authority.user(1), "manual")
    try:
        await _until(lambda: backups and gate.paused() and receipt.state == "queued")
        await asyncio.sleep(0.1)  # the runner holds the job for the backup when its limit passes
        now[0] += (j.WAIT_BEFORE_START if limit == "first_wait" else j.WALL_SECONDS) + 1
        await _until(lambda: not receipt.live)
        assert (receipt.state, receipt.error_code) == ("failed", "backup_in_progress")
    finally:
        for backup in backups:
            await backup.lift()
        await jobs.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("ending", ["restore_close", "stop"])
async def test_a_restore_or_a_stop_ends_the_wait_without_an_attempt(ending):
    gate = PublicationGate()
    calls = []

    async def perform(source, **kwargs):
        calls.append(1)
        return "succeeded"

    backup = await Backup(gate).begin()
    jobs = _jobs(gate, perform)
    receipt = jobs.enqueue(_source(), j.Authority.user(1), "manual")
    try:
        await asyncio.sleep(0.2)
        if ending == "restore_close":
            gate.close()  # nothing can be published again in this process: no attempt starts
            await backup.lift()  # nor once the backup is over: the gate stays closed
            await asyncio.sleep(0.3)
            assert calls == [] and receipt.state == "queued"
        started = time.monotonic()
        assert await asyncio.wait_for(jobs.stop("restore" if ending == "restore_close" else "shutdown"), 5)
        assert time.monotonic() - started < 3 and receipt.state == "canceled" and calls == []
    finally:
        await backup.lift()


@pytest.mark.asyncio
async def test_a_closed_gate_starts_no_attempt_even_without_a_backup():
    """A restore closed the pictures for good: nothing could be published, so nothing is converted while the
    stop that follows the close is on its way."""
    gate = PublicationGate()
    gate.close()
    calls = []

    async def perform(source, **kwargs):
        calls.append(1)
        return "succeeded"

    jobs = _jobs(gate, perform)
    receipt = jobs.enqueue(_source(), j.Authority.user(1), "manual")
    try:
        await asyncio.sleep(0.3)
        assert calls == [] and receipt.state == "queued"
    finally:
        assert await asyncio.wait_for(jobs.stop("restore"), 5)
    assert receipt.state == "canceled"


@pytest.mark.requires_cad
@pytest.mark.asyncio
async def test_a_healthy_step_converted_during_a_long_backup_is_deferred_not_failed(tmp_path, monkeypatch):
    """The real CAD chain (Opus probe after A-r2): the picture is ready when the backup begins and the backup
    outlasts the job's active budget; the job is deferred, then succeeds once the pictures are released."""
    from backend.app.services import preview_runtime as r
    from backend.app.step_runtime import PROBE_STEP
    from backend.tests.cad_lane import cad_app_dir
    from backend.tests.unit.services.test_preview_priority import _Pause, _pause_when_the_run_is_sent
    from backend.tests.unit.services.test_preview_step_ownership import _warm

    rt = r.PreviewRuntime(tmp_path / "runtime", app_dir=cad_app_dir())
    await rt.start()
    await _warm(rt)  # the shortened budget is the STEP's, not a fresh runtime's one-time font cache (macOS: >20 s)
    monkeypatch.setattr(r, "runtime", rt)
    monkeypatch.setattr(r, "_stopping", None)
    monkeypatch.setattr(j, "ACTIVE_SECONDS", 20.0)
    gate = PublicationGate()
    pause = _Pause(gate)
    _pause_when_the_run_is_sent(rt, pause)
    outcomes = []

    async def perform(source, *, order, wait_seconds, on_admit, on_hand_off, before_attach):
        async with r.preview_attempt(
            {"mesh": (PROBE_STEP, "step")},
            priority="low",
            wait_seconds=wait_seconds,
            order=order,
            on_admit=on_admit,
            on_hand_off=on_hand_off,
            publication=gate,
        ) as result:
            outcomes.append(result.outcome)
            return "succeeded" if result.outcome == "ok" and result.publishable else result.outcome

    jobs = _jobs(gate, perform)
    receipt = jobs.enqueue(_source(), j.Authority.user(1), "manual")
    try:
        await asyncio.wait_for(pause.entered.wait(), 60)
        await _until(lambda: outcomes == ["publication_deferred"], 60)
        await asyncio.sleep(j.ACTIVE_SECONDS + 2)  # the backup outlasts the whole active budget
        assert receipt.live and receipt.state == "queued" and not rt.slot.locked()
        await pause.lift()
        await _until(lambda: not receipt.live, 60)
        assert (receipt.state, outcomes, receipt.execution.preemptions) == (
            "succeeded",
            ["publication_deferred", "ok"],
            0,
        )
    finally:
        await pause.lift()
        await jobs.stop()
        await rt.stop()
