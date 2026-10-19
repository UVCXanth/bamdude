"""The same request sent twice at once is one operation (spec r4 §3, T9.7 R3).

A client whose answer was lost retries with the same operation id. When the retry overtakes the first request -- both
passed their preflight before either committed -- the second must answer the first's committed result, not a false
conflict: the audit is read again AFTER the serialization, before any stale-revision refusal, under the rights as they
stand. A different payload under the same operation id stays a typed conflict, and nothing is written twice. Codex's
acceptance probes (CODEX-REVIEW-T9-r1, T9-A-R3) are the first two tests, kept as Codex wrote them: the refresh's
barrier sits BEFORE the exclusive storage guard, never inside it.
"""

from __future__ import annotations

import asyncio
import uuid
from contextlib import asynccontextmanager

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from backend.app.models.swap_source_declaration_audit import SwapSourceDeclarationAudit
from backend.app.services import queue_sources, swap_job_refresh as jobs, swap_source_declarations as decl
from backend.tests.integration.test_swap_declaration_service import (  # noqa: F401 -- fixtures
    ALL,
    a_3mf,
    a_user,
    actor_of,
    an_archive,
    an_archive_row,
    clean_spool_state,
    declare,
    factory,
)
from backend.tests.integration.test_swap_job_refresh import a_job, a_printer_queue, apply, by_id, listing, ref, row

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]


async def _audit_actions(factory) -> list[str]:
    async with factory() as db:
        lines = (await db.execute(select(SwapSourceDeclarationAudit).order_by(SwapSourceDeclarationAudit.id))).scalars()
        return [line.action for line in lines]


def _both_read_the_bytes_first(monkeypatch):
    """Hold each declaration after its copy until both have copied: both passed the preflight before either wrote."""
    original = decl._read_bytes
    count, both = 0, asyncio.Event()

    async def synchronized(*args, **kwargs):
        nonlocal count
        result = await original(*args, **kwargs)
        count += 1
        if count == 2:
            both.set()
        await asyncio.wait_for(both.wait(), 5)
        return result

    monkeypatch.setattr(decl, "_read_bytes", synchronized)


def _both_before_the_storage_guard(monkeypatch):
    original = queue_sources.storage_mutation
    count, both = 0, asyncio.Event()

    @asynccontextmanager
    async def synchronized(*args, **kwargs):
        nonlocal count
        count += 1
        if count == 2:
            both.set()
        await asyncio.wait_for(both.wait(), 5)
        async with original(*args, **kwargs):
            yield

    monkeypatch.setattr(queue_sources, "storage_mutation", synchronized)


async def test_concurrent_identical_declare_answers_one_committed_result(factory, tmp_path, monkeypatch):
    user = await a_user(factory)
    path = tmp_path / "replay.gcode.3mf"
    a_3mf(path, "replay")
    aid = await an_archive(factory, path, owner=user)
    seen = await decl.inspect("archive", aid, actor=actor_of(user), rights=ALL)
    operation = str(uuid.uuid4())
    _both_read_the_bytes_first(monkeypatch)
    results = await asyncio.gather(
        *(declare("archive", aid, seen, user, operation_id=operation) for _ in range(2)), return_exceptions=True
    )
    assert all(isinstance(result, dict) for result in results), [repr(result) for result in results]
    assert results[0]["declaration_id"] == results[1]["declaration_id"]
    assert sorted(result["replayed"] for result in results) == [False, True]
    assert await _audit_actions(factory) == ["declare"]


async def test_concurrent_identical_refresh_answers_one_committed_result(factory, tmp_path, monkeypatch):
    user = await a_user(factory)
    qid = await a_printer_queue(factory)
    path = tmp_path / "refresh-replay.gcode.3mf"
    a_3mf(path, "refresh replay")
    aid = await an_archive(factory, path, owner=user)
    jid = await a_job(factory, aid, queue_id=qid)
    seen = await decl.inspect("archive", aid, actor=actor_of(user), rights=ALL)
    await declare("archive", aid, seen, user)
    listed = await listing(aid, user)
    operation = str(uuid.uuid4())
    _both_before_the_storage_guard(monkeypatch)
    picked = [ref(by_id(listed, "queue", jid))]
    results = await asyncio.gather(
        *(apply(aid, user, picked, listed, operation_id=operation) for _ in range(2)), return_exceptions=True
    )
    assert all(isinstance(result, dict) for result in results), [repr(result) for result in results]
    assert results[0]["refreshed"] == results[1]["refreshed"]
    assert sorted(result["replayed"] for result in results) == [False, True]
    assert await _audit_actions(factory) == ["declare", jobs.REFRESH_ACTION]


