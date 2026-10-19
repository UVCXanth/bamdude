"""The bounded, volatile STEP thumbnail queue (spec §4.1–§4.3, plan A4) on a virtual clock: one execution per source
fingerprint with a receipt per actor, Q pending, budgets from the FIRST admission (active 120 s cumulative, wall
600 s) and a separate 1800 s wait before it, at most three preemptions, user/shutdown causes that a preemption
never overwrites, and a jobs epoch of its own. ``perform`` is scripted; the real chain is in the integration tests."""

from __future__ import annotations

import asyncio
from datetime import datetime

import pytest

from backend.app.services import library_preview_jobs as jobs_module
from backend.app.services.library_preview_jobs import (
    ACTIVE_SECONDS,
    PREEMPTION_LIMIT,
    QUEUE_LIMIT,
    TERMINAL_RECEIPTS,
    TERMINAL_TTL,
    WAIT_BEFORE_START,
    WALL_SECONDS,
    Authority,
    EpochExpired,
    LibraryPreviewJobs,
    Refusal,
    StepSource,
)

ALICE, BOB = Authority.user(1), Authority.user(2)


def source(n: int = 1, **changes) -> StepSource:
    values = {
        "id": n,
        "filename": f"part{n}.step",
        "file_type": "step",
        "file_path": f"library/part{n}.step",
        "file_hash": f"{n:064x}",
        "fs_modified_at": datetime(2026, 10, 16, 12, 0, 0),
        "thumbnail_path": None,
    }
    values.update(changes)
    return StepSource(**values)


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.now += max(0.0, seconds)
        await asyncio.sleep(0)


class Script:
    """perform() as a script: each call pops the next step (default: admit, 1 s of work, succeeded)."""

    def __init__(self, clock: Clock):
        self.clock, self.steps, self.calls = clock, [], []
        self.gate: asyncio.Event | None = None

    def then(self, outcome: str, *, active: float = 1.0, admit: bool = True, hand_off: bool | None = None, wait=0.0):
        self.steps.append((outcome, active, admit, outcome == "succeeded" if hand_off is None else hand_off, wait))
        return self

    async def __call__(self, source, *, order, wait_seconds, on_admit, on_hand_off, before_attach):
        outcome, active, admit, hand_off, wait = self.steps.pop(0) if self.steps else ("succeeded", 1.0, True, True, 0)
        self.calls.append({"source": source.id, "order": order, "wait_seconds": wait_seconds})
        if wait:
            await self.clock.sleep(wait)
        if not admit:
            return outcome
        deadline_ns = on_admit()
        self.calls[-1]["deadline_ns"] = deadline_ns
        if self.gate is not None:
            await self.gate.wait()
        await self.clock.sleep(active)
        if hand_off:
            on_hand_off()
            if outcome == "succeeded" and not await before_attach():
                return "authority_missing"
        return outcome


class Checks:
    def __init__(self):
        self.revoked: set = set()
        self.gone: set[int] = set()

    async def authority_holds(self, authority, purpose, session=None) -> bool:
        return authority not in self.revoked

    async def source_holds(self, source) -> bool:
        return source.id not in self.gone


@pytest.fixture
async def service():
    clock = Clock()
    script = Script(clock)
    checks = Checks()
    jobs = LibraryPreviewJobs(perform=script, checks=checks, clock=clock, sleep=clock.sleep)
    jobs.start()
    jobs.test = (clock, script, checks)
    try:
        yield jobs
    finally:
        await jobs.stop("shutdown")


async def settled(jobs, *receipts, rounds: int = 200):
    for _ in range(rounds):
        if all(r.state in {"succeeded", "failed", "canceled"} for r in receipts):
            return
        await asyncio.sleep(0)
    raise AssertionError([(r.state, r.error_code) for r in receipts])


