"""A product's stored plate facets — material, colour, printer model — ONE writer
(spec workshop-product-catalog, rules 3–7).

The catalog filters and searches by them in SQL, so they are stored rather than
parsed out of every linked file's JSON on each request (owner, 2026-09-26). The
plates they come from have one writer too (``product_sync``), and a file's
metadata is not rewritten after it is created, so refreshing here whenever
``product_sync`` reconciles a file keeps them true. Every linked plate counts,
a trashed file's too: trashing is restorable and does not pass through the sync.

Rows are replaced with Core statements, never ORM objects: a reader in the same
session may hold the old rows in its identity map, and a new object with the
same primary key would collide with them at flush.
"""

from collections.abc import Iterable

from sqlalchemy import delete, insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.library import LibraryFile
from backend.app.models.product import Product, ProductFacet, ProductPlate
from backend.app.services.product_composition import plate_colors, plate_materials
from backend.app.utils.printer_models import normalize_model_name

# ``product_facets.value`` is VARCHAR(64).
_VALUE_LENGTH = 64


def facets_of(meta: dict | None, plate_index: int) -> set[tuple[str, str]]:
    """The facets one plate contributes, normalised as ``product_composition`` reads them."""
    out = {("material", m) for m in plate_materials(meta, plate_index)}
    out |= {("color", c) for c in plate_colors(meta, plate_index)}
    raw = (meta or {}).get("sliced_for_model")
    if isinstance(raw, str) and (model := normalize_model_name(raw)):
        out.add(("model", model))
    return {(kind, value[:_VALUE_LENGTH]) for kind, value in out if value}


async def refresh(db: AsyncSession, product_ids: Iterable[int]) -> None:
    """Recompute the facets of these products from their plates. Never commits."""
    ids = sorted(set(product_ids))
    if not ids:
        return
    rows = (
        await db.execute(
            select(ProductPlate.product_id, ProductPlate.plate_index, LibraryFile.file_metadata)
            .join(LibraryFile, LibraryFile.id == ProductPlate.library_file_id)
            .where(ProductPlate.product_id.in_(ids))
        )
    ).all()
    wanted: dict[int, set[tuple[str, str]]] = {pid: set() for pid in ids}
    for product_id, plate_index, meta in rows:
        wanted[product_id] |= facets_of(meta, plate_index)
    await db.execute(delete(ProductFacet).where(ProductFacet.product_id.in_(ids)))
    values = [
        {"product_id": product_id, "kind": kind, "value": value}
        for product_id, facets in wanted.items()
        for kind, value in sorted(facets)
    ]
    if values:
        await db.execute(insert(ProductFacet), values)


async def refresh_all(db: AsyncSession) -> None:
    await refresh(db, (await db.execute(select(Product.id))).scalars().all())


async def delete_for_product(db: AsyncSession, product_id: int) -> None:
    """SQLite runs no FK actions — the product's rows go in code."""
    await db.execute(delete(ProductFacet).where(ProductFacet.product_id == product_id))
