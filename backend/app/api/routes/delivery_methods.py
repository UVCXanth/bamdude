"""The delivery-method reference a customer's contacts pick from (spec workshop-customers, rules 7, 16).

Lives under the projects permissions, like the customers it serves. The details
of a delivery (branch, locker, address) are each contact's own text; here is
only the list of ways. A method in use is never deleted — the reference of an
accounting system must not quietly drop what a record says — but it can always
be renamed, and every contact shows the new name (it is read through the join).
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import RequirePermission
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.customer import CustomerContact, DeliveryMethod, delivery_method_key
from backend.app.models.user import User
from backend.app.schemas.delivery_method import DeliveryMethodIn, DeliveryMethodOrder, DeliveryMethodOut

router = APIRouter(prefix="/delivery-methods", tags=["customers"])


async def _listing(db: AsyncSession) -> list[DeliveryMethodOut]:
    counts = dict(
        (
            await db.execute(
                select(CustomerContact.delivery_method_id, func.count(CustomerContact.id))
                .where(CustomerContact.delivery_method_id.is_not(None))
                .group_by(CustomerContact.delivery_method_id)
            )
        ).all()
    )
    rows = (await db.execute(select(DeliveryMethod).order_by(DeliveryMethod.position, DeliveryMethod.id))).scalars()
    return [
        DeliveryMethodOut(id=m.id, name=m.name, position=m.position, contacts_count=counts.get(m.id, 0)) for m in rows
    ]


# The ``name_key`` column's width: ``casefold()`` can grow a name (ß → ss), so a name the
# schema accepts may still fold past it (WS-13 E11 A03).
_KEY_MAX = DeliveryMethod.__table__.c.name_key.type.length


async def _refuse_duplicate(db: AsyncSession, name: str, own_id: int | None = None) -> None:
    # Before the write: on PostgreSQL an overlong key is a DataError — a 500, not a refusal.
    if len(delivery_method_key(name)) > _KEY_MAX:
        raise HTTPException(status_code=422, detail="The name is too long")
    clash = await db.scalar(select(DeliveryMethod.id).where(DeliveryMethod.name_key == delivery_method_key(name)))
    if clash is not None and clash != own_id:
        raise HTTPException(status_code=409, detail="A delivery method with this name already exists")


async def _get_or_404(db: AsyncSession, method_id: int) -> DeliveryMethod:
    method = await db.get(DeliveryMethod, method_id)
    if method is None:
        raise HTTPException(status_code=404, detail="Delivery method not found")
    return method


@router.get("", response_model=list[DeliveryMethodOut])
@router.get("/", response_model=list[DeliveryMethodOut])
async def list_delivery_methods(
    db: AsyncSession = Depends(get_db), _: User | None = RequirePermission(Permission.PROJECTS_READ)
):
    return await _listing(db)


@router.post("", response_model=DeliveryMethodOut)
@router.post("/", response_model=DeliveryMethodOut)
async def create_delivery_method(
    data: DeliveryMethodIn,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_UPDATE),
):
    await _refuse_duplicate(db, data.name)
    last = await db.scalar(select(func.max(DeliveryMethod.position)))
    method = DeliveryMethod(name=data.name, name_key=delivery_method_key(data.name), position=(last or 0) + 1)
    db.add(method)
    await db.flush()
    return DeliveryMethodOut(id=method.id, name=method.name, position=method.position, contacts_count=0)


@router.put("/order", response_model=list[DeliveryMethodOut])
async def reorder_delivery_methods(
    data: DeliveryMethodOrder,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_UPDATE),
):
    methods = {m.id: m for m in (await db.execute(select(DeliveryMethod))).scalars()}
    if len(data.ids) != len(set(data.ids)) or set(data.ids) != set(methods):
        raise HTTPException(status_code=422, detail="The order must name every delivery method exactly once")
    for position, method_id in enumerate(data.ids):
        methods[method_id].position = position
    await db.flush()
    return await _listing(db)


@router.patch("/{method_id}", response_model=DeliveryMethodOut)
async def rename_delivery_method(
    method_id: int,
    data: DeliveryMethodIn,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_UPDATE),
):
    method = await _get_or_404(db, method_id)
    await _refuse_duplicate(db, data.name, own_id=method.id)
    method.name = data.name
    method.name_key = delivery_method_key(data.name)
    await db.flush()
    return next(m for m in await _listing(db) if m.id == method.id)


@router.delete("/{method_id}")
async def delete_delivery_method(
    method_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_UPDATE),
):
    method = await _get_or_404(db, method_id)
    used = await db.scalar(
        select(func.count(CustomerContact.id)).where(CustomerContact.delivery_method_id == method.id)
    )
    if used:
        # Count-first wording: it reads right for one contact and for many.
        raise HTTPException(status_code=409, detail=f"Contacts using this delivery method: {used}")
    await db.delete(method)
    return {"message": "Delivery method deleted"}
