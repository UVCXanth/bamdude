"""Products (вироби) — catalog entities: composition, plate recipes, links.

Card fields, typed attachments, the cover and export/import all live here;
the columns behind them predate the routes. Permissions: the projects family
(spec §API).

⚠️ **No route here writes ``product_files`` or ``product_folders``.** The link
tables are owned by ``services/product_sync.py``, which keeps the pivot, the
``product_plates`` rows and the seeded parts in step with each other — three
things a route rewriting one table by hand would silently let drift apart. A
route's whole job is to work out what the file's (or folder's) FULL product set
should now be and hand that to the sync; the delta is the service's business.
The one exception is :func:`delete_product`, which drops its own pivot rows —
SQLite honours no ``ON DELETE CASCADE``, and there is no desired set left to
reconcile once the product itself is going away.
"""

import asyncio
import logging
import os
import shutil
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import and_, delete, exists, func, inspect as sqla_inspect, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from starlette.background import BackgroundTask
from starlette.datastructures import UploadFile as StarletteUploadFile

from backend.app.core.auth import RequireCameraStreamToken, RequirePermission
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.i18n.api_errors import json_error
from backend.app.models.finished_stock import StockItem, StockItemChoice
from backend.app.models.library import LibraryFile, LibraryFolder
from backend.app.models.line_config import ProjectLineChoice
from backend.app.models.product import (
    FACET_KINDS,
    Product,
    ProductFacet,
    ProductOrigin,
    ProductPart,
    ProductPlate,
    product_files,
    product_folders,
    sku_key,
)
from backend.app.models.product_category import ProductCategory
from backend.app.models.product_variant import ProductVariantGroup, ProductVariantOption, variant_key
from backend.app.models.project_line import ProjectLine, ProjectProcurement
from backend.app.models.user import User
from backend.app.schemas.listing import (
    CategoryCount,
    ProductFacetsOut,
    ProductListPage,
    ProductPartProductOut,
    ProductPartRow,
    ProductPartsPage,
    ProductPartVariantOut,
)
from backend.app.schemas.product import (
    AttachmentOrderRequest,
    CoverPickRequest,
    FileLinkRequest,
    FolderLinkRequest,
    PlateRecipeResponse,
    PlateUnassignedEntry,
    PlateYieldEntry,
    ProductAttachmentOut,
    ProductCategoryRef,
    ProductCreate,
    ProductDuplicate,
    ProductImportResponse,
    ProductKitsOut,
    ProductListItem,
    ProductPartAlias,
    ProductPartCreate,
    ProductPartMerge,
    ProductPartResponse,
    ProductPartUpdate,
    ProductResponse,
    ProductStockOut,
    ProductUpdate,
    RereadResponse,
    StockAdjustIn,
    StockBalanceOut,
    StockMovementOut,
    VariantGroupCreate,
    VariantGroupOut,
    VariantGroupUpdate,
    VariantOptionCreate,
    VariantOptionOut,
    VariantOptionUpdate,
)
from backend.app.services import finished_stock, line_config, part_stock, product_delete, product_facets
from backend.app.services.entity_codes import code_for, id_from_query
from backend.app.services.line_composition import composition, default_options, standard_composition
from backend.app.services.list_paging import (
    SortSpec,
    apply_sql_sort,
    like_contains,
    page_meta,
    resolve_sort,
    slice_page,
    sort_computed,
)
from backend.app.services.part_names import canonicalize, name_key
from backend.app.services.product_card import (
    export_zip,
    fill_from_file,
    import_zip,
    read_card,
    units_printed_total,
    usable_title,
)
from backend.app.services.product_composition import (
    add_alias,
    estimate_seconds,
    merge_parts,
    purchased_name_key,
    recipes_for_product,
    remove_alias,
)
from backend.app.services.product_files import (
    ATTACHMENT_CATEGORIES,
    CATEGORY_EXTENSIONS,
    COVER_EXTENSIONS,
    SOURCE_MANUAL,
    attachment_entry,
    attachment_limit,
    category_entries,
    effective_cover,
    exceeds_attachment_limit,
    image_media_type,
    import_limit,
    next_sort_order,
    product_attachments_dir,
    safe_attachment_name,
    sorted_attachments,
)
from backend.app.services.product_sync import apply_folder_products, sync_product_for_file
from backend.app.services.stock_views import movement_out, orders_of_lines
from backend.app.utils.http import build_content_disposition
from backend.app.utils.printer_models import normalize_model_name

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/products", tags=["products"])

_LOAD = (
    selectinload(Product.parts),
    selectinload(Product.plates),
    selectinload(Product.library_files),
    selectinload(Product.library_folders),
)


async def _get(db: AsyncSession, product_id: int) -> Product:
    product = (await db.execute(select(Product).options(*_LOAD).where(Product.id == product_id))).scalar_one_or_none()
    if product is None:
        raise HTTPException(status_code=404, detail="Product not found")
    return product


async def _lines_count(db: AsyncSession, product_id: int) -> int:
    return (
        await db.execute(select(func.count(ProjectLine.id)).where(ProjectLine.product_id == product_id))
    ).scalar() or 0


async def _plates_count(db: AsyncSession, product_ids: list[int]) -> dict[int, int]:
    """Plates per product, counting only those a printer could still be sent.

    ⚠️ NOT ``len(product.plates)``. A trashed file is restorable, so its
    ``product_plates`` rows stay — and ``recipes_for_product`` (which is what
    ``GET /plates`` lists and what the plan engine offers) drops them. Counting
    the links instead made the card promise plates the plate list did not show.
    One grouped query, so the list endpoint pays for it once.
    """
    if not product_ids:
        return {}
    rows = await db.execute(
        select(ProductPlate.product_id, func.count(ProductPlate.id))
        .join(LibraryFile, LibraryFile.id == ProductPlate.library_file_id)
        .where(ProductPlate.product_id.in_(product_ids), LibraryFile.deleted_at.is_(None))
        .group_by(ProductPlate.product_id)
    )
    return dict(rows.all())


async def _timestamps(db: AsyncSession, product: Product) -> tuple[datetime, datetime]:
    """``created_at`` / ``updated_at`` come from server-side defaults, so an
    INSERT or an UPDATE leaves them expired — and reading an expired attribute
    inside an async session is a ``MissingGreenlet``, not a lazy SELECT.

    ⚠️ A plain SELECT, never ``db.refresh(product, ["created_at", ...])``: a
    partial refresh ALSO unloads the collections ``_get`` eager-loaded (and the
    empty ones a freshly built row starts with), so the caller would have to
    reload all four just to count them. Nothing is read when nothing expired,
    which is the ordinary GET.
    """
    if not ({"created_at", "updated_at"} & sqla_inspect(product).unloaded):
        return product.created_at, product.updated_at
    row = (await db.execute(select(Product.created_at, Product.updated_at).where(Product.id == product.id))).one()
    return row[0], row[1]


def _with_balance(part: ProductPart, part_balances: dict[int, int]) -> ProductPartResponse:
    """One part on the wire, carrying its free-stock balance.

    ``stock_balance`` is a SUM over the ledger and never a column (see
    ``models/part_stock``), so it has to be poured in from the outside. A part
    absent from ``part_balances`` reads 0 and that is the right answer: only a
    COUNTED part has a balance at all, and a purchased one never will.
    """
    return ProductPartResponse.model_validate(part).model_copy(update={"stock_balance": part_balances.get(part.id, 0)})


async def _part_out(db: AsyncSession, part: ProductPart) -> ProductPartResponse:
    """:func:`_with_balance` for a route that answers with ONE part.

    Reads the ledger rather than defaulting to 0, because a merge moves stock
    onto the surviving row — a part route that answered ``stock_balance: 0``
    there would be telling the page the shelf had just been emptied.
    """
    return _with_balance(part, await part_stock.balances(db, part.product_id))


# spec workshop-product-catalog, rules 13–15: the catalog fields travel apart
# from the plain columns — each has a rule the route checks before it writes.
CATALOG_FIELDS = ("sku", "version", "category_id", "status")
_SKU_TAKEN = "Another product already has this SKU"


async def _sku_clash(db: AsyncSession, key: str, product_id: int) -> int | None:
    """Another product holding this SKU key, if any."""
    return await db.scalar(select(Product.id).where(Product.sku_key == key, Product.id != product_id))


async def _flush_catalog(db: AsyncSession) -> None:
    """Flush a product's catalog fields. The SKU is checked before the write, but
    two saves can pass that check at once; the unique index settles the race, and
    the loser hears the same 409 — never a 500."""
    try:
        await db.flush()
    except IntegrityError as e:
        if "sku_key" in str(e.orig):
            raise HTTPException(status_code=409, detail=_SKU_TAKEN) from e
        raise


def _catalog_out(product: Product) -> dict:
    """The catalog fields of a list row or a product response."""
    category = product.category
    return {
        "sku": product.sku,
        "version": product.version,
        "category": ProductCategoryRef(id=category.id, name=category.name) if category else None,
        "status": product.status,
    }


async def _apply_catalog_fields(db: AsyncSession, product: Product, fields: dict) -> None:
    """SKU, version, category and status with their rules (spec workshop-product-catalog, 14–15).

    Every check runs before the first write, so a refusal leaves the row as it was.
    """
    sku = fields.get("sku")
    key = sku_key(sku) if sku else None
    if "sku" in fields and key and await _sku_clash(db, key, product.id) is not None:
        raise HTTPException(status_code=409, detail=_SKU_TAKEN)
    category_id = fields.get("category_id")
    if "category_id" in fields and category_id is not None and await db.get(ProductCategory, category_id) is None:
        raise HTTPException(status_code=422, detail="Category not found")
    if fields.get("status") == "ready" and product.status != "ready":
        parts = await db.scalar(select(func.count(ProductPart.id)).where(ProductPart.product_id == product.id))
        # The plates the lists show — a trashed file's plate is no plate.
        plates = (await _plates_count(db, [product.id])).get(product.id, 0)
        if not parts or not plates:
            raise HTTPException(status_code=409, detail="A product needs parts and a plate to be ready to print")

    if "sku" in fields:
        product.sku, product.sku_key = sku, key
    if "version" in fields:
        product.version = fields["version"]
    if "category_id" in fields:
        product.category_id = category_id
        # The joined relationship was loaded with the old value.
        product.category = await db.get(ProductCategory, category_id) if category_id is not None else None
    if fields.get("status") is not None:
        product.status = fields["status"]


async def _standard_kits(db: AsyncSession, product: Product, part_balances: dict[int, int]) -> int:
    """Kits of the product's STANDARD configuration (spec workshop-product-variants, rule 22)."""
    defaults = (await default_options(db, [product.id])).get(product.id, {})
    return part_stock.kits_of(part_balances, standard_composition(list(product.parts), set(defaults.values())))