async def drained(jobs, rounds: int = 200):
    """Nothing pending any more: every execution reached its terminal (none still runs or waits to)."""
    for _ in range(rounds):
        if not jobs._pending:
            return
        await asyncio.sleep(0)
    raise AssertionError([(e.state, e.cause) for e in jobs._pending.values()])


# --- admission ------------------------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_step_job_succeeds_and_its_receipt_says_so(service):
    receipt = service.enqueue(source(), ALICE, "manual")
    assert receipt.state == "queued"
    await settled(service, receipt)
    assert (receipt.state, receipt.error_code) == ("succeeded", None)
    assert service.describe(receipt) == {
        "receipt_id": receipt.id,
        "file_id": 1,
        "state": "succeeded",
        "error_code": None,
    }


@pytest.mark.parametrize(
    ("changes", "authority", "code"),
    [
        ({"file_hash": None}, ALICE, "source_unverified"),
        ({"file_hash": "not-a-sha"}, ALICE, "source_unverified"),
        ({"file_type": "stl"}, ALICE, "protocol_error"),
        ({}, None, "authority_missing"),  # no descriptor is never the system
    ],
)
def test_what_is_refused_at_the_door(changes, authority, code):
    jobs = LibraryPreviewJobs(perform=Script(Clock()), checks=Checks())
    jobs.open = True
    with pytest.raises(Refusal) as refused:
        jobs.enqueue(source(**changes), authority, "manual")
    assert refused.value.code == code


@pytest.mark.asyncio
async def test_q_pending_executions_then_queue_full(service):
    clock, script, _ = service.test
    script.gate = asyncio.Event()  # the first one holds the slot
    receipts = [service.enqueue(source(n), ALICE, "manual") for n in range(1, QUEUE_LIMIT + 1)]
    with pytest.raises(Refusal) as refused:
        service.enqueue(source(QUEUE_LIMIT + 1), ALICE, "manual")
    assert refused.value.code == "queue_full"
    script.gate.set()
    await settled(service, *receipts, rounds=2000)
    assert {r.state for r in receipts} == {"succeeded"}
    service.enqueue(source(QUEUE_LIMIT + 1), ALICE, "manual")  # room again


@pytest.mark.asyncio
async def test_the_same_actor_asking_twice_gets_the_same_receipt_two_actors_share_one_execution(service):
    _, script, _ = service.test
    script.gate = asyncio.Event()
    first = service.enqueue(source(), ALICE, "manual")
    assert service.enqueue(source(), ALICE, "manual") is first  # deduplicated receipt
    second = service.enqueue(source(), BOB, "manual")
    assert second is not first and second.id != first.id
    script.gate.set()
    await settled(service, first, second)
    assert len(script.calls) == 1  # one CAD for both
    assert first.state == second.state == "succeeded"


# --- cancellation ---------------------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cancelling_one_receipt_keeps_the_execution_for_the_other(service):
    _, script, _ = service.test
    script.gate = asyncio.Event()
    first = service.enqueue(source(), ALICE, "manual")
    second = service.enqueue(source(), BOB, "manual")
    service.cancel(first)
    assert first.state == "canceled"
    script.gate.set()
    await settled(service, second)
    assert second.state == "succeeded" and first.state == "canceled"


@pytest.mark.asyncio
async def test_cancelling_the_last_receipt_of_a_queued_execution_never_runs_it(service):
    _, script, _ = service.test
    script.gate = asyncio.Event()
    running = service.enqueue(source(1), ALICE, "manual")
    queued = service.enqueue(source(2), ALICE, "manual")
    service.cancel(queued)
    script.gate.set()
    await settled(service, running, queued)
    assert [c["source"] for c in script.calls] == [1]
    assert queued.state == "canceled"


