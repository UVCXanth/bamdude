"""An operator's swap declaration of a source: inspect the bytes, then declare them (swap-source-declaration spec r3 §4-5).

Inspect copies what a reprint would read (the bounded queue-source capture, ``plan_capture`` over the row), checks
it is printable, discards the copy, and answers the bytes' hash, the source's current effective fact and an opaque
revision. Declare copies it AGAIN -- no lease is kept between the two -- and only the very bytes the operator saw,
under an unchanged revision and rights read afresh, get the declaration, written by ``swap_compatibility``'s one
writer together with its audit line in one short transaction. No file I/O happens under a database lock.

The executed run's fact of an archive is never touched here; a library row's hash and metadata are never repaired
here either (an invalid hash asks for the folder's scan first). Who may: the read AND the update right of that very
source (own or all); an API key both scopes; an invisible source is a 404.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import select

from backend.app.core.permissions import Permission
from backend.app.services import queue_sources, swap_compatibility as sc

logger = logging.getLogger(__name__)

SOURCE_KINDS = ("archive", "library")

SOURCE_CHANGED = "The source changed since it was inspected. Inspect it again."
REFRESH_REQUIRED = (
    "This library file has no verified content hash yet. Scan its folder, or upload it again as a new copy, "
    "then inspect it."
)
OPERATION_CONFLICT = "This operation was already used for another declaration."
SOURCE_PRINTING = "This archive is still printing. Declare its source once the print has ended."
RIGHTS_GONE = "You may no longer declare this source."

_PERMISSIONS = {
    "archive": (
        Permission.ARCHIVES_READ_ALL.value,
        Permission.ARCHIVES_READ_OWN.value,
        Permission.ARCHIVES_UPDATE_ALL.value,
        Permission.ARCHIVES_UPDATE_OWN.value,
    ),
    "library": (
        Permission.LIBRARY_READ_ALL.value,
        Permission.LIBRARY_READ_OWN.value,
        Permission.LIBRARY_UPDATE_ALL.value,
        Permission.LIBRARY_UPDATE_OWN.value,
    ),
}
_NOT_FOUND = {"archive": "Archive not found", "library": "File not found"}
_NOT_OWN = {"archive": "You can only update your own archives", "library": "You can only update your own files"}


@dataclass(frozen=True)
class Actor:
    """Who declares, as the audit records it: a signed-in user, or an API key (its owner, if any)."""

    kind: str  # "user" | "api_key"
    user_id: int | None
    label: str
    #: An API key's raw credential, for the rights read afresh before the commit; never logged or stored.
    credential: str | None = None


@dataclass(frozen=True)
class Rights:
    """What the request's gates granted: ``*_all``, else only the caller's own rows."""

    read_all: bool
    update_all: bool


def _model(kind: str):
    if kind == "archive":
        from backend.app.models.archive import PrintArchive

        return PrintArchive
    if kind == "library":
        from backend.app.models.library import LibraryFile

        return LibraryFile
    raise ValueError(f"not a source kind: {kind!r}")


def _mine(row, actor: Actor) -> bool:
    owner = getattr(row, "created_by_id", None)
    return owner is not None and actor.user_id is not None and owner == actor.user_id


def _gate(kind: str, row, actor: Actor, rights: Rights, *, update: bool = True) -> None:
    """Visible (read), then updatable, then in a state a declaration may be made in. Invisible is a 404."""
    if row is None or getattr(row, "deleted_at", None) is not None:
        raise HTTPException(404, _NOT_FOUND[kind])
    mine = _mine(row, actor)
    if not (rights.read_all or mine):
        raise HTTPException(404, _NOT_FOUND[kind])
    if update and not (rights.update_all or mine):
        raise HTTPException(403, _NOT_OWN[kind])
    if update and kind == "archive" and getattr(row, "status", None) == "printing":
        raise HTTPException(409, {"error": "source_printing", "message": SOURCE_PRINTING})


async def actor_for(request, db, user) -> Actor:
    """The actor of a request whose gates passed: the signed-in user, or the API key and its owner."""
    if user is not None:
        return Actor(kind="user", user_id=user.id, label=user.username)
    from backend.app.core.auth import acting_user, is_api_key_token

    credential = request.headers.get("X-API-Key")
    if not credential:
        header = request.headers.get("Authorization", "")
        token = header[7:] if header.startswith("Bearer ") else None
        credential = token if is_api_key_token(token) else None
    owner = await acting_user(request, db, None)
    return Actor(
        kind="api_key",
        user_id=owner.id if owner is not None else None,
        label=f"API key ({owner.username})" if owner is not None else "API key",
        credential=credential,
    )


async def _fresh_rights(db, kind: str, actor: Actor) -> Rights:
    """The actor's rights read again, inside the write transaction: a right revoked while the bytes were being
    read commits nothing (§4). No per-request cache is consulted."""
    read_all, read_own, update_all, update_own = _PERMISSIONS[kind]
    if actor.kind == "api_key":
        from backend.app.core.auth import authorize_api_key, resolve_api_key_authority

        if not actor.credential:
            raise HTTPException(403, RIGHTS_GONE)
        try:
            authority = await resolve_api_key_authority(None, actor.credential)
        except Exception as exc:  # noqa: BLE001 -- any failure to validate is no right
            raise HTTPException(403, RIGHTS_GONE) from exc
        await authorize_api_key(db, authority.key, [read_all, update_all], authority=authority)
        return Rights(read_all=True, update_all=True)

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
        raise HTTPException(403, RIGHTS_GONE)
    may_read_all, may_update_all = user.has_permission(read_all), user.has_permission(update_all)
    if not (may_read_all or user.has_permission(read_own)) or not (may_update_all or user.has_permission(update_own)):
        raise HTTPException(403, RIGHTS_GONE)
    return Rights(read_all=may_read_all, update_all=may_update_all)


async def _capture(request):
    """The bounded queue-source copy, under the dispatcher's own deadline; its typed refusals, never retried."""
    from backend.app.services.background_dispatch import DISPATCH_CAPTURE_DEADLINE_SECONDS
    from backend.app.services.queue_source_capture import capture_for_dispatch, refusal

    try:
        return await capture_for_dispatch(request, deadline=DISPATCH_CAPTURE_DEADLINE_SECONDS)
    except queue_sources.QueueSourceError as exc:
        raise refusal(exc) from exc


