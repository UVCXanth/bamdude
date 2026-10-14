"""Apply a source's operator declaration to jobs the operator SELECTED (swap-source-declaration spec r3 §6).

A separate action after a successful declaration, never part of it: the operator names up to ``MAX_JOBS`` jobs,
each with the revision it was listed under. A job may take the declaration only when

- its own snapshot is readable and says unknown, or predates the fact (missing) -- a known True/False is never
  replaced, the job is a conflict: print the new declaration as a new job;
- its own live link is the declared source, its provenance names that source, and the blob it captured holds the
  declared bytes (``QueueSource.sha256 == declaration.sha256``);
- it has provably never been dispatched: a printer job pending or failed with no claim ever taken (``started_at``
  NULL, ``dispatch_attempts`` 0, a queued -- not direct or external -- row, no execution archive wired in), a router
  job pending or failed, neither routed nor a rebalance companion nor cancelled.

What changes is the fact in the job's snapshot, nothing else: not the blob, its owners, the job's options, events,
plate, name, order or position -- and not its status: a failed job stays failed until the ordinary Retry. One
refused or changed job refuses the whole group with no write at all. A job without a captured source has nothing to
refresh: its Retry captures the source again and reads the declaration then.

Locks, in the order every writer of this map takes them (plan T9 r3, the archive declaration / claim / refresh
table): the storage guard, then every printer lane the selection touches in ascending queue id, then the job rows in
``(kind, id)`` order, then the source -- an archive's write scope and row, or a library row. Lanes are the ones a
preflight read named; a job found on another lane under the locks is ``jobs_changed``, never a late lock. No file
is read, nothing is copied. The audit line names the jobs that really changed, and commits with them.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from contextlib import AsyncExitStack
from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import select

from backend.app.core.permissions import Permission
from backend.app.services import queue_sources, swap_compatibility as sc
from backend.app.services.queue_source_descriptor import SOURCE_SNAPSHOT_VERSION
from backend.app.services.swap_source_declarations import (
    _NOT_FOUND,
    _NOT_OWN,
    SOURCE_CHANGED,
    Actor,
    Rights,
    _fresh_rights,
    _mine,
    _model,
)

logger = logging.getLogger(__name__)

JOB_KINDS = ("auto_queue", "queue")  # the stable order rows are locked in: (kind, id)
MAX_JOBS = 100

#: Why one job may not take the declaration -- the closed list the API answers (frontend copies it).
REFUSALS = frozenset(
    {
        "job_gone",
        "identity_missing",
        "status",
        "not_before_dispatch",
        "cancelled",
        "companion",
        "not_editable",
        "no_captured_source",
        "snapshot_unreadable",
        "hash_mismatch",
        "source_mismatch",
        "source_not_ready",
        "snapshot_known",
    }
)

NOT_REFRESHABLE = "Some of the selected jobs cannot take this declaration. Nothing was changed."
JOBS_CHANGED = "Some of the selected jobs changed since they were listed. List them again."
NO_DECLARATION = "This source has no operator declaration to apply. Declare it first."
SELECTION_INVALID = "Select between 1 and 100 different jobs."
OPERATION_CONFLICT = "This operation was already used for another refresh."


@dataclass(frozen=True)
class JobRef:
    kind: str
    id: int
    revision: str


@dataclass(frozen=True)
class JobRights:
    """What the request's queue gates granted: ``*_all``, else only the caller's own jobs."""

    read_all: bool
    update_all: bool


def _job_model(kind: str):
    if kind == "queue":
        from backend.app.models.print_queue import PrintQueueItem

        return PrintQueueItem
    if kind == "auto_queue":
        from backend.app.models.auto_queue import AutoQueueItem

        return AutoQueueItem
    raise ValueError(f"not a job kind: {kind!r}")


def _when(value) -> str | None:
    return value.isoformat() if value is not None else None


def job_revision(kind: str, row) -> str:
    """The job as a refresh compares it: its incarnation, where it is, what it captured and how far it went. A
    position or a waiting reason moving is no change; a move to another lane, a deleted and re-inserted row (a new
    incarnation under a reused id), a new snapshot or a claim is."""
    facts = {
        "kind": kind,
        "id": row.id,
        "identity": sc.job_identity(row),
        "status": row.status,
        "queue_id": getattr(row, "queue_id", None),
        "queue_source_id": row.queue_source_id,
        "archive_id": row.archive_id,
        "library_file_id": row.library_file_id,
        "snapshot": row.source_snapshot,
        "started_at": _when(getattr(row, "started_at", None)),
        "dispatch_attempts": getattr(row, "dispatch_attempts", None),
        "origin": getattr(row, "origin", None),
        "is_calibration": getattr(row, "is_calibration", None),
        "assigned_to_item_id": getattr(row, "assigned_to_item_id", None),
        "cancelled_at": _when(getattr(row, "cancelled_at", None)),
        "rebalanced_at": _when(getattr(row, "rebalanced_at", None)),
        "owner": row.created_by_id,
    }
    return hashlib.sha256(json.dumps(facts, sort_keys=True, default=str).encode("utf-8")).hexdigest()


def _visible(row, actor: Actor, rights: JobRights, printer_scope: frozenset[int] | None, kind: str) -> bool:
    if printer_scope is not None and (kind == "auto_queue" or getattr(row, "queue_id", None) not in printer_scope):
        return False
    return rights.read_all or _mine(row, actor)


def _editable(row, actor: Actor, rights: JobRights, kind: str) -> bool:
    # The router's rows are edited with queue:update_all only, as the auto-queue routes ask.
    return rights.update_all or (kind == "queue" and _mine(row, actor))


def _refusal(
    kind: str, row, *, source_kind: str, source_id: int, sha256: str, blob, actor, rights, scope
) -> str | None:
    """The one reason this job may not take the declaration, or ``None``. ``blob`` is its ``QueueSource`` row."""
    if row is None or not _visible(row, actor, rights, scope, kind):
        return "job_gone"
    if not sc.job_identity(row):
        return "identity_missing"
    if row.status not in ("pending", "failed"):
        return "status"
    if kind == "queue":
        if (
            row.started_at is not None
            or (row.dispatch_attempts or 0) != 0
            or row.origin != "queue"
            or row.is_calibration
            or row.source_auto_item_id is not None
        ):
            return "not_before_dispatch"
    else:
        if row.cancelled_at is not None:
            return "cancelled"
        if row.assigned_to_item_id is not None or row.assigned_at is not None:
            return "status"
        if row.rebalanced_at is not None or row.rebalanced_from_model is not None:
            return "companion"
    if not _editable(row, actor, rights, kind):
        return "not_editable"
    if row.queue_source_id is None or blob is None:
        return "no_captured_source"
    snapshot = row.source_snapshot
    if not isinstance(snapshot, dict) or snapshot.get("version") != SOURCE_SNAPSHOT_VERSION:
        return "snapshot_unreadable"
    if blob.state != "ready":
        return "source_not_ready"
    if blob.sha256 != sha256:
        return "hash_mismatch"
    provenance = snapshot.get("provenance") if isinstance(snapshot.get("provenance"), dict) else {}
    link_kind = "archive" if source_kind == "archive" else "library_file"
    link = row.archive_id if source_kind == "archive" else row.library_file_id
    if link != source_id or provenance.get("kind") != link_kind or provenance.get("id") != source_id:
        return "source_mismatch"
    if source_kind == "library" and row.archive_id is not None:
        return "not_before_dispatch"  # an execution archive was wired into a library job: it was dispatched
    if sc.snapshot_fact(snapshot).value is not None:
        return "snapshot_known"
    return None


async def _fresh_job_rights(db, actor: Actor, granted: JobRights) -> JobRights:
    """The queue rights read again inside the write transaction, never wider than what the request was granted."""
    if actor.kind == "api_key":
        from backend.app.core.auth import authorize_api_key, resolve_api_key_authority

        try:
            authority = await resolve_api_key_authority(None, actor.credential)
        except Exception as exc:  # noqa: BLE001 -- any failure to validate is no right
            raise HTTPException(403, "You may no longer declare this source.") from exc
        await authorize_api_key(db, authority.key, [Permission.QUEUE_UPDATE_ALL.value], authority=authority)
        return granted
    from sqlalchemy.orm import selectinload

    from backend.app.models.user import User

    user = (
        await db.execute(
            select(User)
            .options(selectinload(User.groups))
            .where(User.id == actor.user_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()
    if user is None or not user.is_active:
        raise HTTPException(403, "You may no longer declare this source.")
    may_read_all = user.has_permission(Permission.QUEUE_READ_ALL.value)
    may_update_all = user.has_permission(Permission.QUEUE_UPDATE_ALL.value)
    if not (may_read_all or user.has_permission(Permission.QUEUE_READ_OWN.value)) or not (
        may_update_all or user.has_permission(Permission.QUEUE_UPDATE_OWN.value)
    ):
        raise HTTPException(403, "You may no longer declare this source.")
    return JobRights(read_all=granted.read_all and may_read_all, update_all=granted.update_all and may_update_all)


def _source_gate(kind: str, row, actor: Actor, rights: Rights) -> None:
    """The declared source, visible and the actor's to change (no printing check: nothing of the source moves)."""
    if row is None or getattr(row, "deleted_at", None) is not None:
        raise HTTPException(404, _NOT_FOUND[kind])
    mine = _mine(row, actor)
    if not (rights.read_all or mine):
        raise HTTPException(404, _NOT_FOUND[kind])
    if not (rights.update_all or mine):
        raise HTTPException(403, _NOT_OWN[kind])


