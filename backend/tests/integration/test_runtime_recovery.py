"""Preview, apply and audit of the in-memory repair (spec printer-runtime-stall r3 R6, R8).

Two commits: the intent with the queue's pause, then revalidation, the synchronous compare-and-clear and the
outcome. The state is built by the production sweep (``a_dispatched_run_the_sweep_closes``); the printer is
synthetic. Sessions share the in-memory engine here; independent sessions are the WAL/PostgreSQL scenarios.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from uuid import NAMESPACE_URL, uuid5

import pytest
from sqlalchemy import event, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.models.archive import PrintArchive
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.print_state_recovery_action import PrintStateRecoveryAction
from backend.app.models.printer_queue import PrinterQueue
from backend.app.services import (
    print_state_recovery_preview as tokens,
    print_state_recovery_store as store,
    queue_sources,
    runtime_context_release,
)
from backend.app.services.print_run_binding import (
    accept_unbound_completion,
    bind_print_run,
    current_print_run,
    snapshot_completion_token,
)
from backend.app.services.print_state_recovery import RUNTIME_ACTION
from backend.app.services.printer_manager import printer_manager
from backend.tests.integration.test_printer_runtime_stall import (  # noqa: F401 - fixtures
    a_dispatched_run_the_sweep_closes,
    clock,
    runtime,
)
from backend.tests.unit.services.test_terminal_queue_repair import telemetry  # noqa: F401 - fixture

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]


@pytest.fixture
async def a01(db_session, test_engine, printer_factory, archive_factory, telemetry, runtime, monkeypatch):
    from backend.app import main

    factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr(main, "async_session", factory)
    printer, queue, archive, _item, pending, run = await a_dispatched_run_the_sweep_closes(
        db_session, printer_factory, archive_factory, telemetry
    )
    return SimpleNamespace(
        printer_id=printer.id, queue_id=queue.id, archive_id=archive.id, pending_id=pending.id, run=run, factory=factory
    )


@pytest.fixture
def released(monkeypatch):
    """Every compare-and-clear the protocol attempts, and its answer."""
    calls = []
    real = runtime_context_release.release

    def spy(manager, expected):
        result = real(manager, expected)
        calls.append(result)
        return result

    monkeypatch.setattr(runtime_context_release, "release", spy)
    return calls


async def preview(db, a):
    response = await store.make_preview(db, a.printer_id, "runtime", a.archive_id, RUNTIME_ACTION, "user:1")
    return response, tokens.verify(response["preview_token"])


async def apply(a, payload, *, recheck=None):
    return await store.apply_preview(a.factory, payload, "user:1", "Operator", recheck=recheck)


async def rows(db):
    db.expire_all()
    return list(
        (await db.scalars(select(PrintStateRecoveryAction).order_by(PrintStateRecoveryAction.created_at))).all()
    )


def outcome_id(nonce):
    return str(uuid5(NAMESPACE_URL, f"bamdude:print-state-recovery:outcome:{nonce}"))


async def test_the_preview_says_what_goes_and_what_stays(db_session, a01):
    response, _ = await preview(db_session, a01)
    assert response["action"] == RUNTIME_ACTION and response["archive_preserved"] is True
    assert response["after"]["queue"] == {"is_paused": True}
    assert response["after"]["runtime"] == {
        "archive_id": a01.archive_id,
        "admission": False,
        "macro_selection": True,
        "swap_config": False,
    }
    assert response["runtime"]["queue_paused"] is False
    assert response["before"]["queue"]["is_paused"] is False


async def test_apply_releases_the_context_pauses_the_queue_and_audits_twice(db_session, a01, released):
    from backend.app import main

    _, payload = await preview(db_session, a01)
    archive_before = await db_session.get(PrintArchive, a01.archive_id)
    snapshot = (archive_before.status, archive_before.completed_at, dict(archive_before.extra_data))

    result = await apply(a01, payload)

    assert result["outcome"] == "applied" and result["operation_id"] == payload["nonce"]
    assert released == [True]
    assert current_print_run(printer_manager, a01.printer_id) is None
    assert a01.printer_id not in main._active_macro_selection
    # A late terminal of A is a duplicate now; nothing of A replays.
    assert (
        accept_unbound_completion(printer_manager, snapshot_completion_token(printer_manager, a01.printer_id)) is False
    )
    db_session.expire_all()
    queue = await db_session.get(PrinterQueue, a01.queue_id)
    assert queue.is_paused is True and queue.status == "idle"
    archive = await db_session.get(PrintArchive, a01.archive_id)
    assert (archive.status, archive.completed_at, archive.extra_data) == snapshot
    assert (await db_session.get(PrintQueueItem, a01.pending_id)).status == "pending"
    intent, outcome = await rows(db_session)
    assert intent.id == payload["nonce"] and intent.result["phase"] == "intent"
    assert outcome.id == outcome_id(payload["nonce"]) and outcome.result["phase"] == "outcome"
    assert outcome.result["operation_id"] == payload["nonce"] and outcome.result["outcome"] == "applied"
    assert intent.result["before"]["queue_was_paused"] is False
    assert intent.result["incarnation"] == tokens.incarnation()


async def test_the_same_token_never_clears_twice(db_session, a01, released):
    _, payload = await preview(db_session, a01)
    first = await apply(a01, payload)
    again = await apply(a01, payload)
    assert again == first and released == [True]
    assert len(await rows(db_session)) == 2


async def test_a_failed_intent_commit_changes_nothing(db_session, a01, released):
    _, payload = await preview(db_session, a01)

    def fail(_mapper, _connection, target):
        if target.result.get("phase") == "intent":
            raise RuntimeError("audit unavailable")

    event.listen(PrintStateRecoveryAction, "before_insert", fail)
    try:
        with pytest.raises(RuntimeError, match="audit unavailable"):
            await apply(a01, payload)
    finally:
        event.remove(PrintStateRecoveryAction, "before_insert", fail)
    assert released == [] and current_print_run(printer_manager, a01.printer_id) is a01.run
    db_session.expire_all()
    assert (await db_session.get(PrinterQueue, a01.queue_id)).is_paused is False
    assert await rows(db_session) == []


async def test_a_run_bound_after_the_intent_is_left_alone_and_the_pause_stays(db_session, a01, released):
    """A07 / A19: B appears between the two commits; the old CAS never touches it."""
    _, payload = await preview(db_session, a01)
    holder = {}

    def b_starts(_mapper, _connection, target):
        if target.result.get("phase") == "intent":
            holder["b"] = bind_print_run(
                printer_manager, printer_id=a01.printer_id, archive_id=a01.archive_id + 50, observed_subtask_id="999"
            )

    event.listen(PrintStateRecoveryAction, "after_insert", b_starts)
    try:
        result = await apply(a01, payload)
    finally:
        event.remove(PrintStateRecoveryAction, "after_insert", b_starts)
    assert result["outcome"] == "not_applied_changed" and result["queue_paused"] is True
    assert released in ([], [False])
    assert current_print_run(printer_manager, a01.printer_id) is holder["b"]
    db_session.expire_all()
    assert (await db_session.get(PrinterQueue, a01.queue_id)).is_paused is True
    intent, outcome = await rows(db_session)
    assert outcome.result["outcome"] == "not_applied_changed"


async def test_an_unconfirmed_outcome_is_reported_and_never_retried(db_session, a01, released):
    _, payload = await preview(db_session, a01)

    def fail(_mapper, _connection, target):
        if target.result.get("phase") == "outcome":
            raise RuntimeError("outcome lost")

    event.listen(PrintStateRecoveryAction, "before_insert", fail)
    try:
        result = await apply(a01, payload)
        again = await apply(a01, payload)
    finally:
        event.remove(PrintStateRecoveryAction, "before_insert", fail)
    assert result["outcome"] == "outcome_unconfirmed" and result["operation_id"] == payload["nonce"]
    assert again["outcome"] == "outcome_unconfirmed"
    assert released == [True]  # the context went once; the repeat did not try again
    assert current_print_run(printer_manager, a01.printer_id) is None
    (intent,) = await rows(db_session)
    assert intent.result["phase"] == "intent"


async def test_rights_revoked_after_the_intent_keep_the_pause(db_session, a01, released):
    from fastapi import HTTPException

    _, payload = await preview(db_session, a01)
    checks = 0

    async def revoked_later(_action, _db):
        nonlocal checks
        checks += 1
        if checks >= 3:  # preflight, the intent's writer -- then gone
            raise HTTPException(403, "recovery_changed")

    result = await apply(a01, payload, recheck=revoked_later)
    assert result["outcome"] == "not_applied_changed" and result["reason"] == "rights_changed"
    assert released == [] and current_print_run(printer_manager, a01.printer_id) is a01.run
    db_session.expire_all()
    assert (await db_session.get(PrinterQueue, a01.queue_id)).is_paused is True


async def test_while_a_preview_lives_no_new_object_takes_an_identity_it_named(db_session, a01, released):
    """Minor 2: the preview names the run by object identity. A rebind (``replace()``) with the same content
    must stay a different object for as long as the preview can be applied -- the old one cannot be freed and
    its id handed to a newcomer."""
    from dataclasses import replace as dc_replace

    _, payload = await preview(db_session, a01)
    named = id(a01.run)
    a01.run = None
    seen = set()
    for _ in range(50):
        newcomer = dc_replace(printer_manager._print_run_bindings[a01.printer_id])
        printer_manager._print_run_bindings[a01.printer_id] = newcomer
        seen.add(id(newcomer))
    assert named not in seen
    # Seen before the first commit: refused whole, nothing paused, nothing written.
    with pytest.raises(ValueError, match="recovery_changed"):
        await apply(a01, payload)
    assert released == [] and await rows(db_session) == []
    assert current_print_run(printer_manager, a01.printer_id) is newcomer


async def test_a_failure_before_the_cas_is_recorded_as_not_applied(db_session, a01, released, monkeypatch):
    """Minor 1: the guards of the second transaction fail -- memory was never touched, and history says so."""
    _, payload = await preview(db_session, a01)
    real = store._take_guards
    calls = 0

    async def second_fails(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("database is locked")
        return await real(*args, **kwargs)

    monkeypatch.setattr(store, "_take_guards", second_fails)
    result = await apply(a01, payload)
    assert result["outcome"] == "not_applied_changed" and result["reason"] == "unavailable"
    assert released == [] and current_print_run(printer_manager, a01.printer_id) is a01.run
    intent, outcome = await rows(db_session)
    assert outcome.id == outcome_id(payload["nonce"])
    assert outcome.result["outcome"] == "not_applied_changed" and outcome.result["reason"] == "unavailable"
    db_session.expire_all()
    assert (await db_session.get(PrinterQueue, a01.queue_id)).is_paused is True
    # The repeat reads the recorded answer.
    again = await apply(a01, payload)
    assert again["outcome"] == "not_applied_changed" and again["reason"] == "unavailable"


async def test_a_database_error_in_the_recheck_is_not_called_lost_rights(db_session, a01, released):
    _, payload = await preview(db_session, a01)
    checks = 0

    async def broken_later(_action, _db):
        nonlocal checks
        checks += 1
        if checks >= 3:
            raise RuntimeError("database is locked")

    result = await apply(a01, payload, recheck=broken_later)
    assert result["outcome"] == "not_applied_changed" and result["reason"] == "unavailable"
    assert released == [] and current_print_run(printer_manager, a01.printer_id) is a01.run


async def test_the_row_says_which_repair_paused_its_queue(db_session, a01, released, clock):
    """Minor 6 / R8.6, A26: after a reload the row itself says the pause came from a repair, and how it ended."""
    from fastapi import HTTPException

    _, payload = await preview(db_session, a01)
    checks = 0

    async def revoked_later(_action, _db):
        nonlocal checks
        checks += 1
        if checks >= 3:
            raise HTTPException(403, "recovery_changed")

    await apply(a01, payload, recheck=revoked_later)
    await store.list_issues(db_session, None)
    clock.advance(11)
    page = await store.list_issues(db_session, None)
    (row,) = [r for r in page["issues"] if r["printer_id"] == a01.printer_id and r["kind"] == "runtime"]
    assert row["queue_paused"] is True
    repair = row["last_repair"]
    assert (repair["outcome"], repair["reason"]) == ("not_applied_changed", "rights_changed")
    assert repair["archive_id"] == a01.archive_id and repair["queue_was_paused"] is False
    assert repair["process_ended"] is False and repair["at"]


async def test_a_restore_between_the_commits_keeps_the_pause(db_session, a01, released):
    _, payload = await preview(db_session, a01)

    def restored(_mapper, _connection, target):
        if target.result.get("phase") == "intent":
            queue_sources.invalidate_receipts()

    event.listen(PrintStateRecoveryAction, "after_insert", restored)
    try:
        result = await apply(a01, payload)
    finally:
        event.remove(PrintStateRecoveryAction, "after_insert", restored)
    assert result["outcome"] == "not_applied_changed" and released == []


async def test_a_restore_before_apply_writes_nothing(db_session, a01, released):
    _, payload = await preview(db_session, a01)
    queue_sources.invalidate_receipts()
    with pytest.raises(ValueError, match="recovery_changed"):
        await apply(a01, payload)
    assert await rows(db_session) == [] and released == []


@pytest.mark.parametrize(("status", "paused"), [("idle", False), ("error", False), ("idle", True)])
async def test_only_the_pause_flag_changes_and_a_prior_pause_is_named(db_session, a01, status, paused):
    """A26: the queue's status is never written; a pause set before the repair is recorded and shown."""
    queue = await db_session.get(PrinterQueue, a01.queue_id)
    queue.status, queue.is_paused = status, paused
    await db_session.commit()
    response, payload = await preview(db_session, a01)
    assert response["runtime"]["queue_paused"] is paused
    result = await apply(a01, payload)
    assert result["outcome"] == "applied" and result["queue_was_paused"] is paused
    db_session.expire_all()
    queue = await db_session.get(PrinterQueue, a01.queue_id)
    assert (queue.status, queue.is_paused) == (status, True)


