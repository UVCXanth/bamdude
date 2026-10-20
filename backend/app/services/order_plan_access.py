"""Authority rechecked on the plan/publication's own database connection."""

from dataclasses import dataclass

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from backend.app.core.api_key_scope import key_printer_scope, narrowed_scope
from backend.app.core.auth import authorize_api_key, library_name_scope
from backend.app.models.api_key import APIKey
from backend.app.models.user import User
from backend.app.services.swap_source_declarations import Actor, actor_for, fresh_api_key


@dataclass(frozen=True)
class PlanAccess:
    actor: Actor
    scope: str
    printers: frozenset[int] | None
    key_hash: str | None = None

    @property
    def identity(self):
        return f"key:{self.actor.key_id}" if self.actor.kind == "api_key" else f"user:{self.actor.user_id}"


async def capture(request, db, user):
    actor = await actor_for(request, db, user)
    key = await db.get(APIKey, actor.key_id) if actor.key_id else None
    return PlanAccess(
        actor, await library_name_scope(request, db, user), key_printer_scope(request), key.key_hash if key else None
    )


async def fresh(db, access: PlanAccess, *, edit=True, execute=False, receipts=False, delete=False):
    actor = access.actor
    if actor.kind == "api_key":
        key = await fresh_api_key(db, actor)
        if key.key_hash != access.key_hash or key.user_id != actor.user_id:
            raise HTTPException(403, "plan_authority_changed")
        await authorize_api_key(db, key, ["orders:read"] + (["queue:create"] if execute else []))
        if delete:
            await authorize_api_key(db, key, ["orders:delete"])
        if edit:
            await authorize_api_key(db, key, ["orders:update", "orders:file_prints"], require_any=True)
        if receipts:
            await authorize_api_key(db, key, ["queue:read_all", "queue:read_own"], require_any=True)
        try:
            await authorize_api_key(db, key, ["library:read_all"])
            scope = "all"
        except HTTPException:
            try:
                await authorize_api_key(db, key, ["library:read_own"])
                scope = "own"
            except HTTPException:
                scope = "none"
        printers = narrowed_scope(access.printers, key)
        user = await db.get(User, actor.user_id) if actor.user_id else None
    else:
        user = await db.scalar(
            select(User)
            .options(selectinload(User.groups))
            .where(User.id == actor.user_id)
            .execution_options(populate_existing=True)
        )
        if user is None or not user.is_active or not user.has_permission("orders:read"):
            raise HTTPException(403, "plan_authority_changed")
        if edit and not (user.has_permission("orders:update") or user.has_permission("orders:file_prints")):
            raise HTTPException(403, "plan_authority_changed")
        if execute and not user.has_permission("queue:create"):
            raise HTTPException(403, "plan_authority_changed")
        if delete and not user.has_permission("orders:delete"):
            raise HTTPException(403, "plan_authority_changed")
        if receipts and not (user.has_permission("queue:read_all") or user.has_permission("queue:read_own")):
            raise HTTPException(403, "plan_authority_changed")
        scope = (
            "all"
            if user.has_permission("library:read_all")
            else "own"
            if user.has_permission("library:read_own")
            else "none"
        )
        printers = access.printers
    # A later grant can only narrow what the request originally obtained.
    if access.scope == "none" or scope == "none":
        scope = "none"
    elif access.scope == "own":
        scope = "own"
    return user, scope, printers


def visible(file, user, scope):
    return file.deleted_at is None and (
        scope == "all" or scope == "own" and user is not None and file.created_by_id == user.id
    )