def _operator_declaration(row):
    declaration = sc.current_declaration(row)
    if declaration is None or declaration.origin != "operator":
        raise HTTPException(409, {"error": "no_declaration", "message": NO_DECLARATION})
    return declaration


def _job_filter(model, kind: str, source_kind: str, source_id: int):
    link = model.archive_id if source_kind == "archive" else model.library_file_id
    return select(model).where(link == source_id, model.status.in_(("pending", "failed"))).order_by(model.id)


async def candidates(
    source_kind: str,
    source_id: int,
    *,
    actor: Actor,
    rights: Rights,
    job_rights: JobRights,
    printer_scope: frozenset[int] | None = None,
) -> dict:
    """The pending and failed jobs linked to this source that the actor may see, each with its revision and whether
    a refresh may change it -- none of them pre-selected. Jobs the actor cannot see are not listed or counted."""
    from backend.app.core.database import async_session
    from backend.app.models.queue_source import QueueSource

    async with async_session() as db:
        row = await db.get(_model(source_kind), source_id)
        _source_gate(source_kind, row, actor, rights)
        declaration = _operator_declaration(row)
        listed: list[dict] = []
        for kind in JOB_KINDS:
            model = _job_model(kind)
            for job in (await db.execute(_job_filter(model, kind, source_kind, source_id))).scalars():
                if not _visible(job, actor, job_rights, printer_scope, kind):
                    continue
                blob = await db.get(QueueSource, job.queue_source_id) if job.queue_source_id else None
                reason = _refusal(
                    kind,
                    job,
                    source_kind=source_kind,
                    source_id=source_id,
                    sha256=declaration.sha256,
                    blob=blob,
                    actor=actor,
                    rights=job_rights,
                    scope=printer_scope,
                )
                listed.append(
                    {
                        "kind": kind,
                        "id": job.id,
                        "revision": job_revision(kind, job),
                        "status": job.status,
                        "eligible": reason is None,
                        "reason": reason,
                    }
                )
        eligible = sum(1 for entry in listed if entry["eligible"])
        return {
            "kind": source_kind,
            "id": source_id,
            "declaration_id": (declaration.operator or {}).get("declaration_id"),
            "value": declaration.value,
            "sha256": declaration.sha256,
            "source_revision": sc.source_revision(row, epoch=queue_sources.current_epoch()),
            "jobs": listed,
            "counts": {"eligible": eligible, "refused": len(listed) - eligible},
        }


