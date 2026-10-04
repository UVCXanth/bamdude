"""The Workshop's rights in one place (WS-13 E13 §O): the gates, the read view, the second checks.

A route of the Workshop's routers asks its own right through ``RequirePermission``. What it asks
BESIDE that — a stock right for an order door that takes from the shelf, a write-off, a filing
right, a consequence of a delete — is asked here, through the canonical checkers called with the
request's own credentials (``RequestCredentials``), so an API key answers for its scope AND its
owner exactly as at the route gate. Never a hand-written ``has_permission``.

The read view answers which of the four domains (and the shipping right ``stock:move``) the
caller may see. It is computed once per request, lazily — a route that masks nothing never asks —
from the credentials the routers bind (``bind_workshop_credentials``). Without bound credentials
(code running outside a request) everything is visible: masks are a caller's matter.
"""

from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass

from fastapi import Depends, HTTPException

from backend.app.core.auth import (
    RequestCredentials,
    request_credentials,
    require_ownership_permission,
    require_permission,
)
from backend.app.core.permissions import Permission
from backend.app.services.order_filing import FILING_FORBIDDEN

# One checker per right, built once (``RequestCredentials.check`` contract).
GATES = {
    p: require_permission(p)
    for p in (
        Permission.ORDERS_READ,
        Permission.ORDERS_CREATE,
        Permission.ORDERS_UPDATE,
        Permission.ORDERS_DELETE,
        Permission.ORDERS_FILE_PRINTS,
        Permission.PRODUCTS_READ,
        Permission.PRODUCTS_CREATE,
        Permission.PRODUCTS_UPDATE,
        Permission.PRODUCTS_DELETE,
        Permission.CUSTOMERS_READ,
        Permission.CUSTOMERS_CREATE,
        Permission.CUSTOMERS_UPDATE,
        Permission.CUSTOMERS_DELETE,
        Permission.STOCK_READ,
        Permission.STOCK_MOVE,
        Permission.STOCK_ADJUST,
    )
}

# The archive's own update right — the other half of ``F(print)``.
_ARCHIVES_UPDATE = require_ownership_permission(Permission.ARCHIVES_UPDATE_ALL, Permission.ARCHIVES_UPDATE_OWN)


_CREDS: ContextVar[RequestCredentials | None] = ContextVar("workshop_credentials", default=None)
_VIEW: ContextVar[WorkshopView | None] = ContextVar("workshop_view", default=None)


async def bind_workshop_credentials(creds: RequestCredentials = Depends(request_credentials)) -> None:
    """Router dependency: the request's credentials for the read view (nothing is checked here)."""
    _CREDS.set(creds)
    _VIEW.set(None)


@dataclass(frozen=True)
class WorkshopView:
    """What the caller may see. ``ships`` — ``stock:move``: whoever sends the goods sees where."""

    orders: bool = True
    products: bool = True
    customers: bool = True
    stock: bool = True
    ships: bool = True

    @property
    def recipient(self) -> bool:
        """A recipient's contact data (dispatch notes, the issue dialog's default): the people
        who keep the contacts or ship the goods (O25)."""
        return self.customers or self.ships


async def workshop_view() -> WorkshopView:
    view = _VIEW.get()
    if view is not None:
        return view
    creds = _CREDS.get()
    if creds is None:
        view = WorkshopView()
    else:
        view = WorkshopView(
            orders=await creds.allows(GATES[Permission.ORDERS_READ]),
            products=await creds.allows(GATES[Permission.PRODUCTS_READ]),
            customers=await creds.allows(GATES[Permission.CUSTOMERS_READ]),
            stock=await creds.allows(GATES[Permission.STOCK_READ]),
            ships=await creds.allows(GATES[Permission.STOCK_MOVE]),
        )
    _VIEW.set(view)
    return view


async def ensure(creds: RequestCredentials, *permissions: Permission) -> None:
    """Ask each right through its canonical checker; the first refusal is the gate's own 403."""
    for permission in permissions:
        await creds.check(GATES[permission])


async def ensure_coded(creds: RequestCredentials, permission: Permission, code: str) -> None:
    """:func:`ensure` with a machine code the frontend can react to (``{"error": code}``)."""
    try:
        await creds.check(GATES[permission])
    except HTTPException as refused:
        if refused.status_code != 403:
            raise
        raise HTTPException(
            status_code=403,
            detail={"error": code, "message": f"Missing required permissions: {permission.value}"},
        ) from refused


async def ensure_consequence(creds: RequestCredentials, permission: Permission) -> None:
    """A delete whose consequence reaches another domain asks that domain's right too (O24):
    a 403 naming the right, so the dialog can say which consequence is out of reach."""
    try:
        await creds.check(GATES[permission])
    except HTTPException as refused:
        if refused.status_code != 403:
            raise
        raise HTTPException(
            status_code=403,
            detail={
                "error": "consequence_right_required",
                "right": permission.value,
                "message": f"Missing required permissions: {permission.value}",
            },
        ) from refused


async def ensure_may_file(creds: RequestCredentials, archives) -> None:
    """``F(print)`` for every print of a batch, before anything is written (WS-13 E13 O21).

    ``orders:file_prints`` files and unfiles ANY print — a print from the printer's screen or a
    slicer has no owner, and ``archives:update_all`` would also open everybody's photos and
    files. Otherwise ``orders:update`` AND the archive's own update right: ``update_all`` any
    print, ``update_own`` only the caller's own; an ownerless print only ``all``. One print out
    of reach refuses the whole batch."""
    if await creds.allows(GATES[Permission.ORDERS_FILE_PRINTS]):
        return
    await creds.check(GATES[Permission.ORDERS_UPDATE])
    user, can_modify_all = await creds.check(_ARCHIVES_UPDATE)
    if can_modify_all:
        return
    if any(user is None or archive.created_by_id != user.id for archive in archives):
        raise HTTPException(status_code=403, detail="You can only update your own archives")


async def may_file_future(creds: RequestCredentials) -> bool:
    """``Fф`` — work this request creates may be filed under an order: ``orders:file_prints`` or
    ``orders:update`` (the work is nobody's yet; its creator becomes its owner). Beside an
    archive's own update right (the archive editor), the same pair is ``F(print)``."""
    return await creds.allows(GATES[Permission.ORDERS_FILE_PRINTS]) or await creds.allows(
        GATES[Permission.ORDERS_UPDATE]
    )


async def ensure_may_file_future(creds: RequestCredentials) -> None:
    """:func:`may_file_future`, or 403 ``filing_forbidden``."""
    if not await may_file_future(creds):
        raise HTTPException(status_code=403, detail=FILING_FORBIDDEN)


def read_required(domain: str) -> HTTPException:
    """A filter or sort on a field the caller may not see — refused, never silently ignored (O12)."""
    return HTTPException(
        status_code=403,
        detail={"error": "workshop_read_required", "message": f"Missing required permissions: {domain}:read"},
    )