async def _read_bytes(kind: str, row, request) -> tuple[str, int]:
    """Copy the source, check it is printable, discard the copy: its hash and size."""
    from backend.app.services.filament_requirements import PrintRequirementsCache
    from backend.app.services.queue_source_capture import discard_staged, staged_requirements

    staged = await _capture(request)
    try:
        await staged_requirements(
            staged,
            PrintRequirementsCache(),
            archive=row if kind == "archive" else None,
            library_file=row if kind == "library" else None,
            allow_raw_gcode=True,
        )
        return staged.receipt.sha256, staged.receipt.size_bytes
    finally:
        await discard_staged(staged)


def _plan(kind: str, row):
    from backend.app.services.queue_source_capture import plan_capture

    return plan_capture(archive=row) if kind == "archive" else plan_capture(library_file=row)


def _require_library_hash(kind: str, row) -> None:
    if kind == "library" and not sc.valid_hash(getattr(row, "file_hash", None)):
        raise HTTPException(409, {"error": "library_refresh_required", "message": REFRESH_REQUIRED})


def _log(operation: str, kind: str, source_id: int, outcome: str, started: float, reason: str | None = None) -> None:
    logger.info(
        "swap declaration %s kind=%s id=%s outcome=%s elapsed=%.2fs%s",
        operation,
        kind,
        source_id,
        outcome,
        time.monotonic() - started,
        f" reason={reason}" if reason else "",
    )


def _reason(exc: BaseException) -> str:
    detail = getattr(exc, "detail", None)
    if isinstance(detail, dict) and "error" in detail:
        return str(detail["error"])
    status = getattr(exc, "status_code", None)
    return f"http_{status}" if status else type(exc).__name__