async def test_the_plate_gate_is_neither_armed_nor_cleared(db_session, a01):
    """A21: the sweep armed it; the repair leaves it exactly as it was."""
    armed = printer_manager.is_awaiting_plate_clear(a01.printer_id)
    _, payload = await preview(db_session, a01)
    await apply(a01, payload)
    assert printer_manager.is_awaiting_plate_clear(a01.printer_id) is armed


async def test_a_cancelled_request_still_ends_the_operation(db_session, a01, released):
    """R8.8: the client went away after the intent; the operation finishes and its outcome is recorded."""
    _, payload = await preview(db_session, a01)
    committed = asyncio.Event()

    def mark(_mapper, _connection, target):
        if target.result.get("phase") == "intent":
            committed.set()

    event.listen(PrintStateRecoveryAction, "after_insert", mark)
    try:
        request = asyncio.ensure_future(apply(a01, payload))
        await asyncio.wait_for(committed.wait(), 10)
        request.cancel()
        with pytest.raises(asyncio.CancelledError):
            await request
        for _ in range(500):
            if len(await rows(db_session)) == 2:
                break
            await asyncio.sleep(0.01)
    finally:
        event.remove(PrintStateRecoveryAction, "after_insert", mark)
    intent, outcome = await rows(db_session)
    assert outcome.result["outcome"] == "applied" and released == [True]