async def _variant_groups(db: AsyncSession, product_id: int) -> list[ProductVariantGroup]:
    """The product's groups with their options, fresh — a route may have just
    written them with the collections already loaded."""
    return list(
        (
            await db.execute(
                select(ProductVariantGroup)
                .options(selectinload(ProductVariantGroup.options))
                .where(ProductVariantGroup.product_id == product_id)
                .order_by(ProductVariantGroup.position, ProductVariantGroup.id)
                .execution_options(populate_existing=True)
            )
        )
        .scalars()
        .all()
    )


async def _variant_groups_out(db: AsyncSession, product_id: int) -> list[VariantGroupOut]:
    """Groups on the wire, each option with what would refuse its delete — two grouped reads."""
    groups = await _variant_groups(db, product_id)
    option_ids = [o.id for g in groups for o in g.options]
    lines: dict[int, int] = {}
    parts: dict[int, int] = {}
    stock: dict[int, int] = {}
    if option_ids:
        stock = dict(
            (
                await db.execute(
                    select(StockItemChoice.option_id, func.count())
                    .where(StockItemChoice.option_id.in_(option_ids))
                    .group_by(StockItemChoice.option_id)
                )
            ).all()
        )
        lines = dict(
            (
                await db.execute(
                    select(ProjectLineChoice.option_id, func.count())
                    .where(ProjectLineChoice.option_id.in_(option_ids))
                    .group_by(ProjectLineChoice.option_id)
                )
            ).all()
        )
        parts = dict(
            (
                await db.execute(
                    select(ProductPart.variant_option_id, func.count())
                    .where(ProductPart.variant_option_id.in_(option_ids))
                    .group_by(ProductPart.variant_option_id)
                )
            ).all()
        )
    return [
        VariantGroupOut(
            id=g.id,
            name=g.name,
            position=g.position,
            default_option_id=g.default_option_id,
            options=[
                VariantOptionOut(
                    id=o.id,
                    name=o.name,
                    position=o.position,
                    lines_count=lines.get(o.id, 0),
                    parts_count=parts.get(o.id, 0),
                    stock_count=stock.get(o.id, 0),
                )
                for o in g.options
            ],
        )
        for g in groups
    ]


async def _response(db: AsyncSession, product: Product, *, reload_links: bool = False) -> ProductResponse:
    # ``category`` too: a row built in this request (a copy, a new product) has
    # it unloaded, and reading it would be a lazy load the async session refuses.
    links = ["parts", "plates", "library_files", "library_folders", "category"]
    # ``reload_links`` — a sync ran, and it wrote ``product_files`` /
    # ``product_plates`` with core SQL underneath the ORM, so what is loaded is
    # stale. ``unloaded`` — a row built and flushed in this request never had
    # its collections initialised, and touching one now would be a lazy load,
    # i.e. a ``MissingGreenlet``. A plain GET or PATCH is neither, and pays for
    # neither: ``_get`` already eager-loaded all four.
    if reload_links or set(links) & sqla_inspect(product).unloaded:
        await db.refresh(product, links)
    created_at, updated_at = await _timestamps(db, product)
    # ONE ledger read per response, feeding both the per-part balance and the
    # kit count — the two are the same numbers asked twice, and reading them
    # apart is how they would start to disagree on the same screen.
    part_balances = await part_stock.balances(db, product.id)
    return ProductResponse(
        id=product.id,
        code=code_for("product", product.id),
        name=product.name,
        is_active=product.is_active,
        **_catalog_out(product),
        cover_image_filename=product.cover_image_filename,
        has_cover=effective_cover(product) is not None,
        parts_count=len(product.parts),
        plates_count=(await _plates_count(db, [product.id])).get(product.id, 0),
        lines_count=await _lines_count(db, product.id),
        description=product.description,
        notes=product.notes,
        designer=product.designer,
        license=product.license,
        source_url=product.source_url,
        design_id=product.design_id,
        attachments=sorted_attachments(product),
        kits_available=await _standard_kits(db, product, part_balances),
        parts=[_with_balance(p, part_balances) for p in sorted(product.parts, key=lambda p: (p.sort_order, p.id))],
        variant_groups=await _variant_groups_out(db, product.id),
        library_file_ids=sorted(f.id for f in product.library_files),
        library_folder_ids=sorted(f.id for f in product.library_folders),
        units_printed_total=await units_printed_total(db, product.id),
        origin=product.origin,
        origin_file_id=product.origin_file_id,
        origin_plate_index=product.origin_plate_index,
        created_at=created_at,
        updated_at=updated_at,
    )


async def _file_product_ids(db: AsyncSession, file_id: int) -> set[int]:
    """Every product this file currently belongs to, read off the pivot itself.

    The sync is handed a FULL desired set, never a delta, so a route that adds
    or drops one product must first ask who else is on the file — otherwise the
    call evicts every other product from the pivot and takes their plates with it.
    """
    return set(
        (await db.execute(select(product_files.c.product_id).where(product_files.c.library_file_id == file_id)))
        .scalars()
        .all()
    )


async def _folder_product_ids(db: AsyncSession, folder_id: int) -> set[int]:
    """The folder twin of :func:`_file_product_ids`, same full-set reason."""
    return set(
        (await db.execute(select(product_folders.c.product_id).where(product_folders.c.library_folder_id == folder_id)))
        .scalars()
        .all()
    )


async def _apply_folder(db: AsyncSession, folder_id: int, product_ids: set[int]) -> None:
    """The folder door: it owns the folder's own ``product_folders`` row AND the
    ``product_files`` link of every child, then reconciles their plates."""
    try:
        await apply_folder_products(db, folder_id=folder_id, product_ids=sorted(product_ids))
    except ValueError as e:  # names product ids that do not exist; nothing was mutated
        raise HTTPException(status_code=404, detail=str(e)) from e


_PRODUCT_SORT = SortSpec(
    sql={
        "name": (func.lower(Product.name), False),
        "updated": (Product.updated_at, False),
        "created": (Product.created_at, False),
        # spec workshop-product-catalog, rule 10 — no SKU / no category sorts last.
        "sku": (func.lower(Product.sku), True),
        "category": (func.lower(ProductCategory.name), True),
        "status": (Product.status, False),
    },
    computed={"parts", "plates", "orders", "kits"},
    default="name-asc",
)
_PRODUCT_COMPUTED = {
    "parts": lambda r: r.parts_count,
    "plates": lambda r: r.plates_count,
    "orders": lambda r: r.lines_count,
    "kits": lambda r: r.kits_available,
}


def _word_matches(word: str):
    """One search word against every field of a product (spec workshop-product-catalog, rule 8).

    A trashed file is not searched — neither its name nor its facets: the product
    page does not show it either (owner, 2026-09-27)."""
    needle = like_contains(word)

    def like(column):
        return column.ilike(needle, escape="\\")

    fields = [
        like(Product.name),
        like(Product.sku),
        like(ProductCategory.name),
        exists().where(ProductPart.product_id == Product.id, like(ProductPart.name)),
        exists().where(
            product_files.c.product_id == Product.id,
            LibraryFile.id == product_files.c.library_file_id,
            LibraryFile.deleted_at.is_(None),
            like(LibraryFile.filename),
        ),
        product_facets.visible_facet(like(ProductFacet.value)),
    ]
    if (product_id := id_from_query("product", word)) is not None:
        fields.append(Product.id == product_id)
    return or_(*fields)


def _has_facet(kind: str, value: str):
    # Stored as ``product_facets.facets_of`` writes them: materials and colours
    # upper-cased, a model through ``normalize_model_name`` — so ``x1c`` and
    # «Bambu Lab X1 Carbon» from a link find the same printer.
    raw = value.strip()
    if kind == "model":
        wanted = normalize_model_name(raw) or raw
    else:
        wanted = raw.upper()
    return product_facets.visible_facet(ProductFacet.kind == kind, ProductFacet.value == wanted)


async def _in_stock_ids(db: AsyncSession, conditions: list) -> list[int]:
    """The products under ``conditions`` with at least one free kit — ``kits_available``,
    the same number the row shows, for every candidate in two grouped reads."""
    ids = (
        (
            await db.execute(
                select(Product.id)
                .outerjoin(ProductCategory, ProductCategory.id == Product.category_id)
                .where(*conditions)
            )
        )
        .scalars()
        .all()
    )
    kept: list[int] = []
    # In chunks — a whole catalog in one IN would pass asyncpg's bind-parameter limit.
    for chunk in product_facets.id_chunks(ids):
        parts: dict[int, list[ProductPart]] = {}
        for part in (await db.execute(select(ProductPart).where(ProductPart.product_id.in_(chunk)))).scalars():
            parts.setdefault(part.product_id, []).append(part)
        stock = await part_stock.balances_for_products(db, chunk)
        defaults = await default_options(db, chunk)
        kept += [
            pid
            for pid in chunk
            if part_stock.kits_of(
                stock.get(pid, {}), standard_composition(parts.get(pid, []), set(defaults.get(pid, {}).values()))
            )
            > 0
        ]
    return kept


async def _category_counts(db: AsyncSession, conditions: list) -> tuple[list[CategoryCount], int]:
    """The category panel: one GROUP BY under every filter but the category."""
    rows = (
        await db.execute(
            select(Product.category_id, ProductCategory.name, func.count(Product.id))
            .outerjoin(ProductCategory, ProductCategory.id == Product.category_id)
            .where(*conditions)
            .group_by(Product.category_id, ProductCategory.name)
        )
    ).all()
    uncategorized = sum(n for cid, _name, n in rows if cid is None)
    named = sorted(
        (CategoryCount(id=cid, name=name, count=n) for cid, name, n in rows if cid is not None and name is not None),
        key=lambda c: (c.name.casefold(), c.id),
    )
    return named, uncategorized