@pytest.mark.asyncio
async def test_cancelling_a_running_execution_before_hand_off_cancels_its_attempt_and_never_requeues(service):
    _, script, _ = service.test
    script.gate = asyncio.Event()
    receipt = service.enqueue(source(), ALICE, "manual")
    for _ in range(50):
        await asyncio.sleep(0)
    assert receipt.state == "running"
    service.cancel(receipt)
    await settled(service, receipt)
    await drained(service)  # the attempt itself ended (it would hang on the gate otherwise)
    assert receipt.state == "canceled" and len(script.calls) == 1


@pytest.mark.asyncio
async def test_after_hand_off_a_cancel_is_too_late_and_the_real_terminal_follows(service):
    clock, script, _ = service.test
    attaching = asyncio.Event()
    proceed = asyncio.Event()

    async def before_attach_wait(source, *, order, wait_seconds, on_admit, on_hand_off, before_attach):
        on_admit()
        on_hand_off()
        attaching.set()
        await proceed.wait()
        return "succeeded"

    service._perform = before_attach_wait
    receipt = service.enqueue(source(), ALICE, "manual")
    await attaching.wait()
    with pytest.raises(Refusal) as refused:
        service.cancel(receipt)
    assert refused.value.code == "cancel_too_late"
    proceed.set()
    await settled(service, receipt)
    assert receipt.state == "succeeded"


# --- preemption -----------------------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_preempted_execution_goes_back_to_the_head_with_its_order(service):
    _, script, _ = service.test
    script.then("preempted").then("succeeded").then("succeeded")
    first = service.enqueue(source(1), ALICE, "manual")
    later = service.enqueue(source(2), ALICE, "manual")
    await settled(service, first, later)
    assert [c["source"] for c in script.calls] == [1, 1, 2]  # head requeue, not the tail
    assert script.calls[0]["order"] == script.calls[1]["order"] < script.calls[2]["order"]


@pytest.mark.asyncio
async def test_the_third_preemption_ends_the_execution_with_preemption_limit(service):
    _, script, _ = service.test
    for _ in range(PREEMPTION_LIMIT):
        script.then("preempted")
    receipt = service.enqueue(source(), ALICE, "manual")
    await settled(service, receipt)
    assert (receipt.state, receipt.error_code) == ("failed", "preemption_limit")
    assert len(script.calls) == PREEMPTION_LIMIT


@pytest.mark.asyncio
async def test_a_preemption_never_cancels_the_runner(service):
    _, script, _ = service.test
    script.then("preempted").then("succeeded")
    receipt = service.enqueue(source(), ALICE, "manual")
    await settled(service, receipt)
    assert service._runner.cancelling() == 0  # no Task.cancel/uncancel for a preemption


@pytest.mark.asyncio
async def test_a_user_cancel_is_not_overwritten_by_a_later_preemption(service):
    _, script, _ = service.test
    entered = asyncio.Event()
    release = asyncio.Event()

    async def preempted_after_cancel(source, *, order, wait_seconds, on_admit, on_hand_off, before_attach):
        on_admit()
        entered.set()
        try:
            await release.wait()
        except asyncio.CancelledError:
            return "preempted"  # the runtime lost the race to a revoke — still the user's cancel
        return "preempted"

    service._perform = preempted_after_cancel
    receipt = service.enqueue(source(), ALICE, "manual")
    await entered.wait()
    entered.clear()
    service.cancel(receipt)
    await settled(service, receipt)
    await drained(service)
    for _ in range(20):
        await asyncio.sleep(0)
    assert receipt.state == "canceled" and not entered.is_set()  # never requeued and run again


# --- budgets --------------------------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_active_budget_is_cumulative_across_attempts(service):
    _, script, _ = service.test
    script.then("preempted", active=50).then("preempted", active=50).then("succeeded", active=1)
    receipt = service.enqueue(source(), ALICE, "manual")
    await settled(service, receipt)
    # the third attempt was admitted with only what was left of the 120 s
    import time as real_time

    left = (script.calls[2]["deadline_ns"] - real_time.monotonic_ns()) / 1e9
    assert left <= ACTIVE_SECONDS - 100 + 1


