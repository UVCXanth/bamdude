"""Conservative read projection. Never writes stock or changes planning attribution.

Only printed, counted BOM parts are included, through the configured line composition.
Object keys/aliases and explicit filing establish identity; display filenames never do.
An unfiled object with several eligible (line, part) pairs stays outside every counter.
Queue quantities are estimates from the currently linked plate recipe, not run counts.
Free stock is shared product inventory, not additive across lines of the same product.
"""

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.auto_queue import AutoQueueItem
from backend.app.models.part_stock import ProductPartStockMovement
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.product import ProductPlate
from backend.app.schemas.order_part_progress import (
    OrderPartProgressOut,
    OrderPartProgressRowOut,
    PartContributionOut,
    UnallocatedPartProgressOut,
)
from backend.app.services import order_metrics
from backend.app.services.line_composition import counted
from backend.app.services.order_queue import awaiting_auto_row_conditions, queued_printer_row_conditions
from backend.app.services.part_stock import balances_for_products
from backend.app.services.product_composition import part_index, plate_key_counts, recipe_for, recipes_for_products


async def order_part_progress(
    db: AsyncSession, order_id: int, printer_scope: frozenset[int] | None = None
) -> OrderPartProgressOut | None:
    ctx = await order_metrics.load_order_context(db, order_id)
    if ctx is None:
        return None
    result = OrderPartProgressOut(order_id=order_id, scope_limited=printer_scope is not None)
    free = await balances_for_products(db, list(ctx.products_by_id))
    line_ids = [line.id for line in ctx.lines]
    # Read the actual part reservation, rather than rounding it down to whole kits.
    held = {
        (line_id, part_id): max(0, -int(net))
        for line_id, part_id, net in (
            await db.execute(
                select(
                    ProductPartStockMovement.project_line_id,
                    ProductPartStockMovement.product_part_id,
                    func.sum(ProductPartStockMovement.delta),
                )
                .where(
                    ProductPartStockMovement.project_line_id.in_(line_ids),
                    ProductPartStockMovement.reason.in_(("reserved_for_order", "reservation_released")),
                )
                .group_by(ProductPartStockMovement.project_line_id, ProductPartStockMovement.product_part_id)
            )
        ).all()
    }
    rows = {}
    keys = {}
    for line in ctx.lines:
        for part, per in counted(order_metrics.composition_of(ctx, line)):
            pair = (line.id, part.id)
            row = OrderPartProgressRowOut(
                order_line_id=line.id,
                product_id=line.product_id,
                product_name=ctx.products_by_id[line.product_id].name,
                part_id=part.id,
                part_name=part.name,
                required_qty=per * line.quantity,
                free_stock_qty=max(0, free.get(line.product_id, {}).get(part.id, 0)),
                allocated_stock_qty=held.get(pair, 0) + per * ((line.from_finished or 0) + (line.assembled or 0)),
            )
            result.parts.append(row)
            rows[pair] = row
            # Index one part at a time, preserving collisions instead of last-alias-wins.
            for key in part_index([part]):
                keys.setdefault((line.id, key), []).append(pair)

    recipes = await recipes_for_products(db, ctx.products_by_id.values())
    recipe_rows = [entry for entries in recipes.values() for entry in entries]

    def candidates(line_id, product_ids, materials, key):
        if line_id is not None:
            home = keys.get((line_id, key), [])
            if home or line_id not in line_ids:
                return home
            # A shared bed can contain another product's parts. Its explicit
            # filing names the home line, not ownership of every object on it.
            # Foreign objects still require exactly one linked candidate pair.
        return [
            pair
            for line in ctx.lines
            if line.product_id in product_ids and order_metrics.line_accepts_materials(line, materials)
            for pair in keys.get((line.id, key), [])
        ]

    def award(contribution, key, pairs):
        if len(pairs) != 1:
            result.unallocated.append(
                UnallocatedPartProgressOut(
                    **contribution.model_dump(),
                    part_name=key,
                    reason="ambiguous" if pairs else "unallocated",
                    candidate_pairs=pairs,
                )
            )
            return
        row = rows[pairs[0]]
        existing = next(
            (
                c
                for c in row.contributions
                if (c.source_kind == contribution.source_kind and c.source_id == contribution.source_id)
            ),
            None,
        )
        if existing is None:
            row.contributions.append(contribution)
        else:
            # Several archived object keys can be aliases of one BOM part.
            # Sum their output, but the source archive is still ONE run.
            existing.expected_qty = (existing.expected_qty or 0) + (contribution.expected_qty or 0)
            for field in ("completed_good_qty", "printing_qty", "queued_qty", "rejected_qty"):
                setattr(existing, field, getattr(existing, field) + getattr(contribution, field))
        for field in ("completed_good_qty", "printing_qty", "queued_qty", "rejected_qty"):
            setattr(row, field, getattr(row, field) + getattr(contribution, field))

    def recipe_id(file_id, plate_index, product_id):
        exact = [
            p.id
            for p, _f, _r in recipes.get(product_id, [])
            if p.library_file_id == file_id and p.plate_index == plate_index
        ]
        whole = [
            p.id for p, _f, _r in recipes.get(product_id, []) if p.library_file_id == file_id and p.plate_index == 0
        ]
        hits = exact or whole
        return hits[0] if len(hits) == 1 else None

    for archive in ctx.archives:
        if printer_scope is not None and archive.printer_id not in printer_scope:
            continue
        part_rows = ctx.archive_parts_by_archive.get(archive.id, [])
        if archive.status not in ("completed", "printing") and not any(p.defective for p in part_rows):
            continue
        source = {
            "source_kind": "archive",
            "source_id": archive.id,
            "filename": archive.filename,
            "library_file_id": archive.library_file_id,
            "plate_index": archive.plate_index,
        }
        if not part_rows:
            result.unallocated.append(UnallocatedPartProgressOut(**source, reason="missing_part_rows"))
        products = order_metrics.products_for_print(
            ctx.plate_product,
            ctx.whole_file_product,
            library_file_id=archive.library_file_id,
            plate_index=archive.plate_index,
        )
        for part in part_rows:
            pairs = candidates(
                archive.project_line_id,
                products,
                order_metrics.archive_material_set(archive.filament_type),
                part.name_key,
            )
            contribution = PartContributionOut(
                **source,
                expected_qty=part.quantity,
                completed_good_qty=order_metrics.row_quantity(part, "completed")
                if archive.status == "completed"
                else 0,
                printing_qty=part.quantity if archive.status == "printing" else 0,
                rejected_qty=min(part.quantity, max(0, part.defective or 0)),
            )
            if len(pairs) == 1:
                contribution.recipe_id = recipe_id(
                    archive.library_file_id, archive.plate_index, rows[pairs[0]].product_id
                )
            award(contribution, part.name, pairs)

    for model, kind, conditions in (
        (PrintQueueItem, "printer_queue", queued_printer_row_conditions()),
        (AutoQueueItem, "auto_queue", awaiting_auto_row_conditions()),
    ):
        if printer_scope is not None:
            if model is AutoQueueItem:
                continue
            conditions = (*conditions, PrintQueueItem.queue_id.in_(printer_scope))
        jobs = (
            await db.execute(
                select(model.id, model.project_line_id, model.library_file_id, model.plate_id)
                .where(
                    or_(model.project_line_id.in_(line_ids), model.project_id == order_id),
                    *conditions,
                )
                .order_by(model.id)
            )
        ).all()
        for job_id, line_id, file_id, plate_id in jobs:
            # Queue plate_id is the file's plate index; NULL dispatches plate 1.
            index = plate_id or 1
            linked = [
                (p, f) for p, f, _r in recipe_rows if p.library_file_id == file_id and p.plate_index in (0, index)
            ]
            source = {"source_kind": kind, "source_id": job_id, "library_file_id": file_id, "plate_index": index}
            if not linked:
                result.unallocated.append(UnallocatedPartProgressOut(**source, filename="", reason="missing_recipe"))
                continue
            file = linked[0][1]
            product_ids = {p.product_id for p, _f in linked}
            # Reuse the existing metadata reader for the ACTUAL selected plate, including
            # whole-file links. A multi-plate file's aggregate is not one run's yield.
            recipe = recipe_for(
                ProductPlate(library_file_id=file_id, plate_index=index), file.file_metadata, file.file_type, []
            )
            counts, names = plate_key_counts(file.file_metadata, index)
            source["filename"] = file.filename
            if not counts:
                result.unallocated.append(UnallocatedPartProgressOut(**source, reason="missing_part_rows"))
            for key, qty in counts.items():
                pairs = candidates(line_id, product_ids, recipe.materials, key)
                pairs = [pair for pair in pairs if rows[pair].product_id in product_ids]
                contribution = PartContributionOut(**source, expected_qty=qty, queued_qty=qty)
                if len(pairs) == 1:
                    contribution.recipe_id = recipe_id(file_id, index, rows[pairs[0]].product_id)
                award(contribution, names[key], pairs)

    # Also show linked recipes that have not started, without adding to any counter.
    for product_id, entries in recipes.items():
        for plate, file, recipe in entries:
            for pair, row in rows.items():
                if row.product_id != product_id or row.part_id not in recipe.yield_by_part:
                    continue
                if any(c.recipe_id == plate.id for c in row.contributions):
                    continue
                if any(len(v) > 1 for (lid, _key), v in keys.items() if lid == pair[0]):
                    continue
                row.contributions.append(
                    PartContributionOut(
                        source_kind="recipe",
                        source_id=plate.id,
                        recipe_id=plate.id,
                        filename=file.filename,
                        library_file_id=file.id,
                        plate_index=plate.plate_index,
                        runs=0,
                        expected_qty=recipe.yield_by_part[row.part_id],
                    )
                )
    for row in result.parts:
        row.secured_qty = row.allocated_stock_qty + row.completed_good_qty
        row.remaining_qty = max(row.required_qty - row.secured_qty - row.printing_qty - row.queued_qty, 0)
    return result