@router.get("", response_model=list[ProductListItem] | ProductListPage)
@router.get("/", response_model=list[ProductListItem] | ProductListPage)
async def list_products(
    active: bool | None = None,
    q: str | None = None,
    include_adhoc: bool = False,
    category: str | None = Query(None, description="A category id, or 'none' for the uncategorized"),
    material: str | None = None,
    color: str | None = None,
    model: str | None = None,
    status: Literal["draft", "ready"] | None = None,
    in_stock: bool = Query(False, description="Only products with at least one free kit"),
    sort_by: str | None = Query(None, description="With page set: '<key>-<asc|desc>'; unknown → name-asc"),
    page: int | None = Query(None, ge=1, description="Omit entirely for the legacy flat-array response"),
    per_page: int = Query(24, ge=1, le=200),
    all: bool = Query(False, description="With page set, skip pagination and return every matching row"),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_READ),
):
    """The product catalog. ``page`` is the compat switch (the inventory's contract).

    Without it the flat array the pickers, the link-to-products dialog, the
    model card and the stock journal read — unchanged. With it ``{items, meta}``
    and ``sort_by``. A SQL key (``name``, ``updated``, ``created``) pages in the
    database and the counts below are read for that page only; a computed key
    (``parts``, ``plates``, ``orders``, ``kits``) loads the filtered catalog,
    counts it as the unpaged list always did, sorts here and slices.

    Search and filters (spec workshop-product-catalog, rules 8–11): every word
    of ``q`` must hit some field; the facet filters read the stored
    ``product_facets``; ``in_stock`` keeps the products with a free kit. The
    page also carries the category panel's counts — every filter but the
    category's own.
    """
    paged = page is not None
    key, direction, computed = resolve_sort(_PRODUCT_SORT, sort_by)
    conditions = []
    # The catalogue never saw an adhoc product (spec Decision 2); only a
    # caller that asks by name gets them.
    if not include_adhoc:
        conditions.append(Product.origin == ProductOrigin.CATALOG.value)
    if active is not None:
        conditions.append(Product.is_active.is_(active))
    if q and (words := q.split()):
        conditions.append(and_(*(_word_matches(w) for w in words)))
    for kind, value in (("material", material), ("color", color), ("model", model)):
        if value and value.strip():
            conditions.append(_has_facet(kind, value))
    if status is not None:
        conditions.append(Product.status == status)
    if in_stock:
        conditions.append(Product.id.in_(await _in_stock_ids(db, conditions)))
    panel = await _category_counts(db, conditions) if paged else None
    if category == "none":
        conditions.append(Product.category_id.is_(None))
    elif category:
        try:
            conditions.append(Product.category_id == int(category))
        except ValueError:
            raise HTTPException(status_code=422, detail="category must be a category id or 'none'") from None
    query = (
        select(Product)
        .outerjoin(ProductCategory, ProductCategory.id == Product.category_id)
        .options(selectinload(Product.parts), selectinload(Product.plates))
        .where(*conditions)
    )
    if not paged:
        query = query.order_by(Product.name)
    total = 0
    if paged and not computed:
        total = await db.scalar(select(func.count()).select_from(query.subquery())) or 0
        query = apply_sql_sort(query, _PRODUCT_SORT, key, direction, Product.id)
        if not all:
            query = query.limit(per_page).offset((page - 1) * per_page)
    products = (await db.execute(query)).scalars().all()
    counts = dict(
        (
            await db.execute(
                select(ProjectLine.product_id, func.count(ProjectLine.id)).group_by(ProjectLine.product_id)
            )
        ).all()
    )
    plates = await _plates_count(db, [p.id for p in products])
    # The ledger for the WHOLE page in one grouped read, exactly like the plate
    # counts above it — ``kits_available`` per product is a per-row number and a
    # per-row query for it would be an N+1 nobody notices until the catalog grows.
    stock = await part_stock.balances_for_products(db, [p.id for p in products])
    defaults = await default_options(db, [p.id for p in products])
    finished = await _finished_available(db, [p.id for p in products])
    facets = await _facets_by_product(db, [p.id for p in products])
    items = [
        ProductListItem(
            id=p.id,
            code=code_for("product", p.id),
            name=p.name,
            is_active=p.is_active,
            **_catalog_out(p),
            cover_image_filename=p.cover_image_filename,
            has_cover=effective_cover(p) is not None,
            parts_count=len(p.parts),
            plates_count=plates.get(p.id, 0),
            lines_count=counts.get(p.id, 0),
            kits_available=part_stock.kits_of(
                stock.get(p.id, {}), standard_composition(list(p.parts), set(defaults.get(p.id, {}).values()))
            ),
            finished_available=finished.get(p.id, 0),
            materials=facets.get(p.id, {}).get("material", []),
            colors=facets.get(p.id, {}).get("color", []),
            models=facets.get(p.id, {}).get("model", []),
            origin=p.origin,
            origin_file_id=p.origin_file_id,
            origin_plate_index=p.origin_plate_index,
        )
        for p in products
    ]
    if not paged:
        return items
    if computed:
        items = sort_computed(items, _PRODUCT_COMPUTED[key], direction, id_fn=lambda r: r.id)
        total = len(items)
        items = slice_page(items, page, per_page, all)
    categories, uncategorized = panel if panel else ([], 0)
    return ProductListPage(
        items=items,
        meta=page_meta(total, page, per_page, all),
        categories=categories,
        uncategorized=uncategorized,
    )


async def _finished_available(db: AsyncSession, product_ids: list[int]) -> dict[int, int]:
    """Free ready units per product, over every position — one grouped read."""
    if not product_ids:
        return {}
    rows = await db.execute(
        select(StockItem.product_id, func.sum(StockItem.on_hand - StockItem.reserved))
        .where(StockItem.product_id.in_(product_ids))
        .group_by(StockItem.product_id)
    )
    return {product_id: int(n or 0) for product_id, n in rows.all()}


async def _facets_by_product(db: AsyncSession, product_ids: list[int]) -> dict[int, dict[str, list[str]]]:
    """``product → kind → sorted values`` of the stored facets, files outside the trash — one read."""
    if not product_ids:
        return {}
    rows = await db.execute(
        select(ProductFacet.product_id, ProductFacet.kind, ProductFacet.value)
        .join(LibraryFile, LibraryFile.id == ProductFacet.library_file_id)
        .where(ProductFacet.product_id.in_(product_ids), LibraryFile.deleted_at.is_(None))
        .distinct()
    )
    out: dict[int, dict[str, set[str]]] = {}
    for product_id, kind, value in rows.all():
        out.setdefault(product_id, {}).setdefault(kind, set()).add(value)
    return {pid: {kind: sorted(values) for kind, values in kinds.items()} for pid, kinds in out.items()}


_PART_SORT = SortSpec(
    sql={"part": (func.lower(ProductPart.name), False), "product": (func.lower(Product.name), False)},
    default="product-asc",
)


def _part_word_matches(word: str):
    """One search word against a part: its name, its product's name, SKU or code."""
    needle = like_contains(word)
    fields = [
        ProductPart.name.ilike(needle, escape="\\"),
        Product.name.ilike(needle, escape="\\"),
        Product.sku.ilike(needle, escape="\\"),
    ]
    if (product_id := id_from_query("product", word)) is not None:
        fields.append(Product.id == product_id)
    return or_(*fields)


@router.get("/parts", response_model=ProductPartsPage)
async def list_product_parts(
    q: str | None = Query(None, max_length=200),
    model: str | None = Query(None, max_length=64),
    sort_by: str | None = Query(None, description="'<part|product>-<asc|desc>'; unknown → product-asc"),
    page: int = Query(1, ge=1),
    per_page: int = Query(24, ge=1, le=200),
    all: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_READ),
):
    """Printed parts of active catalogue products, searched, filtered and paged in SQL —
    the add-to-order dialog's «parts of a product» tab (spec workshop-add-to-order, rule 16).
    Declared above ``/{product_id}``."""
    query = (
        select(ProductPart, Product, ProductVariantGroup.name, ProductVariantOption.name)
        .join(Product, Product.id == ProductPart.product_id)
        .outerjoin(ProductVariantOption, ProductVariantOption.id == ProductPart.variant_option_id)
        .outerjoin(ProductVariantGroup, ProductVariantGroup.id == ProductVariantOption.group_id)
        .where(
            ProductPart.kind == "printed",
            # «Не рахувати» is not a part to order (spec workshop-order-issue-followups, rule 34).
            ProductPart.ignored.is_(False),
            Product.origin == ProductOrigin.CATALOG.value,
            Product.is_active.is_(True),
        )
    )
    for word in (q or "").split():
        query = query.where(_part_word_matches(word))
    if model and model.strip():
        query = query.where(_has_facet("model", model))
    total = await db.scalar(select(func.count()).select_from(query.subquery())) or 0
    key, direction, _computed = resolve_sort(_PART_SORT, sort_by)
    query = apply_sql_sort(query, _PART_SORT, key, direction, ProductPart.id)
    if not all:
        query = query.limit(per_page).offset((page - 1) * per_page)
    rows = (await db.execute(query)).all()
    facets = await _facets_by_product(db, sorted({product.id for _part, product, _g, _o in rows}))
    return ProductPartsPage(
        items=[
            ProductPartRow(
                part_id=part.id,
                name=part.name,
                variant=ProductPartVariantOut(group=group, option=option) if option is not None else None,
                product=ProductPartProductOut(
                    id=product.id, code=code_for("product", product.id), name=product.name, sku=product.sku
                ),
                models=facets.get(product.id, {}).get("model", []),
            )
            for part, product, group, option in rows
        ],
        meta=page_meta(total, page, per_page, all),
    )


@router.get("/facets", response_model=ProductFacetsOut)
async def list_product_facets(
    db: AsyncSession = Depends(get_db), _: User | None = RequirePermission(Permission.PROJECTS_READ)
):
    """The values the catalog's filters offer (spec workshop-product-catalog, rule 12):
    what the catalog's products are made of and sliced for. Declared above
    ``/{product_id}``, or ``facets`` would be read as an id."""
    rows = (
        await db.execute(
            select(ProductFacet.kind, ProductFacet.value)
            .join(Product, Product.id == ProductFacet.product_id)
            .join(LibraryFile, LibraryFile.id == ProductFacet.library_file_id)
            .where(Product.origin == ProductOrigin.CATALOG.value, LibraryFile.deleted_at.is_(None))
            .distinct()
        )
    ).all()
    by_kind: dict[str, list[str]] = {kind: [] for kind in FACET_KINDS}
    for kind, value in rows:
        by_kind.setdefault(kind, []).append(value)
    return ProductFacetsOut(
        materials=sorted(by_kind["material"]), colors=sorted(by_kind["color"]), models=sorted(by_kind["model"])
    )


@router.post("", response_model=ProductResponse)
@router.post("/", response_model=ProductResponse)
async def create_product(
    data: ProductCreate,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_CREATE),
):
    product = Product(**data.model_dump(exclude=set(CATALOG_FIELDS)))
    db.add(product)
    await db.flush()
    await _apply_catalog_fields(db, product, data.model_dump(include=set(CATALOG_FIELDS)))
    await _flush_catalog(db)
    return await _response(db, product)


