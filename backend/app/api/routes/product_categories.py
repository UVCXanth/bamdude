"""The product category directory (spec workshop-product-catalog, rules 2 and 16).

A directory, not free text: «Лампи» and «лампи » are one category, and a rename
is one row — every product shows the new name through the join. Lives under the
projects permissions, like the products it files. Deleting a category leaves
its products uncategorized; that is done here in code, since SQLite runs no FK
actions (the ``ON DELETE SET NULL`` is PostgreSQL's backstop).
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes._workshop_rights import bind_workshop_credentials
from backend.app.core.auth import RequirePermission
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.product import Product
from backend.app.models.product_category import ProductCategory, category_key
from backend.app.models.user import User
from backend.app.schemas.product_category import ProductCategoryIn, ProductCategoryOut

router = APIRouter(prefix="/product-categories", tags=["products"], dependencies=[Depends(bind_workshop_credentials)])


async def _listing(db: AsyncSession, only_id: int | None = None) -> list[ProductCategoryOut]:
    count = func.count(Product.id)
    stmt = (
        select(ProductCategory.id, ProductCategory.name, count)
        .outerjoin(Product, Product.category_id == ProductCategory.id)
        .group_by(ProductCategory.id, ProductCategory.name)
        .order_by(func.lower(ProductCategory.name), ProductCategory.id)
    )
    if only_id is not None:
        stmt = stmt.where(ProductCategory.id == only_id)
    return [ProductCategoryOut(id=i, name=n, products_count=c) for i, n, c in (await db.execute(stmt)).all()]


_NAME_TAKEN = "A category with this name already exists"


async def _refuse_duplicate(db: AsyncSession, name: str, own_id: int | None = None) -> None:
    clash = await db.scalar(select(ProductCategory.id).where(ProductCategory.name_key == category_key(name)))
    if clash is not None and clash != own_id:
        raise HTTPException(status_code=409, detail=_NAME_TAKEN)


async def _flush_name(db: AsyncSession) -> None:
    """Two saves can pass the duplicate check at once; the unique key settles the
    race, and the loser hears the same 409 — never a 500."""
    try:
        await db.flush()
    except IntegrityError as e:
        raise HTTPException(status_code=409, detail=_NAME_TAKEN) from e


async def _get_or_404(db: AsyncSession, category_id: int) -> ProductCategory:
    category = await db.get(ProductCategory, category_id)
    if category is None:
        raise HTTPException(status_code=404, detail="Category not found")
    return category


@router.get("", response_model=list[ProductCategoryOut])
@router.get("/", response_model=list[ProductCategoryOut])
async def list_product_categories(
    db: AsyncSession = Depends(get_db), _: User | None = RequirePermission(Permission.PRODUCTS_READ)
):
    return await _listing(db)


@router.post("", response_model=ProductCategoryOut)
@router.post("/", response_model=ProductCategoryOut)
async def create_product_category(
    data: ProductCategoryIn,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PRODUCTS_UPDATE),
):
    await _refuse_duplicate(db, data.name)
    category = ProductCategory(name=data.name, name_key=category_key(data.name))
    db.add(category)
    await _flush_name(db)
    return ProductCategoryOut(id=category.id, name=category.name, products_count=0)


@router.patch("/{category_id}", response_model=ProductCategoryOut)
async def rename_product_category(
    category_id: int,
    data: ProductCategoryIn,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PRODUCTS_UPDATE),
):
    category = await _get_or_404(db, category_id)
    await _refuse_duplicate(db, data.name, own_id=category.id)
    category.name = data.name
    category.name_key = category_key(data.name)
    await _flush_name(db)
    return (await _listing(db, only_id=category.id))[0]


@router.delete("/{category_id}")
async def delete_product_category(
    category_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PRODUCTS_UPDATE),
):
    category = await _get_or_404(db, category_id)
    cleared = (
        await db.execute(update(Product).where(Product.category_id == category.id).values(category_id=None))
    ).rowcount
    await db.delete(category)
    await db.flush()
    return {"message": "Category deleted", "uncategorized": cleared or 0}