@pytest.mark.asyncio
async def test_the_wall_runs_from_the_first_admission_and_includes_waiting_after_a_preemption(service):
    _, script, _ = service.test
    script.then("preempted", active=10).then("busy", admit=False, wait=WALL_SECONDS)
    receipt = service.enqueue(source(), ALICE, "manual")
    await settled(service, receipt)
    assert (receipt.state, receipt.error_code) == ("failed", "job_expired")


@pytest.mark.asyncio
async def test_a_later_admission_never_restarts_the_wall(service):
    _, script, _ = service.test
    # admitted at t0, then again at t0+510, then at t0+620: the wall is spent, whatever the last admission
    script.then("preempted", active=10).then("preempted", wait=500, active=10).then("timeout", wait=100, active=1)
    receipt = service.enqueue(source(), ALICE, "manual")
    await settled(service, receipt)
    assert (receipt.state, receipt.error_code) == ("failed", "job_expired")


@pytest.mark.asyncio
async def test_a_tail_waits_longer_than_the_wall_and_still_starts_inside_the_first_wait(service):
    clock, script, _ = service.test
    script.then("succeeded", wait=700)  # the head's slot wait exceeds 600 s before its first admission
    receipt = service.enqueue(source(), ALICE, "manual")
    await settled(service, receipt)
    assert receipt.state == "succeeded"  # wall counts from the FIRST admission, not from enqueue


@pytest.mark.asyncio
async def test_a_tail_behind_other_work_longer_than_the_wall_still_runs(service):
    clock, script, _ = service.test
    script.then("succeeded", wait=650).then("succeeded")
    head = service.enqueue(source(1), ALICE, "manual")
    tail = service.enqueue(source(2), ALICE, "manual")  # enqueued now, first admitted after 650 s
    await settled(service, head, tail)
    assert tail.state == "succeeded" and [c["source"] for c in script.calls] == [1, 2]


@pytest.mark.asyncio
async def test_never_admitted_within_the_first_wait_is_expired_before_start(service):
    _, script, _ = service.test
    script.then("busy", admit=False, wait=WAIT_BEFORE_START)
    receipt = service.enqueue(source(), ALICE, "manual")
    await settled(service, receipt)
    assert (receipt.state, receipt.error_code) == ("failed", "expired_before_start")


@pytest.mark.asyncio
async def test_a_timeout_set_by_the_wall_is_job_expired_one_set_by_the_active_budget_is_timeout(service):
    clock, script, _ = service.test
    script.then("preempted", active=5).then("busy", admit=False, wait=WALL_SECONDS - 30).then("timeout", active=30)
    walled = service.enqueue(source(1), ALICE, "manual")
    await settled(service, walled)
    assert (walled.state, walled.error_code) == ("failed", "job_expired")
    script.then("timeout", active=ACTIVE_SECONDS)
    active = service.enqueue(source(2), ALICE, "manual")
    await settled(service, active)
    assert (active.state, active.error_code) == ("failed", "timeout")


@pytest.mark.asyncio
async def test_an_immediately_busy_runtime_is_retried_inside_the_wait(service):
    _, script, _ = service.test
    script.then("busy", admit=False).then("busy", admit=False).then("succeeded")
    receipt = service.enqueue(source(), ALICE, "manual")
    await settled(service, receipt)
    assert receipt.state == "succeeded" and len(script.calls) == 3


# --- authority and source -------------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_revoked_actor_loses_its_receipt_without_harming_the_other(service):
    _, script, checks = service.test
    script.gate = asyncio.Event()
    blocker = service.enqueue(source(9), BOB, "manual")
    alice = service.enqueue(source(1), ALICE, "manual")
    bob = service.enqueue(source(1), BOB, "manual")
    checks.revoked.add(ALICE)  # before the second execution starts
    script.gate.set()
    await settled(service, blocker, alice, bob)
    assert (alice.state, alice.error_code) == ("failed", "authority_missing")
    assert bob.state == "succeeded"