@router.post("/from-file/{library_file_id}", response_model=ProductResponse)
async def create_product_from_file(
    library_file_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_CREATE),
):
    """'Print this file five times' must not require authoring a product.

    The card names it when it can: a 3MF's ``Title`` beats a filename, EXCEPT
    when it is one of BambuStudio's placeholders, in which case the stem stands
    (spec §Risks, "``Title`` ≠ name"). The parse is handed on to
    :func:`fill_from_file` so the ZIP is opened once, not twice.

    ⚠️ **The fill's notes go to the LOG, not the wire.** ``ProductResponse`` has
    no ``notes`` field and giving it one would change the shape every product
    endpoint answers with, for the benefit of this one route — the re-read
    endpoint has ``RereadResponse`` for exactly that. But the notes are the only
    record of what a designer's file did not give up (a picture over the size
    cap, an ``.exe`` in ``Others/``), so throwing them away left an operator
    with a half-filled product and nothing to read. Codes and params, never
    prose: nothing here knows the operator's language.
    """
    file = (await db.execute(LibraryFile.active().where(LibraryFile.id == library_file_id))).scalar_one_or_none()
    if file is None:
        raise HTTPException(status_code=404, detail="Library file not found")
    stem = Path(file.filename).name
    for suffix in (".gcode.3mf", ".3mf", ".gcode"):
        if stem.lower().endswith(suffix):
            stem = stem[: -len(suffix)]
            break
    card = await read_card(file)
    product = Product(name=usable_title(card) or stem or file.filename)
    db.add(product)
    await db.flush()
    desired = await _file_product_ids(db, file.id) | {product.id}
    await sync_product_for_file(db, library_file_id=file.id, product_ids=sorted(desired))
    for note in await fill_from_file(db, product, file, replace_3mf_attachments=False, card=card):
        logger.info("Product %s from library file %s: code=%s params=%s", product.id, file.id, note.code, note.params)
    return await _response(db, product, reload_links=True)


# ---------- export / import (spec §Decisions 6) ----------
#
# ⚠️ Declared BEFORE every ``/{product_id}``-shaped route below. Nothing in this
# router matches ``POST /products/import`` today — the id-shaped POSTs all carry
# a second segment — but the day somebody adds ``POST /products/{product_id}``
# the literal has to already be in front of it, or FastAPI hands "import" to an
# ``int`` path parameter and answers 422 to a working request.
#
# ⚠️ **Neither route ever holds an archive in memory.** A product's export
# carries every 3MF it prints from; on the farm this was built for that is
# already hundreds of megabytes, and the machine serving it is routinely a Pi.
# The export builds a temp file and streams it; the import reads members out of
# the file the multipart parser has already spooled.


def _measure_upload(file: UploadFile) -> int:
    """How big the part the multipart parser already wrote actually is.

    ⚠️ There is nothing to stream here, and an earlier version of this route
    pretended otherwise: by the time a handler runs, FastAPI has consumed the
    body and Starlette has put each file part in a ``SpooledTemporaryFile``
    (memory up to a megabyte, a real file above that). Reading it again in
    chunks into a temp file of our own copied a file that already existed and
    could not refuse anything "before receipt" — receipt had happened.

    So this measures what we hold, by seeking. It is a fact rather than the
    client's word, which is what makes it the gate that counts; the declared
    ``Content-Length`` is checked before it purely as a cheap refusal before OUR
    work starts.
    """
    handle = file.file
    handle.seek(0, os.SEEK_END)
    size = handle.tell()
    handle.seek(0)
    return size


@router.post("/import", response_model=ProductImportResponse)
async def import_product(
    request: Request,
    file: UploadFile = File(...),
    folder_id: int | None = Form(default=None),
    db: AsyncSession = Depends(get_db),
    # Both permissions, and the library's own is not decoration: an import
    # INGESTS FILES INTO THE LIBRARY. A caller who may create products but may
    # not upload must not gain an upload route by wrapping the bytes in a
    # product archive.
    current_user: User | None = RequirePermission(Permission.PROJECTS_CREATE, Permission.LIBRARY_UPLOAD),
):
    declared = request.headers.get("content-length") or ""
    if declared.isdigit() and int(declared) > import_limit():
        raise HTTPException(status_code=413, detail=f"An import may be at most {import_limit()} bytes")
    if _measure_upload(file) > import_limit():
        raise HTTPException(status_code=413, detail=f"An import may be at most {import_limit()} bytes")
    # ``file.file`` is seekable, which is all ``zipfile`` asks for — so the
    # archive is read where it already is, member by member.
    product, warnings = await import_zip(db, file.file, folder_id=folder_id, user=current_user)
    return ProductImportResponse(product=await _response(db, product, reload_links=True), warnings=warnings)


@router.get("/{product_id}/export")
async def export_product(
    product_id: int, db: AsyncSession = Depends(get_db), _: User | None = RequirePermission(Permission.PROJECTS_READ)
):
    """The product as a ZIP: ``product.json``, its files, its attachments.

    ``BackgroundTask``, not a ``finally``: the archive is a temp file and
    ``FileResponse`` has not read a byte of it when this handler returns, so
    deleting it here would serve an empty download. Starlette runs the task once
    the response has been sent.
    """
    archive = await export_zip(db, await _get(db, product_id))
    return FileResponse(
        archive.path,
        media_type="application/zip",
        headers={
            "Content-Disposition": build_content_disposition(archive.filename, ascii_fallback=archive.ascii_filename)
        },
        background=BackgroundTask(os.unlink, archive.path),
    )


@router.get("/{product_id}", response_model=ProductResponse)
async def get_product(
    product_id: int, db: AsyncSession = Depends(get_db), _: User | None = RequirePermission(Permission.PROJECTS_READ)
):
    return await _response(db, await _get(db, product_id))


@router.patch("/{product_id}", response_model=ProductResponse)
async def update_product(
    product_id: int,
    data: ProductUpdate,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_UPDATE),
):
    product = await _get(db, product_id)
    # The catalog fields first: their refusals must come before any write.
    await _apply_catalog_fields(db, product, data.model_dump(include=data.model_fields_set & set(CATALOG_FIELDS)))
    for field_name in data.model_fields_set - set(CATALOG_FIELDS):  # explicit null clears; absent leaves alone
        setattr(product, field_name, getattr(data, field_name))
    await _flush_catalog(db)
    return await _response(db, product)


@router.delete("/{product_id}")
async def delete_product(
    product_id: int, db: AsyncSession = Depends(get_db), _: User | None = RequirePermission(Permission.PROJECTS_DELETE)
):
    product = await _get(db, product_id)
    if await _lines_count(db, product_id):
        raise HTTPException(status_code=409, detail="Product is used by an order line; remove the lines first")
    try:
        await product_delete.delete_product(db, product)
    except finished_stock.FinishedStockError as e:
        raise HTTPException(status_code=e.status, detail=str(e)) from e
    return {"message": "Product deleted"}


def _copy_attachment_files(
    source_id: int, new_id: int, entries: list[dict], cover: str | None
) -> tuple[list[dict], str | None]:
    """Copy one product's attachment files to another and return the new rows.

    ⚠️ **Blocking, and it runs in ONE thread hop.** Copying is the only work
    here and it is all filesystem; splitting it per file would only multiply the
    hops. It touches no ORM object — the rows arrive as plain dicts and leave as
    plain dicts, because a lazy attribute read off the event loop is a
    ``MissingGreenlet``, not a SELECT.

    ⚠️ **Fresh stored names, not a directory copy.** ``projects`` duplicates by
    ``copytree`` and keeps the names; here every entry gets a new ``uuid4``, so
    the two products' galleries can never end up naming the same file — which is
    what would let deleting one take the other's pictures with it. The
    ``original_name`` the operator gave is kept exactly as it was.

    ⚠️ **The dedicated cover is not a gallery entry**, so it is copied
    separately or the copy would carry a column pointing at nothing. A cover
    that IS a gallery picture is remapped to that picture's new name instead.

    A source file whose bytes are gone is dropped rather than carried as a row
    that resolves to nothing: an entry the copy cannot show is worse than no
    entry, and the source still has whatever it still has.
    """
    src_dir = product_attachments_dir(source_id)
    dst_dir = product_attachments_dir(new_id)
    rows: list[dict] = []
    stamp = datetime.now(UTC).isoformat()
    renamed: dict[str, str] = {}

    def carry(stored: str, prefix: str = "") -> str | None:
        try:
            safe_attachment_name(stored)
        except HTTPException:  # a hand-edited row; its file is not ours to guess at
            return None
        source_path = src_dir / stored  # SEC-PATH-OK: guarded by safe_attachment_name just above
        if not source_path.is_file():
            return None
        fresh = f"{prefix}{uuid.uuid4().hex}{os.path.splitext(stored)[1].lower()}"
        try:
            dst_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(
                source_path, dst_dir / fresh
            )  # SEC-PATH-OK: 'cover_'? + uuid4().hex + the source's own extension
        except OSError as e:
            logger.warning("Product %s: attachment %s could not be copied from %s: %s", new_id, stored, source_id, e)
            return None
        renamed[stored] = fresh
        return fresh

    for entry in entries:
        stored = entry.get("filename")
        fresh = carry(stored) if isinstance(stored, str) else None
        if fresh is None:
            continue
        rows.append({**entry, "filename": fresh, "uploaded_at": stamp})

    if not cover:
        return rows, None
    if cover in renamed:
        return rows, renamed[cover]
    # Not in the gallery: a dedicated upload, carried under its own prefix so
    # `_drop_dedicated_cover` still recognises it on the copy.
    return rows, carry(cover, prefix="cover_")


@router.post("/{product_id}/duplicate", response_model=ProductResponse)
async def duplicate_product(
    product_id: int,
    data: ProductDuplicate,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_CREATE),
):
    """Composition, aliases, links, pictures and documents: a copy, never a move.

    The attachment FILES are copied too, not just the column — see
    :func:`_copy_attachment_files`. A copy holding the source's filenames would
    look right until somebody deleted the source, and then show a gallery of
    broken tiles.
    """
    source = await _get(db, product_id)
    copy = Product(
        name=data.name or f"{source.name} (Copy)",
        description=source.description,
        notes=source.notes,
        designer=source.designer,
        license=source.license,
        source_url=source.source_url,
        design_id=source.design_id,
        # The SKU names ONE product, so the copy starts without one; it is a
        # draft until the operator says otherwise.
        version=source.version,
        category_id=source.category_id,
        is_active=True,
    )
    db.add(copy)
    await db.flush()
    # Groups first: the parts' bindings go through the old → new option map.
    option_map: dict[int, int] = {}
    for group in await _variant_groups(db, source.id):
        new_group = ProductVariantGroup(product_id=copy.id, name=group.name, position=group.position)
        db.add(new_group)
        await db.flush()
        new_options = [
            ProductVariantOption(group_id=new_group.id, name=o.name, position=o.position) for o in group.options
        ]
        db.add_all(new_options)
        await db.flush()
        option_map.update({o.id: n.id for o, n in zip(group.options, new_options, strict=True)})
        new_group.default_option_id = option_map.get(group.default_option_id) if group.default_option_id else None
    for part in source.parts:
        db.add(
            ProductPart(
                product_id=copy.id,
                kind=part.kind,
                name=part.name,
                name_key=part.name_key,
                qty_per_unit=part.qty_per_unit,
                ignored=part.ignored,
                # NULL for a purchased part, and it stays NULL on the copy: the
                # column is printed-only, and [] would read as "no aliases yet".
                aliases=list(part.aliases) if part.aliases is not None else None,
                auto=part.auto,
                unit_price=part.unit_price,
                sourcing_url=part.sourcing_url,
                remarks=part.remarks,
                sort_order=part.sort_order,
                variant_option_id=option_map.get(part.variant_option_id) if part.variant_option_id else None,
            )
        )
    # ⚠️ No hand-copied ``ProductPlate`` rows. The syncs below plant the plates
    # for every file the copy ends up linked to, from the file's own metadata —
    # copying them here as well only avoided ``uq_product_plates_file_plate``
    # because autoflush happened to run before the sync read them.
    for f in list(source.library_files):
        await sync_product_for_file(
            db, library_file_id=f.id, product_ids=sorted(await _file_product_ids(db, f.id) | {copy.id})
        )
    for folder in list(source.library_folders):
        await _apply_folder(db, folder.id, await _folder_product_ids(db, folder.id) | {copy.id})

    # Read the JSON column into plain dicts HERE, on the loop, before the thread
    # touches anything: the worker gets data, never an ORM row.
    copy.attachments, copy.cover_image_filename = await asyncio.to_thread(
        _copy_attachment_files,
        source.id,
        copy.id,
        sorted_attachments(source),
        source.cover_image_filename,
    )
    await db.flush()
    return await _response(db, copy, reload_links=True)