async def test_shutdown_waits_for_an_operation_whose_client_went_away(db_session, a01, released):
    """Minor 7: the shielded operation is drained at shutdown, so its outcome is written before the process ends."""
    _, payload = await preview(db_session, a01)
    committed = asyncio.Event()

    def mark(_mapper, _connection, target):
        if target.result.get("phase") == "intent":
            committed.set()

    event.listen(PrintStateRecoveryAction, "after_insert", mark)
    try:
        request = asyncio.ensure_future(apply(a01, payload))
        await asyncio.wait_for(committed.wait(), 10)
        request.cancel()
        assert await store.drain_runtime_operations(timeout=10) == 0
    finally:
        event.remove(PrintStateRecoveryAction, "after_insert", mark)
    intent, outcome = await rows(db_session)
    assert outcome.result["outcome"] == "applied" and released == [True]


async def test_a_failure_nobody_waits_for_is_still_logged(db_session, a01, monkeypatch, caplog):
    """Minor 7: ``asyncio.shield`` quietly takes the exception of an operation whose client left -- so the
    operation reports its own failure, or it would vanish without a trace."""
    import logging

    _, payload = await preview(db_session, a01)
    gate = asyncio.Event()

    async def broken(*_args, **_kwargs):
        await gate.wait()
        raise RuntimeError("database went away")

    monkeypatch.setattr(store, "_apply_runtime", broken)
    request = asyncio.ensure_future(apply(a01, payload))
    await asyncio.sleep(0)
    request.cancel()
    with caplog.at_level(logging.WARNING, logger=store.__name__):
        gate.set()
        assert await store.drain_runtime_operations(timeout=10) == 0
    assert any("operation failed" in r.getMessage() for r in caplog.records), caplog.records