@pytest.mark.asyncio
async def test_no_receipt_left_with_authority_runs_nothing(service):
    _, script, checks = service.test
    script.gate = asyncio.Event()
    blocker = service.enqueue(source(9), BOB, "manual")
    receipt = service.enqueue(source(1), ALICE, "manual")
    checks.revoked.add(ALICE)
    script.gate.set()
    await settled(service, blocker, receipt)
    assert [c["source"] for c in script.calls] == [9]
    assert (receipt.state, receipt.error_code) == ("failed", "authority_missing")


@pytest.mark.asyncio
async def test_authority_is_asked_again_before_the_attach(service):
    _, script, checks = service.test
    entered = asyncio.Event()
    release = asyncio.Event()

    async def revoke_during(source, *, order, wait_seconds, on_admit, on_hand_off, before_attach):
        on_admit()
        entered.set()
        await release.wait()
        on_hand_off()
        return "succeeded" if await before_attach() else "authority_missing"

    service._perform = revoke_during
    receipt = service.enqueue(source(), ALICE, "manual")
    await entered.wait()
    checks.revoked.add(ALICE)
    release.set()
    await settled(service, receipt)
    assert (receipt.state, receipt.error_code) == ("failed", "authority_missing")


@pytest.mark.asyncio
async def test_a_source_that_changed_before_its_start_is_superseded_without_cad(service):
    _, script, checks = service.test
    script.gate = asyncio.Event()
    blocker = service.enqueue(source(9), ALICE, "manual")
    receipt = service.enqueue(source(1), ALICE, "manual")
    checks.gone.add(1)
    script.gate.set()
    await settled(service, blocker, receipt)
    assert (receipt.state, receipt.error_code) == ("failed", "superseded")
    assert [c["source"] for c in script.calls] == [9]


# --- epoch, history, stop -------------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_an_old_epoch_is_expired_and_a_fresh_service_has_its_own(service):
    receipt = service.enqueue(source(), ALICE, "manual")
    assert service.lookup(service.epoch, receipt.id) is receipt
    with pytest.raises(EpochExpired):
        service.lookup("0" * 32, receipt.id)
    other = LibraryPreviewJobs(perform=Script(Clock()), checks=Checks())
    assert other.epoch != service.epoch
    assert service.lookup(service.epoch, "f" * 32) is None


@pytest.mark.asyncio
async def test_terminal_receipts_are_bounded_in_number_and_age(service):
    clock, script, _ = service.test
    receipts = []
    for n in range(TERMINAL_RECEIPTS + 5):
        receipts.append(service.enqueue(source(n + 1), ALICE, "manual"))
        await settled(service, receipts[-1])
    assert service.lookup(service.epoch, receipts[0].id) is None  # the oldest went
    assert service.lookup(service.epoch, receipts[-1].id) is receipts[-1]
    clock.now += TERMINAL_TTL + 1
    service.enqueue(source(10_000), ALICE, "manual")
    assert service.lookup(service.epoch, receipts[-1].id) is None  # older than the TTL


@pytest.mark.asyncio
async def test_stop_cancels_what_waits_awaits_what_was_handed_off_and_requeues_nothing():
    clock = Clock()
    attaching, proceed = asyncio.Event(), asyncio.Event()

    async def perform(source, *, order, wait_seconds, on_admit, on_hand_off, before_attach):
        on_admit()
        on_hand_off()
        attaching.set()
        await proceed.wait()
        return "succeeded"

    jobs = LibraryPreviewJobs(perform=perform, checks=Checks(), clock=clock, sleep=clock.sleep)
    jobs.start()
    handed = jobs.enqueue(source(1), ALICE, "manual")
    waiting = jobs.enqueue(source(2), ALICE, "manual")
    await attaching.wait()
    stopping = asyncio.create_task(jobs.stop("restore"))
    await asyncio.sleep(0.05)
    assert not stopping.done()  # the owned publication finishes first
    assert waiting.state == "canceled"
    proceed.set()
    assert await stopping is True
    assert handed.state == "succeeded"
    with pytest.raises(Refusal) as refused:
        jobs.enqueue(source(3), ALICE, "manual")
    assert refused.value.code == "unavailable"  # closed for good