# ---------- parts ----------

# spec workshop-order-issue-followups, rule 34: «не рахувати» only on a zero, and never on a
# part that holds stock or that a line or a stock position wants.
_NOT_IN_KIT = "A part that is not counted cannot be in the kit"
_CANNOT_IGNORE = "This part holds stock or is ordered; it cannot be marked as not counted"
# A bought part is never on a plate, so «not a part of it» never applies (final review I3).
_PRINTED_ONLY = "Only a printed part can be marked as not counted"


async def _part(db: AsyncSession, product: Product, part_id: int) -> ProductPart:
    part = next((p for p in product.parts if p.id == part_id), None)
    if part is None:
        raise HTTPException(status_code=404, detail="Part not found")
    return part


@router.post("/{product_id}/parts", response_model=ProductPartResponse)
async def create_part(
    product_id: int,
    data: ProductPartCreate,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_UPDATE),
):
    product = await _get(db, product_id)
    if data.ignored and data.kind != "printed":
        raise HTTPException(status_code=422, detail=_PRINTED_ONLY)
    if data.ignored and data.qty_per_unit > 0:
        raise HTTPException(status_code=422, detail=_NOT_IN_KIT)
    if data.kind == "purchased":
        key = purchased_name_key(data.name)
    else:
        key = name_key(canonicalize(data.name))
    if any(key == p.name_key or key in (p.aliases or []) for p in product.parts):
        raise HTTPException(status_code=409, detail="A part with this name already exists")
    part = ProductPart(
        product_id=product.id,
        kind=data.kind,
        name=data.name.strip(),
        name_key=key,
        qty_per_unit=data.qty_per_unit,
        ignored=data.ignored,
        aliases=[key] if data.kind == "printed" else None,
        auto=False,
        unit_price=data.unit_price,
        sourcing_url=data.sourcing_url,
        remarks=data.remarks,
        sort_order=max((p.sort_order for p in product.parts), default=-1) + 1,
    )
    db.add(part)
    await db.flush()
    await db.refresh(part)
    return await _part_out(db, part)


@router.patch("/{product_id}/parts/{part_id}", response_model=ProductPartResponse)
async def update_part(
    product_id: int,
    part_id: int,
    data: ProductPartUpdate,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_UPDATE),
):
    product = await _get(db, product_id)
    part = await _part(db, product, part_id)
    if "variant_option_id" in data.model_fields_set and data.variant_option_id is not None:
        owner = await db.scalar(
            select(ProductVariantGroup.product_id)
            .join(ProductVariantOption, ProductVariantOption.group_id == ProductVariantGroup.id)
            .where(ProductVariantOption.id == data.variant_option_id)
        )
        if owner != product.id:
            raise HTTPException(status_code=422, detail="That option does not belong to this product")
    if "variant_option_id" in data.model_fields_set:
        # Saved order lines keep the kit they had (spec workshop-product-variants).
        try:
            await line_config.freeze_binding(db, part, data.variant_option_id)
        except line_config.LineConfigError as e:
            raise HTTPException(status_code=e.status, detail=str(e)) from e
    # A PURCHASED part IS its name — ``name_key`` is derived from it (there is no
    # 3MF object to key off), so a rename that left the key behind made the two
    # disagree for good and let a second "M4 screw" be created beside the first.
    # A PRINTED part's key is the object name inside the file and must survive
    # every rename: refreshing it would orphan the archive rows that match on it.
    new_key = None
    if "name" in data.model_fields_set and part.kind == "purchased":
        new_key = purchased_name_key(data.name)
        if new_key != part.name_key and any(
            p is not part and (new_key == p.name_key or new_key in (p.aliases or [])) for p in product.parts
        ):
            raise HTTPException(status_code=409, detail="A part with this name already exists")
    ignored_after = data.ignored if "ignored" in data.model_fields_set else part.ignored
    qty_after = data.qty_per_unit if "qty_per_unit" in data.model_fields_set else part.qty_per_unit
    if ignored_after and not part.ignored and part.kind != "printed":
        raise HTTPException(status_code=422, detail=_PRINTED_ONLY)
    if ignored_after and qty_after > 0:
        raise HTTPException(status_code=422, detail=_NOT_IN_KIT)
    if ignored_after and not part.ignored:
        # Only a part with nothing on its shelf, in no reserved kit (final review M7) and
        # wanted by nobody (rule 34).
        balance = (await part_stock.balances(db, product.id)).get(part.id, 0)
        if (
            balance != 0
            or await part_stock.reserved_for_part(db, part.id) > 0
            or await line_config.part_in_use(db, part.id)
        ):
            raise HTTPException(status_code=409, detail=_CANNOT_IGNORE)
    for field_name in data.model_fields_set:
        setattr(part, field_name, getattr(data, field_name))
    if new_key is not None:
        # The procurement rows reference the part ID, so nothing of the order
        # moves with the key — there is no migration here, only a stale value.
        part.name_key = new_key
    if data.model_fields_set:
        # An operator edit is what ``auto`` exists to record: the seeded default
        # is no longer the answer, so the next sync must not touch this row's
        # figures. An empty body edited nothing and must not clear the flag.
        part.auto = False
    await db.flush()
    await db.refresh(part)
    return await _part_out(db, part)


@router.delete("/{product_id}/parts/{part_id}")
async def delete_part(
    product_id: int,
    part_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_UPDATE),
):
    part = await _part(db, await _get(db, product_id), part_id)
    # ``project_procurement.product_part_id`` is ON DELETE CASCADE, which
    # PostgreSQL honours and SQLite does not — this codebase never sets
    # ``PRAGMA foreign_keys = ON``. Left behind, the row counts acquisitions
    # towards a part nothing can name any more.
    await db.execute(delete(ProjectProcurement).where(ProjectProcurement.product_part_id == part_id))
    # Same story for the stock ledger, whose FK is the same kind of cascade —
    # and ``part_stock`` is its only writer, so the deletion goes through it.
    await part_stock.delete_for_part(db, part_id)
    # Lines and stock positions that changed this part's count lose that row
    # (spec workshop-product-variants; workshop-finished-goods, rule 14).
    try:
        await line_config.forget_part(db, part_id)
    except line_config.LineConfigError as e:
        raise HTTPException(status_code=e.status, detail=str(e)) from e
    await db.delete(part)
    return {"message": "Part deleted"}


@router.post("/{product_id}/parts/{part_id}/merge", response_model=ProductPartResponse)
async def merge_part(
    product_id: int,
    part_id: int,
    data: ProductPartMerge,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_UPDATE),
):
    product = await _get(db, product_id)
    target, source = await _part(db, product, part_id), await _part(db, product, data.source_part_id)
    if target is source:
        raise HTTPException(status_code=400, detail="A part cannot be merged into itself")
    if target.ignored and not source.ignored and await line_config.part_in_use(db, source.id):
        # A line would come to want a part marked «не рахувати» (final review M6).
        raise HTTPException(
            status_code=409, detail="A part that is ordered cannot be merged into one marked as not counted"
        )
    merge_parts(target, source)
    # Free stock, unlike the procurement counts below, MOVES: it is parts on a
    # shelf, and the merge says those parts are these parts. Before the source
    # row goes away, and refused (409) when the target cannot hold a balance —
    # merging a printed part with stock into a purchased one would otherwise
    # silently destroy it.
    try:
        await part_stock.repoint(db, from_part_id=source.id, to_part_id=target.id)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    # A line's (and a stock position's) changed count of the source now names the target.
    try:
        await line_config.repoint_part(db, source.id, target.id)
    except line_config.LineConfigError as e:
        raise HTTPException(status_code=e.status, detail=str(e)) from e
    # The source row goes away, so its procurement rows go with it — the same
    # FK-cascade reason as ``delete_part``, and deliberately NOT a transfer of
    # the acquired counts onto the target: PostgreSQL's cascade would drop them
    # anyway, and a backend-dependent answer here is worse than a plain one.
    await db.execute(delete(ProjectProcurement).where(ProjectProcurement.product_part_id == source.id))
    await db.delete(source)
    await db.flush()
    await db.refresh(target)
    return await _part_out(db, target)


@router.post("/{product_id}/parts/{part_id}/aliases", response_model=ProductPartResponse)
async def add_part_alias(
    product_id: int,
    part_id: int,
    data: ProductPartAlias,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_UPDATE),
):
    product = await _get(db, product_id)
    part = await _part(db, product, part_id)
    if part.kind == "purchased":
        # ``ProductPart.aliases`` is printed-only by the model's contract: an
        # alias maps a 3MF object name onto a part, and nothing on a plate is
        # ever a purchased screw.
        raise HTTPException(status_code=400, detail="Purchased parts have no aliases")
    try:
        add_alias(product.parts, part, data.name_key.strip().lower())
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    await db.flush()
    await db.refresh(part)
    return await _part_out(db, part)


@router.delete("/{product_id}/parts/{part_id}/aliases", response_model=ProductPartResponse)
async def remove_part_alias(
    product_id: int,
    part_id: int,
    name_key: str,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_UPDATE),
):
    """Query param dodges URL-encoding traps in part keys (same trick the old parts ledger used)."""
    part = await _part(db, await _get(db, product_id), part_id)
    try:
        remove_alias(part, name_key)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    await db.flush()
    await db.refresh(part)
    return await _part_out(db, part)