def _request_digest(source_kind, source_id, declaration_id, source_revision, picked) -> str:
    payload = {
        "kind": source_kind,
        "id": source_id,
        "declaration_id": declaration_id,
        "revision": source_revision,
        "jobs": sorted([job.kind, job.id, job.revision] for job in picked),
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()


def _validate_selection(picked: list[JobRef]) -> list[JobRef]:
    keys = [(job.kind, job.id) for job in picked]
    if not 1 <= len(picked) <= MAX_JOBS or len(set(keys)) != len(keys) or any(k not in JOB_KINDS for k, _ in keys):
        raise HTTPException(422, {"error": "selection_invalid", "message": SELECTION_INVALID})
    return sorted(picked, key=lambda job: (job.kind, job.id))


async def _replayed(db, operation_id: str, digest: str, actor: Actor):
    from backend.app.models.swap_source_declaration_audit import SwapSourceDeclarationAudit as Audit

    previous = (await db.execute(select(Audit).where(Audit.operation_id == operation_id))).scalar_one_or_none()
    if previous is None:
        return None
    if (
        previous.action != "refresh"
        or previous.request_digest != digest
        or previous.actor_kind != actor.kind
        or previous.actor_id != actor.user_id
    ):
        raise HTTPException(409, {"error": "swap_refresh_conflict", "message": OPERATION_CONFLICT})
    return {
        "operation_id": operation_id,
        "declaration_id": previous.declaration_id,
        "value": previous.new_value,
        "refreshed": [{"kind": job["kind"], "id": job["id"]} for job in previous.jobs or []],
        "replayed": True,
    }


async def _lock_source(db, source_kind: str, source_id: int):
    """The source, last: an archive's database guard and row (its in-process lock came with the lanes), or a
    library row."""
    if source_kind == "archive":
        from backend.app.services.archive_write_scope import archive_db_guard, load_active_archive_for_write

        await archive_db_guard(db, source_id)
        return await load_active_archive_for_write(db, source_id)
    from backend.app.core.database import take_write_lock
    from backend.app.models.library import LibraryFile

    await take_write_lock(db, LibraryFile.__table__, source_id)
    return (
        await db.execute(
            select(LibraryFile)
            .where(LibraryFile.id == source_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()


async def refresh(
    source_kind: str,
    source_id: int,
    *,
    declaration_id: str,
    source_revision: str,
    jobs: list[JobRef],
    operation_id: str,
    actor: Actor,
    rights: Rights,
    job_rights: JobRights,
    printer_scope: frozenset[int] | None = None,
) -> dict:
    """Write the declaration into every selected job's snapshot -- all of them, or none."""
    from backend.app.core.database import async_session
    from backend.app.models.queue_source import QueueSource
    from backend.app.services.queue_ops import claim_lanes

    started = time.monotonic()
    picked = _validate_selection(list(jobs))
    digest = _request_digest(source_kind, source_id, declaration_id, source_revision, picked)
    try:
        # What a replay answers, and which lanes the selection touches -- read apart, holding nothing.
        async with async_session() as db:
            replayed = await _replayed(db, operation_id, digest, actor)
            if replayed is not None:
                _log(operation_id, source_kind, source_id, "replayed", started)
                return replayed
            found = set()
            for job in picked:
                if job.kind == "queue" and (item := await db.get(_job_model("queue"), job.id)) is not None:
                    found.add(item.queue_id)
            lanes = sorted(found)

        refreshed: list[dict] = []
        touched_lanes: set[int] = set()
        async with queue_sources.storage_mutation(), async_session() as db, AsyncExitStack() as stack:
            # Every in-process lock first -- the lanes, then the archive's -- then the database's (``claim_lanes``).
            await stack.enter_async_context(
                claim_lanes(db, lanes, archive_id=source_id if source_kind == "archive" else None)
            )
            rows = {}
            for job in picked:
                model = _job_model(job.kind)
                rows[(job.kind, job.id)] = (
                    await db.execute(
                        select(model)
                        .where(model.id == job.id)
                        .with_for_update()
                        .execution_options(populate_existing=True)
                    )
                ).scalar_one_or_none()
            source = await _lock_source(db, source_kind, source_id)

            _source_gate(source_kind, source, actor, await _fresh_rights(db, source_kind, actor))
            declaration = _operator_declaration(source)
            if (declaration.operator or {}).get("declaration_id") != declaration_id or sc.source_revision(
                source, epoch=queue_sources.current_epoch()
            ) != source_revision:
                raise HTTPException(409, {"error": "source_changed", "message": SOURCE_CHANGED})
            fresh_rights = await _fresh_job_rights(db, actor, job_rights)

            changed, refused = [], []
            for job in picked:
                row = rows[(job.kind, job.id)]
                if row is not None and _visible(row, actor, fresh_rights, printer_scope, job.kind):
                    moved = job.kind == "queue" and row.queue_id not in lanes
                    if moved or job_revision(job.kind, row) != job.revision:
                        changed.append({"kind": job.kind, "id": job.id})
                        continue
                blob = (
                    await db.get(QueueSource, row.queue_source_id) if row is not None and row.queue_source_id else None
                )
                reason = _refusal(
                    job.kind,
                    row,
                    source_kind=source_kind,
                    source_id=source_id,
                    sha256=declaration.sha256,
                    blob=blob,
                    actor=actor,
                    rights=fresh_rights,
                    scope=printer_scope,
                )
                if reason is not None:
                    refused.append({"kind": job.kind, "id": job.id, "reason": reason})
            if changed:
                raise HTTPException(409, {"error": "jobs_changed", "message": JOBS_CHANGED, "jobs": changed})
            if refused:
                raise HTTPException(409, {"error": "job_not_refreshable", "message": NOT_REFRESHABLE, "jobs": refused})

            fact = sc.SourceFact(declaration.value)
            for job in picked:
                row = rows[(job.kind, job.id)]
                row.source_snapshot = sc.snapshot_with_fact(row.source_snapshot, fact)
                refreshed.append({"kind": job.kind, "id": job.id})
                if job.kind == "queue":
                    touched_lanes.add(row.queue_id)
            revision = sc.source_revision(source, epoch=queue_sources.current_epoch())
            from backend.app.services.swap_source_declarations import _audit_line

            db.add(
                _audit_line(
                    operation_id=operation_id,
                    action="refresh",
                    source_kind=source_kind,
                    source_id=source_id,
                    sha256=declaration.sha256,
                    old_value=None,
                    new_value=declaration.value,
                    declaration_id=declaration_id,
                    previous_declaration_id=None,
                    actor_id=actor.user_id,
                    actor_label=actor.label,
                    actor_kind=actor.kind,
                    revision_before=source_revision,
                    revision_after=revision,
                    request_digest=digest,
                    jobs=refreshed,
                    created_at=datetime.now(timezone.utc).replace(tzinfo=None),
                )
            )
            await db.commit()
    except Exception as exc:
        _log(operation_id, source_kind, source_id, "refused", started, _reason(exc))
        raise
    _log(operation_id, source_kind, source_id, "refreshed", started, f"jobs={len(refreshed)}")
    await _announce(touched_lanes)
    return {
        "operation_id": operation_id,
        "declaration_id": declaration_id,
        "value": declaration.value,
        "refreshed": refreshed,
        "replayed": False,
    }


async def _announce(lanes: set[int]) -> None:
    """After the root commit only: the printers whose queues show a refreshed job."""
    try:
        from backend.app.core.websocket import ws_manager

        for printer_id in sorted(lanes):
            await ws_manager.send_queue_changed(printer_id)
    except Exception:  # noqa: BLE001 -- a lost notice is a stale screen, never a failed refresh
        logger.debug("swap refresh: queue notice not sent", exc_info=True)


def _reason(exc: BaseException) -> str:
    detail = getattr(exc, "detail", None)
    if isinstance(detail, dict) and "error" in detail:
        return str(detail["error"])
    status = getattr(exc, "status_code", None)
    return f"http_{status}" if status else type(exc).__name__


def _log(operation: str, kind: str, source_id: int, outcome: str, started: float, note: str | None = None) -> None:
    logger.info(
        "swap job refresh %s kind=%s id=%s outcome=%s elapsed=%.2fs%s",
        operation,
        kind,
        source_id,
        outcome,
        time.monotonic() - started,
        f" {note}" if note else "",
    )