async def inspect(kind: str, source_id: int, *, actor: Actor, rights: Rights) -> dict:
    """The bytes a reprint would read, their current effective fact and the revision a declaration must match."""
    from backend.app.core.database import async_session

    started = time.monotonic()
    try:
        async with async_session() as db:
            row = await db.get(_model(kind), source_id)
            _gate(kind, row, actor, rights)
            _require_library_hash(kind, row)
            request = _plan(kind, row)
            revision = sc.source_revision(row, epoch=queue_sources.current_epoch())
            current = sc.source_effective(row)
            declared = sc.current_declaration(row)
            display = row.filename
        actual, size = await _read_bytes(kind, row, request)
        if kind == "library" and actual != row.file_hash:
            raise HTTPException(409, {"error": "swap_source_changed", "message": SOURCE_CHANGED})
    except Exception as exc:
        _log("inspect", kind, source_id, "refused", started, _reason(exc))
        raise
    _log("inspect", kind, source_id, "ok", started)
    return {
        "kind": kind,
        "id": source_id,
        "sha256": actual,
        "size_bytes": size,
        "display_filename": display,
        "current": current,
        "known": current is not None,
        "revision": revision,
        "origin": declared.origin if declared is not None else None,
        "declaration_id": (declared.operator or {}).get("declaration_id") if declared is not None else None,
    }


def _request_digest(kind: str, source_id: int, value: bool, expected_sha256: str, expected_revision: str) -> str:
    payload = {"kind": kind, "id": source_id, "value": value, "sha256": expected_sha256, "revision": expected_revision}
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()


def _audit_line(**fields):
    """The audit row of one operation -- its own function, so a refused write is a refused commit."""
    from backend.app.models.swap_source_declaration_audit import SwapSourceDeclarationAudit

    return SwapSourceDeclarationAudit(**fields)


def _replay(previous, row, *, kind: str, source_id: int, digest: str, actor: Actor) -> dict:
    """An operation id already used: the same request by the same actor, whose declaration still stands, answers
    its first result; anything else is a conflict. The caller has already passed the source's gate."""
    current = sc.current_declaration(row)
    same = (
        previous.request_digest == digest
        and previous.source_kind == kind
        and previous.source_id == source_id
        and previous.actor_kind == actor.kind
        and previous.actor_id == actor.user_id
        and current is not None
        and (current.operator or {}).get("declaration_id") == previous.declaration_id
    )
    if not same:
        raise HTTPException(409, {"error": "swap_declaration_conflict", "message": OPERATION_CONFLICT})
    return {
        "kind": kind,
        "id": source_id,
        "declaration_id": previous.declaration_id,
        "value": previous.new_value,
        "sha256": previous.sha256,
        "revision": sc.source_revision(row, epoch=queue_sources.current_epoch()),
        "replayed": True,
    }


async def declare(
    kind: str,
    source_id: int,
    *,
    value: bool,
    expected_sha256: str,
    expected_revision: str,
    operation_id: str,
    actor: Actor,
    rights: Rights,
) -> dict:
    """Declare the source over the bytes the operator inspected -- or refuse, writing nothing."""
    from backend.app.core.database import async_session
    from backend.app.models.swap_source_declaration_audit import SwapSourceDeclarationAudit

    if type(value) is not bool:
        raise HTTPException(422, "A declaration is true or false.")
    started = time.monotonic()
    digest = _request_digest(kind, source_id, value, expected_sha256, expected_revision)
    try:
        async with async_session() as db:
            row = await db.get(_model(kind), source_id)
            _gate(kind, row, actor, rights)
            previous = (
                await db.execute(
                    select(SwapSourceDeclarationAudit).where(SwapSourceDeclarationAudit.operation_id == operation_id)
                )
            ).scalar_one_or_none()
            if previous is not None:
                result = _replay(previous, row, kind=kind, source_id=source_id, digest=digest, actor=actor)
                _log(operation_id, kind, source_id, "replayed", started)
                return result
            _require_library_hash(kind, row)
            if sc.source_revision(row, epoch=queue_sources.current_epoch()) != expected_revision:
                raise HTTPException(409, {"error": "swap_source_changed", "message": SOURCE_CHANGED})
            request = _plan(kind, row)
        actual, _size = await _read_bytes(kind, row, request)
        if actual != expected_sha256:
            raise HTTPException(409, {"error": "swap_source_changed", "message": SOURCE_CHANGED})
        result = await _write(
            kind,
            source_id,
            value=value,
            sha256=actual,
            expected_revision=expected_revision,
            operation_id=operation_id,
            digest=digest,
            actor=actor,
        )
    except Exception as exc:
        _log(operation_id, kind, source_id, "refused", started, _reason(exc))
        raise
    _log(operation_id, kind, source_id, "declared", started)
    return result