# ---------- free stock (pass 8, Decision 6) ----------


# ---------- variants (spec workshop-product-variants, rules 1–3, 18) ----------

_GROUP_TAKEN = "A group with this name already exists"
_OPTION_TAKEN = "An option with this name already exists"


async def _group(db: AsyncSession, product_id: int, group_id: int) -> ProductVariantGroup:
    group = next((g for g in await _variant_groups(db, product_id) if g.id == group_id), None)
    if group is None:
        raise HTTPException(status_code=404, detail="Variant group not found")
    return group


def _option(group: ProductVariantGroup, option_id: int) -> ProductVariantOption:
    option = next((o for o in group.options if o.id == option_id), None)
    if option is None:
        raise HTTPException(status_code=404, detail="Variant option not found")
    return option


async def _bound_parts(db: AsyncSession, option_ids: list[int]) -> int:
    if not option_ids:
        return 0
    return await db.scalar(select(func.count(ProductPart.id)).where(ProductPart.variant_option_id.in_(option_ids))) or 0


@router.post("/{product_id}/variant-groups", response_model=ProductResponse)
async def create_variant_group(
    product_id: int,
    data: VariantGroupCreate,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_UPDATE),
):
    """A group with its options, the first one standard. A product already on
    orders gets the standard recorded on each of its lines (rule 5)."""
    product = await _get(db, product_id)
    groups = await _variant_groups(db, product.id)
    if not data.options:
        raise HTTPException(status_code=422, detail="A group needs at least one option")
    if any(variant_key(g.name) == variant_key(data.name) for g in groups):
        raise HTTPException(status_code=409, detail=_GROUP_TAKEN)
    keys = [variant_key(name) for name in data.options]
    if len(set(keys)) != len(keys):
        raise HTTPException(status_code=409, detail=_OPTION_TAKEN)
    group = ProductVariantGroup(
        product_id=product.id, name=data.name, position=max((g.position for g in groups), default=-1) + 1
    )
    db.add(group)
    await db.flush()
    options = [ProductVariantOption(group_id=group.id, name=name, position=i) for i, name in enumerate(data.options)]
    db.add_all(options)
    await db.flush()
    group.default_option_id = options[0].id
    await db.flush()
    await line_config.add_group_to_lines(db, group)
    return await _response(db, product)


@router.patch("/{product_id}/variant-groups/{group_id}", response_model=ProductResponse)
async def update_variant_group(
    product_id: int,
    group_id: int,
    data: VariantGroupUpdate,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_UPDATE),
):
    """Rename, reorder, or pick another standard. A new standard changes no
    saved line — every line recorded its choice (rule 5)."""
    product = await _get(db, product_id)
    group = await _group(db, product.id, group_id)
    fields = data.model_fields_set
    if "name" in fields and variant_key(data.name) != variant_key(group.name):
        if any(
            g.id != group.id and variant_key(g.name) == variant_key(data.name)
            for g in await _variant_groups(db, product.id)
        ):
            raise HTTPException(status_code=409, detail=_GROUP_TAKEN)
    if "default_option_id" in fields and data.default_option_id not in {o.id for o in group.options}:
        raise HTTPException(status_code=422, detail="That option does not belong to this group")
    if "name" in fields:
        group.name = data.name
    if "default_option_id" in fields:
        group.default_option_id = data.default_option_id
    if "position" in fields:
        group.position = data.position
    await db.flush()
    return await _response(db, product)


@router.delete("/{product_id}/variant-groups/{group_id}", response_model=ProductResponse)
async def delete_variant_group(
    product_id: int,
    group_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_UPDATE),
):
    """Refused while an order line has a choice in it or a part is bound to one
    of its options — either would change a kit somebody already relies on."""
    product = await _get(db, product_id)
    group = await _group(db, product.id, group_id)
    lines = await db.scalar(
        select(func.count(func.distinct(ProjectLineChoice.line_id))).where(ProjectLineChoice.group_id == group.id)
    )
    if lines:
        raise HTTPException(status_code=409, detail=f"Group chosen in {lines} order lines")
    held = await db.scalar(
        select(func.count(func.distinct(StockItemChoice.item_id))).where(StockItemChoice.group_id == group.id)
    )
    if held:
        raise HTTPException(status_code=409, detail=f"Group held by {held} stock positions")
    bound = await _bound_parts(db, [o.id for o in group.options])
    if bound:
        raise HTTPException(status_code=409, detail=f"{bound} parts are bound to this group's options")
    # The group points at one of its options: clear that first, so the options
    # can go before the group on a backend that enforces the key.
    group.default_option_id = None
    await db.flush()
    await db.delete(group)
    await db.flush()
    return await _response(db, product)


@router.post("/{product_id}/variant-groups/{group_id}/options", response_model=ProductResponse)
async def create_variant_option(
    product_id: int,
    group_id: int,
    data: VariantOptionCreate,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_UPDATE),
):
    product = await _get(db, product_id)
    group = await _group(db, product.id, group_id)
    if any(variant_key(o.name) == variant_key(data.name) for o in group.options):
        raise HTTPException(status_code=409, detail=_OPTION_TAKEN)
    group.options.append(
        ProductVariantOption(name=data.name, position=max((o.position for o in group.options), default=-1) + 1)
    )
    await db.flush()
    return await _response(db, product)


@router.patch("/{product_id}/variant-groups/{group_id}/options/{option_id}", response_model=ProductResponse)
async def update_variant_option(
    product_id: int,
    group_id: int,
    option_id: int,
    data: VariantOptionUpdate,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_UPDATE),
):
    product = await _get(db, product_id)
    group = await _group(db, product.id, group_id)
    option = _option(group, option_id)
    fields = data.model_fields_set
    if "name" in fields and any(
        o.id != option.id and variant_key(o.name) == variant_key(data.name) for o in group.options
    ):
        raise HTTPException(status_code=409, detail=_OPTION_TAKEN)
    if "name" in fields:
        option.name = data.name
    if "position" in fields:
        option.position = data.position
    await db.flush()
    return await _response(db, product)


@router.delete("/{product_id}/variant-groups/{group_id}/options/{option_id}", response_model=ProductResponse)
async def delete_variant_option(
    product_id: int,
    group_id: int,
    option_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_UPDATE),
):
    """Refused for the standard option, for one an order line chose, and for one
    parts are bound to (spec workshop-product-variants, owner's call: 409)."""
    product = await _get(db, product_id)
    group = await _group(db, product.id, group_id)
    option = _option(group, option_id)
    if option.id == group.default_option_id:
        raise HTTPException(
            status_code=409, detail="The standard option cannot be deleted; choose another standard first"
        )
    lines = await db.scalar(select(func.count()).where(ProjectLineChoice.option_id == option.id))
    if lines:
        raise HTTPException(status_code=409, detail=f"Option chosen in {lines} order lines")
    held = await db.scalar(select(func.count()).where(StockItemChoice.option_id == option.id))
    if held:
        raise HTTPException(status_code=409, detail=f"Option held by {held} stock positions")
    bound = await _bound_parts(db, [option.id])
    if bound:
        raise HTTPException(status_code=409, detail=f"{bound} parts are bound to this option")
    group.options.remove(option)
    await db.flush()
    return await _response(db, product)


@router.get("/{product_id}/stock", response_model=ProductStockOut)
async def get_product_stock(
    product_id: int,
    limit: int = Query(200, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_READ),
):
    """The product's free stock: what is on the shelf, how many kits, how it got there.

    ``balances`` lists the COUNTED parts only (printed and not marked «не рахувати»,
    out-of-kit zeros included — spec workshop-order-issue-followups, rule 34) — a
    purchased part is procurement and has no shelf. The movements below are
    deliberately not filtered that way: a row written before a part was marked still
    happened.
    """
    product = await _get(db, product_id)
    part_balances = await part_stock.balances(db, product.id)
    held = await part_stock.held_for_orders(db, product.id)
    rows = await part_stock.movements(db, product.id, limit=limit)
    # Every movement's part is one of this product's own — ``part_stock.movements``
    # joins ``product_parts`` on this very product — so the names cost nothing.
    names = {part.id: part.name for part in product.parts}
    orders = await orders_of_lines(db, {r.project_line_id for r in rows if r.project_line_id is not None})
    return ProductStockOut(
        balances=[
            StockBalanceOut(
                part_id=p.id,
                name=p.name,
                qty_per_unit=p.qty_per_unit,
                balance=part_balances[p.id],
                held_for_orders=held.get(p.id, 0),
            )
            for p in sorted(product.parts, key=lambda p: (p.sort_order, p.id))
            if p.id in part_balances
        ],
        kits_available=await _standard_kits(db, product, part_balances),
        movements=[movement_out(row, names, orders) for row in rows],
    )


@router.get("/{product_id}/kits", response_model=ProductKitsOut)
async def get_product_kits(
    product_id: int,
    options: str | None = Query(
        None, description="Chosen option ids, comma-separated; other groups take their standard"
    ),
    counts: str | None = Query(None, description="Changed per-unit counts as part_id:qty, comma-separated"),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_READ),
):
    """Whole kits of ONE configuration the free stock can make — what the
    add-line row and the line editor may offer to take off the shelf. The
    product's own ``kits_available`` is the STANDARD kit's; a line with other
    options reserves its own kit (spec workshop-product-variants, rules 9, 22)."""
    product = await _get(db, product_id)
    try:
        option_ids = [int(item) for item in (options or "").split(",") if item.strip()]
        count_map: dict[int, int] = {}
        for item in (counts or "").split(","):
            if item.strip():
                part_id, qty = item.split(":")
                count_map[int(part_id)] = int(qty)
    except ValueError as e:
        raise HTTPException(status_code=422, detail="Options and counts must be numbers") from e
    groups = await _variant_groups(db, product.id)
    group_of = {o.id: g.id for g in groups for o in g.options}
    chosen = {g.id: g.default_option_id for g in groups if g.default_option_id is not None}
    for option_id in option_ids:
        if option_id not in group_of:
            raise HTTPException(status_code=422, detail="That option does not belong to this product")
        chosen[group_of[option_id]] = option_id
    if any(part_id not in {p.id for p in product.parts} for part_id in count_map):
        raise HTTPException(status_code=422, detail="That part does not belong to this product")
    kit = composition(list(product.parts), "product", set(chosen.values()), count_map)
    return ProductKitsOut(kits_available=part_stock.kits_of(await part_stock.balances(db, product.id), kit))