async def test_history_groups_the_pair_and_names_an_ended_process(async_client, db_session, a01, monkeypatch):
    _, payload = await preview(db_session, a01)
    await apply(a01, payload)
    response = await async_client.get(f"/api/v1/system/printers/{a01.printer_id}/print-state/history")
    assert response.status_code == 200, response.text
    (action,) = response.json()["actions"]
    assert action["id"] == payload["nonce"] and action["outcome"]["outcome"] == "applied"
    assert action["process_ended"] is False


async def test_history_reads_the_outcomes_of_a_page_at_once(async_client, db_session, test_engine, a01):
    """Minor 9: one read of the page and one of its outcomes, however many repairs the page holds."""
    for n in range(12):
        db_session.add(
            store._audit_row(
                f"00000000-0000-4000-8000-{n:012d}",
                "user:1",
                "Operator",
                (a01.printer_id, "runtime", a01.archive_id),
                a01.queue_id,
                a01.archive_id,
                "h",
                {"id": f"00000000-0000-4000-8000-{n:012d}", "phase": "intent", "action": RUNTIME_ACTION},
            )
        )
    await db_session.commit()
    statements = []

    def count(_conn, _cursor, statement, *_args):
        if "print_state_recovery_actions" in statement:
            statements.append(statement)

    event.listen(test_engine.sync_engine, "before_cursor_execute", count)
    try:
        response = await async_client.get(f"/api/v1/system/printers/{a01.printer_id}/print-state/history")
    finally:
        event.remove(test_engine.sync_engine, "before_cursor_execute", count)
    assert response.status_code == 200 and len(response.json()["actions"]) == 12
    assert len(statements) <= 2, statements