async def _locked_row(db, kind: str, source_id: int):
    """The authoritative row under the source's write protocol: an archive's write scope (``load_active_archive_for_
    write``, entered by the caller), a library row's SQLite writer then ``FOR UPDATE``."""
    if kind == "archive":
        from backend.app.services.archive_write_scope import load_active_archive_for_write

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


async def _write(
    kind: str,
    source_id: int,
    *,
    value: bool,
    sha256: str,
    expected_revision: str,
    operation_id: str,
    digest: str,
    actor: Actor,
) -> dict:
    from contextlib import nullcontext

    from backend.app.core.database import async_session
    from backend.app.services.archive_write_scope import archive_write_scope

    async with async_session() as db:
        scope = archive_write_scope(db, source_id) if kind == "archive" else nullcontext()
        async with scope:
            row = await _locked_row(db, kind, source_id)
            _gate(kind, row, actor, await _fresh_rights(db, kind, actor))
            if kind == "library" and (not sc.valid_hash(row.file_hash) or row.file_hash != sha256):
                raise HTTPException(409, {"error": "swap_source_changed", "message": SOURCE_CHANGED})
            if sc.source_revision(row, epoch=queue_sources.current_epoch()) != expected_revision:
                raise HTTPException(409, {"error": "swap_source_changed", "message": SOURCE_CHANGED})
            old_value = sc.source_effective(row)
            replaced = sc.current_declaration(row)
            declaration_id = str(uuid.uuid4())
            now = datetime.now(timezone.utc)
            sc.write_source_declaration(
                row,
                value=value,
                sha256=sha256,
                origin="operator",
                operator={
                    "declaration_id": declaration_id,
                    "declared_at": now.isoformat(),
                    "actor_id": actor.user_id,
                    "actor_label": actor.label,
                    "actor_kind": actor.kind,
                },
            )
            if kind == "library":
                from backend.app.services.library_helpers import sync_system_tags

                await sync_system_tags(db, row)
            revision_after = sc.source_revision(row, epoch=queue_sources.current_epoch())
            db.add(
                _audit_line(
                    operation_id=operation_id,
                    action="declare",
                    source_kind=kind,
                    source_id=source_id,
                    sha256=sha256,
                    old_value=old_value,
                    new_value=value,
                    declaration_id=declaration_id,
                    previous_declaration_id=(replaced.operator or {}).get("declaration_id") if replaced else None,
                    actor_id=actor.user_id,
                    actor_label=actor.label,
                    actor_kind=actor.kind,
                    revision_before=expected_revision,
                    revision_after=revision_after,
                    request_digest=digest,
                    created_at=now.replace(tzinfo=None),
                )
            )
            await db.commit()
    return {
        "kind": kind,
        "id": source_id,
        "declaration_id": declaration_id,
        "value": value,
        "sha256": sha256,
        "revision": revision_after,
        "replayed": False,
    }


async def history(kind: str, source_id: int, *, actor: Actor, rights: Rights) -> list[dict]:
    """The current declaration's chain -- never every audit row filed under a (possibly reused) source id."""
    from backend.app.core.database import async_session
    from backend.app.models.swap_source_declaration_audit import SwapSourceDeclarationAudit as Audit

    async with async_session() as db:
        row = await db.get(_model(kind), source_id)
        _gate(kind, row, actor, rights, update=False)
        current = sc.current_declaration(row)
        declaration_id = (current.operator or {}).get("declaration_id") if current is not None else None
        chain: list[dict] = []
        seen: set[str] = set()
        while declaration_id and declaration_id not in seen:
            seen.add(declaration_id)
            line = (
                await db.execute(
                    select(Audit)
                    .where(
                        Audit.declaration_id == declaration_id, Audit.source_kind == kind, Audit.source_id == source_id
                    )
                    .where(Audit.action.in_(("declare", "restore")))
                    .order_by(Audit.id)
                    .limit(1)
                )
            ).scalar_one_or_none()
            if line is None:
                break
            chain.append(
                {
                    "declaration_id": line.declaration_id,
                    "action": line.action,
                    "old_value": line.old_value,
                    "new_value": line.new_value,
                    "sha256": line.sha256,
                    "actor_label": line.actor_label,
                    "actor_kind": line.actor_kind,
                    "created_at": line.created_at.isoformat() if line.created_at else None,
                }
            )
            declaration_id = line.previous_declaration_id
        return chain