@router.post("/{product_id}/stock/adjust", response_model=StockMovementOut)
async def adjust_product_stock(
    product_id: int,
    data: StockAdjustIn,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermission(Permission.PROJECTS_UPDATE),
):
    """A hand correction: the operator counted the shelf and it disagreed with us.

    No new permission (Decision 7) — whoever may change an order's lines may
    change the stock those lines draw on; the two are the same authority over
    the same parts, and a separate one would only be a second place to forget.

    ⚠️ Never commits. ``move`` flushes and ``get_db`` closes the transaction
    after the response, exactly as the reservation path does, so the movement
    and nothing else is what a failed request leaves behind.

    Refusals, in the order they are asked: a part that is not this product's is
    a 404 (``_part``), a correction that would take the shelf below zero is a
    409 in the ledger's own words, and a part that has no shelf to correct is a
    422. Only a reservation is ever clamped — a hand correction is refused,
    because the operator counted something and being told a different number
    was written would be worse than being told nothing was.
    """
    product = await _get(db, product_id)
    part = await _part(db, product, data.part_id)
    try:
        movement = await part_stock.move(
            db,
            part_id=part.id,
            delta=data.delta,
            reason="manual",
            note=data.note,
            created_by=current_user.id if current_user else None,
        )
    except part_stock.PartStockError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=422, detail="only counted printed parts hold stock") from e
    if movement is None:
        # Unreachable: ``move`` answers ``None`` for a zero delta (the schema
        # refuses one) or a clamped reservation (this is not one). Answered
        # rather than dereferenced so a future clamp is a refusal, not a 500.
        raise HTTPException(status_code=422, detail="a correction has to move something")
    return movement_out(movement, {part.id: part.name}, {})


# ---------- plates ----------


@router.get("/{product_id}/plates", response_model=list[PlateRecipeResponse])
async def list_plates(
    product_id: int, db: AsyncSession = Depends(get_db), _: User | None = RequirePermission(Permission.PROJECTS_READ)
):
    product = await _get(db, product_id)
    names = {p.id: p.name for p in product.parts}
    out: list[PlateRecipeResponse] = []
    # ``recipes_for_product`` is the shared loop (it drops a trashed file's
    # plates); it hands rows back in plate-id order, this list is by file then
    # plate for the operator.
    rows = await recipes_for_product(db, product)
    for plate, file, r in sorted(rows, key=lambda row: (row[0].library_file_id, row[0].plate_index)):
        out.append(
            PlateRecipeResponse(
                id=plate.id,
                library_file_id=plate.library_file_id,
                filename=file.filename,
                plate_index=plate.plate_index,
                sliced=r.sliced,
                **{
                    "yield": [
                        PlateYieldEntry(part_id=pid, name=names.get(pid, "?"), count=n)
                        for pid, n in sorted(r.yield_by_part.items())
                    ]
                },
                unassigned=[PlateUnassignedEntry(name_key=k, count=n) for k, n in sorted(r.unassigned.items())],
                materials=sorted(r.materials),
                colors=sorted(r.colors),
                printer_model=r.printer_model,
                # ⚠️ `estimate_seconds`, not the raw column: a 0 is a file that
                # carries no estimate, and the plan engine has always read it
                # that way. Emitting the 0 here made the same plate say "0s" in
                # the "+ plate" menu and "unknown" once the plan held it.
                print_time_seconds=estimate_seconds(r),
                filament_used_grams=r.filament_used_grams,
            )
        )
    return out


# ---------- links ----------


@router.put("/{product_id}/files", response_model=ProductResponse)
async def set_files(
    product_id: int,
    data: FileLinkRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_UPDATE),
):
    product = await _get(db, product_id)
    wanted = set(data.library_file_ids)
    found = (
        set((await db.execute(select(LibraryFile.id).where(LibraryFile.id.in_(wanted)))).scalars().all())
        if wanted
        else set()
    )
    if wanted - found:
        raise HTTPException(status_code=404, detail=f"Library files not found: {sorted(wanted - found)}")
    current = {f.id for f in product.library_files}
    # Only the files whose membership actually changes are touched, and each is
    # re-synced against its OWN full product set — never against this product
    # alone, which would evict every co-owner from the pivot.
    for fid in sorted(current ^ wanted):
        desired = await _file_product_ids(db, fid)
        desired = desired | {product_id} if fid in wanted else desired - {product_id}
        await sync_product_for_file(db, library_file_id=fid, product_ids=sorted(desired))
    return await _response(db, product, reload_links=True)


@router.delete("/{product_id}/files/{file_id}", response_model=ProductResponse)
async def unlink_file(
    product_id: int,
    file_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_UPDATE),
):
    product = await _get(db, product_id)
    desired = await _file_product_ids(db, file_id) - {product_id}
    await sync_product_for_file(db, library_file_id=file_id, product_ids=sorted(desired))
    return await _response(db, product, reload_links=True)


@router.put("/{product_id}/folders", response_model=ProductResponse)
async def set_folders(
    product_id: int,
    data: FolderLinkRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_UPDATE),
):
    product = await _get(db, product_id)
    wanted = set(data.library_folder_ids)
    found = (
        set((await db.execute(select(LibraryFolder.id).where(LibraryFolder.id.in_(wanted)))).scalars().all())
        if wanted
        else set()
    )
    if wanted - found:
        raise HTTPException(status_code=404, detail=f"Library folders not found: {sorted(wanted - found)}")
    current = {f.id for f in product.library_folders}
    for folder_id in sorted(current ^ wanted):
        desired = await _folder_product_ids(db, folder_id)
        desired = desired | {product_id} if folder_id in wanted else desired - {product_id}
        await _apply_folder(db, folder_id, desired)
    return await _response(db, product, reload_links=True)


@router.delete("/{product_id}/folders/{folder_id}", response_model=ProductResponse)
async def unlink_folder(
    product_id: int,
    folder_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_UPDATE),
):
    product = await _get(db, product_id)
    await _apply_folder(db, folder_id, await _folder_product_ids(db, folder_id) - {product_id})
    return await _response(db, product, reload_links=True)


# ---------- the model card (spec §Decisions 2) ----------


async def _linked_file(db: AsyncSession, product: Product, file_id: int) -> LibraryFile:
    """The file, when this product really holds it — directly or through a folder.

    A folder link is mirrored onto every child's ``product_files`` row by
    ``apply_folder_products``, so the pivot alone answers both cases for every
    file the sync has seen. The folder check behind it is not redundant: a file
    that landed in a linked folder without a sync (a restored row, a scan that
    has not run) is still the operator's to re-read from.
    """
    file = (await db.execute(LibraryFile.active().where(LibraryFile.id == file_id))).scalar_one_or_none()
    if file is not None and product.id in await _file_product_ids(db, file.id):
        return file
    if file is not None and file.folder_id is not None:
        if product.id in await _folder_product_ids(db, file.folder_id):
            return file
    # 404, not 403: whether a stranger's file exists is not this route's to say.
    raise HTTPException(status_code=404, detail="That file is not linked to this product")


@router.post("/{product_id}/card/reread", response_model=RereadResponse)
async def reread_card(
    product_id: int,
    file_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_UPDATE),
):
    """Read the card out of a linked file again.

    Blank fields are filled and this file's previous ``source = "3mf"``
    attachments are replaced; everything the operator wrote or uploaded is left
    alone (spec §Decisions 2). Linking a file does NOT do this on its own —
    the page offers it, so re-reading is always something somebody asked for.
    """
    product = await _get(db, product_id)
    file = await _linked_file(db, product, file_id)
    notes = await fill_from_file(db, product, file, replace_3mf_attachments=True)
    await db.flush()
    return RereadResponse(product=await _response(db, product), notes=notes)


# ---------- typed attachments (spec §Decisions 3) ----------
#
# One JSON list on the row, the files under ``archive_dir/products/<id>/attachments``.
# ⚠️ ``Product.attachments`` is a plain JSON column, so every writer below
# ASSIGNS a new list — mutating the loaded one in place is invisible to the
# flush and the write is silently lost.


@router.get("/{product_id}/attachments", response_model=list[ProductAttachmentOut])
async def list_attachments(
    product_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_READ),
):
    return sorted_attachments(await _get(db, product_id))


@router.post("/{product_id}/attachments", response_model=ProductAttachmentOut)
async def upload_attachment(
    product_id: int,
    file: UploadFile = File(...),
    category: str = Form(...),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_UPDATE),
):
    """⚠️ ``CATEGORY_EXTENSIONS[category]`` is the only defence against an
    executable landing in the attachments directory (spec §Risks) — the category
    is checked first precisely so the lookup can never fall back to "anything"."""
    product = await _get(db, product_id)
    if category not in ATTACHMENT_CATEGORIES:
        raise HTTPException(status_code=400, detail=f"Category must be one of {list(ATTACHMENT_CATEGORIES)}")
    original_name = file.filename or "unknown"
    ext = os.path.splitext(original_name)[1].lower()
    allowed = CATEGORY_EXTENSIONS[category]
    if ext not in allowed:
        raise HTTPException(
            status_code=400,
            detail=f"'{ext or original_name}' is not allowed in {category}. Allowed: {sorted(allowed)}",
        )

    # The declared size first when the client sent one, so an oversized body is
    # refused before it is buffered; the read is checked again because that
    # header is the client's word, not a fact.
    if exceeds_attachment_limit(getattr(file, "size", None)):
        raise HTTPException(status_code=413, detail=f"An attachment may be at most {attachment_limit()} bytes")

    directory = product_attachments_dir(product_id)
    directory.mkdir(parents=True, exist_ok=True)
    stored = f"{uuid.uuid4().hex}{ext}"
    path = (
        directory / stored
    )  # SEC-PATH-OK: stored = uuid4().hex + an extension validated against this category's allowlist just above
    content = await file.read()
    if exceeds_attachment_limit(len(content)):
        raise HTTPException(status_code=413, detail=f"An attachment may be at most {attachment_limit()} bytes")
    try:
        # Off the loop: an attachment is up to 50 MB and a write to a NAS-backed
        # archive directory blocks for as long as that mount feels like.
        await asyncio.to_thread(path.write_bytes, content)
    except OSError as e:
        logger.error("Failed to save product attachment %s: %s", path, e)
        raise HTTPException(status_code=500, detail="Failed to save attachment") from e

    entry = {
        "category": category,
        "filename": stored,
        "original_name": original_name,
        "size": len(content),
        "sort_order": next_sort_order(product, category),
        "source": SOURCE_MANUAL,
        # UTC and aware — see the same stamp in ``product_card``.
        "uploaded_at": datetime.now(UTC).isoformat(),
    }
    product.attachments = [*(product.attachments or []), entry]
    await db.flush()
    return entry