async def test_an_intent_without_outcome_of_an_ended_process_proves_nothing(async_client, db_session, a01, monkeypatch):
    _, payload = await preview(db_session, a01)

    def fail(_mapper, _connection, target):
        if target.result.get("phase") == "outcome":
            raise RuntimeError("outcome lost")

    event.listen(PrintStateRecoveryAction, "before_insert", fail)
    try:
        await apply(a01, payload)
    finally:
        event.remove(PrintStateRecoveryAction, "before_insert", fail)
    url = f"/api/v1/system/printers/{a01.printer_id}/print-state/history"
    (action,) = (await async_client.get(url)).json()["actions"]
    assert action["outcome"] is None and action["process_ended"] is False
    monkeypatch.setattr(tokens, "_INCARNATION", "another-process")
    (action,) = (await async_client.get(url)).json()["actions"]
    assert action["outcome"] is None and action["process_ended"] is True


async def test_http_preview_and_apply_need_queue_update(async_client, db_session, a01):
    base = f"/api/v1/system/printers/{a01.printer_id}/print-state"
    body = {"kind": "runtime", "target_id": a01.archive_id, "action": RUNTIME_ACTION}
    response = await async_client.post(base + "/preview", json=body)
    assert response.status_code == 200, response.text
    applied = await async_client.post(
        base + "/apply", json={"preview_token": response.json()["preview_token"], "confirmed": True}
    )
    assert applied.status_code == 200, applied.text
    assert applied.json()["outcome"] == "applied"
    made = await async_client.post(
        "/api/v1/api-keys/", json={"name": "status", "can_queue": False, "can_read_status": True}
    )
    async_client.headers.pop("Authorization", None)
    refused = await async_client.post(base + "/preview", json=body, headers={"X-API-Key": made.json()["key"]})
    assert refused.status_code == 403, refused.text


async def test_a_swap_still_owed_has_no_preview(db_session, a01):
    """A05 / A23: the obligation is kept -- nothing to release, nothing paused, nothing written."""
    archive = await db_session.get(PrintArchive, a01.archive_id)
    archive.extra_data = {
        **(archive.extra_data or {}),
        "bamdude_terminal_effects": {"swap_change_table": {"stage": "owed"}},
    }
    await db_session.commit()
    with pytest.raises(ValueError, match="recovery_not_allowed"):
        await preview(db_session, a01)
    assert await db_session.scalar(select(func.count()).select_from(PrintStateRecoveryAction)) == 0