@pytest.mark.asyncio
async def test_stop_cancels_a_running_attempt_before_hand_off_and_it_is_not_requeued():
    clock = Clock()
    entered = asyncio.Event()
    calls = []

    async def perform(source, *, order, wait_seconds, on_admit, on_hand_off, before_attach):
        calls.append(source.id)
        on_admit()
        entered.set()
        await asyncio.Event().wait()

    jobs = LibraryPreviewJobs(perform=perform, checks=Checks(), clock=clock, sleep=clock.sleep)
    jobs.start()
    receipt = jobs.enqueue(source(), ALICE, "manual")
    await entered.wait()
    assert await jobs.stop("shutdown") is True
    assert receipt.state == "canceled" and calls == [1]


def test_the_singleton_is_never_reset_under_a_live_runner():
    async def scenario():
        jobs_module.jobs = None
        started = jobs_module.start_library_preview_jobs(perform=Script(Clock()), checks=Checks())
        try:
            with pytest.raises(RuntimeError):
                jobs_module.reset_library_preview_jobs()
            with pytest.raises(RuntimeError):
                jobs_module.start_library_preview_jobs(perform=Script(Clock()), checks=Checks())
        finally:
            assert await jobs_module.stop_library_preview_jobs() is True
        assert jobs_module.get_library_preview_jobs() is started  # stopped, kept for its 410s
        jobs_module.reset_library_preview_jobs()
        assert jobs_module.get_library_preview_jobs() is None

    asyncio.run(scenario())


@pytest.mark.asyncio
async def test_a_restore_is_not_overwritten_by_the_preemption_its_cancel_produced():
    """A stop cancels the attempt; the runtime may still answer preempted (it lost the race to a revoke). The
    receipts are live — only the decided cause keeps the execution from going back to the queue."""
    clock = Clock()
    entered = asyncio.Event()
    calls = []

    async def perform(source, *, order, wait_seconds, on_admit, on_hand_off, before_attach):
        calls.append(source.id)
        on_admit()
        entered.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            return "preempted"

    jobs = LibraryPreviewJobs(perform=perform, checks=Checks(), clock=clock, sleep=clock.sleep)
    jobs.start()
    receipt = jobs.enqueue(source(), ALICE, "manual")
    await entered.wait()
    assert await jobs.stop("restore") is True
    assert receipt.state == "canceled" and calls == [1]


@pytest.mark.asyncio
async def test_the_attempt_of_a_job_knows_the_job_and_file_it_serves():
    """Parent-log correlation (spec §6): the attempt's own log lines name the job and the file beside the attempt
    id, so a job's lines and its attempts' lines can be joined without guessing by time."""
    from backend.app.services.preview_runtime import PREVIEW_OWNER

    clock = Clock()
    seen = []

    async def perform(source, *, order, wait_seconds, on_admit, on_hand_off, before_attach):
        seen.append(PREVIEW_OWNER.get())
        on_admit()
        on_hand_off()
        return "succeeded"

    jobs = LibraryPreviewJobs(perform=perform, checks=Checks(), clock=clock, sleep=clock.sleep)
    jobs.start()
    receipt = jobs.enqueue(source(7), ALICE, "manual")
    await settled(jobs, receipt)
    await jobs.stop("shutdown")
    assert len(seen) == 1 and seen[0].startswith("job=") and seen[0].endswith(" file=7")
    assert PREVIEW_OWNER.get() is None  # the runner's own context is untouched