async def test_a_different_declaration_racing_under_the_same_operation_id_is_a_conflict(factory, tmp_path, monkeypatch):
    user = await a_user(factory)
    path = tmp_path / "other.gcode.3mf"
    a_3mf(path, "other payload")
    aid = await an_archive(factory, path, owner=user)
    seen = await decl.inspect("archive", aid, actor=actor_of(user), rights=ALL)
    operation = str(uuid.uuid4())
    _both_read_the_bytes_first(monkeypatch)
    results = await asyncio.gather(
        declare("archive", aid, seen, user, value=True, operation_id=operation),
        declare("archive", aid, seen, user, value=False, operation_id=operation),
        return_exceptions=True,
    )
    won = [result for result in results if isinstance(result, dict)]
    lost = [result for result in results if isinstance(result, HTTPException)]
    assert len(won) == 1 and len(lost) == 1, [repr(result) for result in results]
    assert lost[0].status_code == 409 and lost[0].detail["error"] == "swap_declaration_conflict"
    assert await _audit_actions(factory) == ["declare"]
    archive = await an_archive_row(factory, aid)
    from backend.app.services import swap_compatibility as sc

    assert sc.current_declaration(archive).value is won[0]["value"]


async def test_a_different_refresh_racing_under_the_same_operation_id_is_a_conflict(factory, tmp_path, monkeypatch):
    user = await a_user(factory)
    qid = await a_printer_queue(factory)
    path = tmp_path / "two-jobs.gcode.3mf"
    a_3mf(path, "two jobs")
    aid = await an_archive(factory, path, owner=user)
    first = await a_job(factory, aid, queue_id=qid)
    second = await a_job(factory, aid, queue_id=qid)
    seen = await decl.inspect("archive", aid, actor=actor_of(user), rights=ALL)
    await declare("archive", aid, seen, user)
    listed = await listing(aid, user)
    operation = str(uuid.uuid4())
    _both_before_the_storage_guard(monkeypatch)
    results = await asyncio.gather(
        apply(aid, user, [ref(by_id(listed, "queue", first))], listed, operation_id=operation),
        apply(aid, user, [ref(by_id(listed, "queue", second))], listed, operation_id=operation),
        return_exceptions=True,
    )
    won = [result for result in results if isinstance(result, dict)]
    lost = [result for result in results if isinstance(result, HTTPException)]
    assert len(won) == 1 and len(lost) == 1, [repr(result) for result in results]
    assert lost[0].status_code == 409 and lost[0].detail["error"] == "swap_refresh_conflict"
    assert await _audit_actions(factory) == ["declare", jobs.REFRESH_ACTION]
    known = [(await row(factory, "queue", job)).source_snapshot["swap_compatible"] for job in (first, second)]
    assert sorted(known, key=str) == [None, True]  # exactly the winner's job took it


async def test_a_retry_after_the_actor_lost_the_source_answers_nothing(factory, tmp_path):
    user = await a_user(factory)
    qid = await a_printer_queue(factory)
    path = tmp_path / "lost.gcode.3mf"
    a_3mf(path, "lost")
    aid = await an_archive(factory, path, owner=None)  # reached through archives:*_all alone
    jid = await a_job(factory, aid, queue_id=qid)
    seen = await decl.inspect("archive", aid, actor=actor_of(user), rights=ALL)
    await declare("archive", aid, seen, user)
    listed = await listing(aid, user)
    operation = str(uuid.uuid4())
    picked = [ref(by_id(listed, "queue", jid))]
    await apply(aid, user, picked, listed, operation_id=operation)
    with pytest.raises(HTTPException) as caught:
        await jobs.refresh(
            "archive",
            aid,
            declaration_id=listed["declaration_id"],
            source_revision=listed["source_revision"],
            jobs=picked,
            operation_id=operation,
            actor=actor_of(user),
            rights=decl.Rights(read_all=False, update_all=False),
            job_rights=jobs.JobRights(True, True),
        )
    assert caught.value.status_code == 404  # never the first result


async def test_a_retry_after_the_key_lost_the_printer_answers_nothing(factory, tmp_path):
    """A retry is a new request: its gate is evaluated again, and a replay never answers for jobs the caller can no
    longer see -- neither on the preflight's fast path nor under the locks."""
    user = await a_user(factory)
    qid = await a_printer_queue(factory)
    path = tmp_path / "scoped.gcode.3mf"
    a_3mf(path, "scoped")
    aid = await an_archive(factory, path, owner=user)
    jid = await a_job(factory, aid, queue_id=qid)
    seen = await decl.inspect("archive", aid, actor=actor_of(user), rights=ALL)
    await declare("archive", aid, seen, user)
    listed = await listing(aid, user)
    operation = str(uuid.uuid4())
    picked = [ref(by_id(listed, "queue", jid))]

    def scoped(scope):
        return jobs.refresh(
            "archive",
            aid,
            declaration_id=listed["declaration_id"],
            source_revision=listed["source_revision"],
            jobs=picked,
            operation_id=operation,
            actor=actor_of(user),
            rights=ALL,
            job_rights=jobs.JobRights(True, True),
            printer_scope=scope,
        )

    assert (await scoped(frozenset({qid})))["replayed"] is False
    with pytest.raises(HTTPException) as caught:
        await scoped(frozenset())
    assert caught.value.status_code == 409
    assert caught.value.detail["jobs"] == [{"kind": "queue", "id": jid, "reason": "job_gone"}]