@router.patch("/{product_id}/attachments/order", response_model=list[ProductAttachmentOut])
async def reorder_attachments(
    product_id: int,
    data: AttachmentOrderRequest,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_UPDATE),
):
    """The gallery order is data, not a render-time sort (parent spec).

    ``sort_order`` is per category, so this rewrites ONE category and leaves the
    others alone. A filename from another category is a 400 rather than a silent
    no-op: it means the caller and the server disagree about what is where.
    """
    product = await _get(db, product_id)
    if data.category not in ATTACHMENT_CATEGORIES:
        raise HTTPException(status_code=400, detail=f"Category must be one of {list(ATTACHMENT_CATEGORIES)}")
    mine = [a["filename"] for a in category_entries(product, data.category)]
    strangers = [f for f in data.filenames if f not in mine]
    if strangers:
        raise HTTPException(status_code=400, detail=f"Not attachments of '{data.category}': {sorted(strangers)}")
    if len(set(data.filenames)) != len(data.filenames):
        raise HTTPException(status_code=400, detail="The same filename appears twice in the order")

    ranked = {filename: i for i, filename in enumerate(data.filenames)}
    # A partial order is legal: whatever was not named keeps its relative order
    # behind what was, so a drag of one thumbnail need not resend the gallery.
    for i, filename in enumerate((f for f in mine if f not in ranked), start=len(ranked)):
        ranked[filename] = i
    product.attachments = [
        {**a, "sort_order": ranked[a["filename"]]}
        if isinstance(a, dict) and a.get("category") == data.category and a.get("filename") in ranked
        else a
        for a in (product.attachments or [])
    ]
    await db.flush()
    return sorted_attachments(product)


@router.get("/{product_id}/attachments/{filename}")
async def download_attachment(
    product_id: int,
    filename: str,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_READ),
):
    """Bearer-authenticated, and it gives the operator's own name back."""
    safe_attachment_name(filename)
    product = await _get(db, product_id)
    entry = attachment_entry(product, filename)
    if entry is None:
        raise HTTPException(status_code=404, detail="Attachment not found")
    path = (
        product_attachments_dir(product_id) / filename
    )  # SEC-PATH-OK: filename is rejected for separators, .. and empty just above the join
    if not path.exists():
        raise HTTPException(status_code=404, detail="Attachment file not found")
    # ⚠️ The header is BUILT, never handed to Starlette as ``filename=``: that
    # parameter is encoded latin-1, and an attachment an operator named in
    # Ukrainian would raise ``UnicodeEncodeError`` from deep inside the response
    # instead of downloading. Same helper as ``card-download`` and the export.
    return FileResponse(
        path,
        media_type="application/octet-stream",
        headers={"Content-Disposition": build_content_disposition(entry.get("original_name") or filename)},
    )


@router.get("/{product_id}/attachment-image/{filename}")
async def get_attachment_image(
    product_id: int,
    filename: str,
    db: AsyncSession = Depends(get_db),
    _=RequireCameraStreamToken,
):
    """Pictures for ``<img src>``, which cannot carry an Authorization header —
    so this takes the same ``?token=`` credential as the project cover route.

    ⚠️ ``/attachment-image/`` is a UNIQUE segment on purpose, and it is listed in
    ``main.py``'s ``PUBLIC_API_PATTERNS``. ``auth_middleware`` runs BEFORE any
    route dependency, so without that entry every request would be 401'd by the
    middleware and never reach this route's own stream-token gate — the route
    would be dead for the only client that needs it, a browser ``<img>``. The
    whitelist entry lets the request REACH the gate; it does not open the route.
    The entry is one anchored regex over this route alone, so the bearer-only
    download under ``/attachments/`` is out of its reach by construction.

    Pictures ONLY: a bom_docs PDF is not served through a token surface just
    because it happens to be attached. The stored name is a uuid and never
    changes, so an hour of PRIVATE browser cache is safe here — it would NOT be
    on ``/cover-image``, whose URL survives the cover being replaced.
    """
    safe_attachment_name(filename)
    product = await _get(db, product_id)
    entry = attachment_entry(product, filename)
    if entry is None or entry.get("category") != "pictures":
        raise HTTPException(status_code=404, detail="Picture not found")
    path = (
        product_attachments_dir(product_id) / filename
    )  # SEC-PATH-OK: filename is rejected for separators, .. and empty just above the join
    if not path.exists():
        raise HTTPException(status_code=404, detail="Picture file not found")
    # ``private``: this is one operator's data behind a token, never a shared
    # cache's to keep.
    return FileResponse(path, media_type=image_media_type(filename), headers={"Cache-Control": "private, max-age=3600"})


@router.delete("/{product_id}/attachments/{filename}", response_model=list[ProductAttachmentOut])
async def delete_attachment(
    product_id: int,
    filename: str,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_UPDATE),
):
    safe_attachment_name(filename)
    product = await _get(db, product_id)
    if attachment_entry(product, filename) is None:
        raise HTTPException(status_code=404, detail="Attachment not found")

    product.attachments = [
        a for a in (product.attachments or []) if not (isinstance(a, dict) and a.get("filename") == filename)
    ]
    # The cover column may point at exactly this picture; leaving it would be a
    # dangling reference for someone else's request to heal.
    if product.cover_image_filename == filename:
        product.cover_image_filename = None
    path = (
        product_attachments_dir(product_id) / filename
    )  # SEC-PATH-OK: filename is rejected for separators, .. and empty just above the join
    if path.exists():
        try:
            path.unlink()
        except OSError as e:
            logger.warning("Failed to delete product attachment file %s: %s", path, e)
    await db.flush()
    return sorted_attachments(product)


# ---------- the cover (spec §Decisions 4) ----------


def _drop_dedicated_cover(product: Product, directory: Path) -> None:
    """Delete the current cover file when NOTHING but the column references it.

    A ``cover_<uuid>`` upload is not a gallery entry, so replacing or clearing
    the column strands its file. A picked gallery picture is not ours to delete —
    the gallery still shows it.
    """
    current = product.cover_image_filename
    if not current or attachment_entry(product, current) is not None:
        return
    try:
        safe_attachment_name(current)
    except HTTPException:  # a hand-edited row; leave the file alone
        return
    path = directory / current  # SEC-PATH-OK: guarded by safe_attachment_name just above
    if path.exists():
        try:
            path.unlink()
        except OSError as e:
            logger.warning("Failed to delete the previous product cover %s: %s", path, e)


@router.put("/{product_id}/cover-image")
async def set_product_cover_image(
    product_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_UPDATE),
):
    """Two bodies on one path (spec §Decisions 4).

    JSON ``{filename}`` PICKS a picture already in the gallery; a multipart
    ``file`` UPLOADS a dedicated cover stored beside the gallery and deliberately
    not listed in it. Both write the same column, so the page has one route to
    call whichever the operator chose.
    """
    product = await _get(db, product_id)
    directory = product_attachments_dir(product_id)

    if request.headers.get("content-type", "").startswith("multipart/form-data"):
        form = await request.form()
        upload = form.get("file")
        if not isinstance(upload, StarletteUploadFile):
            raise HTTPException(status_code=400, detail="A multipart body must carry 'file'")
        original_name = upload.filename or "cover"
        ext = os.path.splitext(original_name)[1].lower()
        if ext not in COVER_EXTENSIONS:
            raise HTTPException(status_code=400, detail=f"Cover image must be one of {sorted(COVER_EXTENSIONS)}")
        directory.mkdir(parents=True, exist_ok=True)
        _drop_dedicated_cover(product, directory)
        stored = f"cover_{uuid.uuid4().hex}{ext}"
        path = (
            directory / stored
        )  # SEC-PATH-OK: 'cover_' + uuid4().hex + an extension validated against the cover allowlist just above
        content = await upload.read()
        try:
            await asyncio.to_thread(path.write_bytes, content)
        except OSError as e:
            logger.error("Failed to save product cover image %s: %s", path, e)
            raise HTTPException(status_code=500, detail="Failed to save cover image") from e
        product.cover_image_filename = stored
        await db.flush()
        return {"status": "success", "filename": stored, "size": len(content)}

    try:
        pick = CoverPickRequest.model_validate(await request.json())
    except Exception as e:
        raise HTTPException(status_code=400, detail="Body must be JSON {filename} or a multipart file") from e
    safe_attachment_name(pick.filename)
    entry = attachment_entry(product, pick.filename)
    if entry is None or entry.get("category") != "pictures":
        raise HTTPException(status_code=400, detail="The cover must be a picture attachment of this product")
    _drop_dedicated_cover(product, directory)
    product.cover_image_filename = pick.filename
    await db.flush()
    return {"status": "success", "filename": pick.filename}


@router.get("/{product_id}/cover-image")
async def get_product_cover_image(
    product_id: int,
    db: AsyncSession = Depends(get_db),
    _=RequireCameraStreamToken,
):
    """The effective cover — the explicit column, else the first picture."""
    product = await _get(db, product_id)
    name = effective_cover(product)
    if not name:
        raise HTTPException(status_code=404, detail="No cover image set")
    safe_attachment_name(name)
    path = product_attachments_dir(product_id) / name  # SEC-PATH-OK: guarded by safe_attachment_name just above
    if not path.exists():
        # Whatever named this file vanished with it. Heal BOTH shapes of the
        # cover rule — and RETURN the 404 rather than raise it: ``get_db`` rolls
        # the request back on anything that escapes the handler, so a raise would
        # undo the very heal it just performed. (The project cover route's twin
        # had exactly that bug and was fixed alongside this one in pass 6 — it
        # now returns its 404 too, so the two routes heal the same way.)
        logger.warning("Cover image file missing for product %s: %s", product_id, path)
        if product.cover_image_filename == name:
            product.cover_image_filename = None
        else:
            # The IMPLICIT cover: no column to clear, so the gallery entry that
            # elected itself is the thing that is wrong. Leaving it would make
            # `has_cover` keep promising a picture every request 404s on, and
            # would hide every later picture behind a tile that never loads.
            product.attachments = [
                a for a in (product.attachments or []) if not (isinstance(a, dict) and a.get("filename") == name)
            ]
        await db.flush()
        return json_error(404, "Cover image file not found")
    # ⚠️ ``no-cache`` — REVALIDATE, not "do not store". This URL is stable across
    # the cover being replaced, so an age-based cache shows the old picture after
    # an upload; ``private`` alone still let a browser reuse a heuristically
    # fresh copy, which is what a cache-busting query param on the frontend was
    # working around. ``private``: token-gated user data, never a shared cache's.
    return FileResponse(path, media_type=image_media_type(name), headers={"Cache-Control": "private, no-cache"})


@router.delete("/{product_id}/cover-image")
async def delete_product_cover_image(
    product_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermission(Permission.PROJECTS_UPDATE),
):
    """Clears the explicit choice; the first-picture default resumes."""
    product = await _get(db, product_id)
    if product.cover_image_filename:
        _drop_dedicated_cover(product, product_attachments_dir(product_id))
        product.cover_image_filename = None
        await db.flush()
    return {"status": "success"}
