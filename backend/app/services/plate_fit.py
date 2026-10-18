"""Exact quantities for selected whole plates, using the already bundled SciPy/HiGHS.

This is a proposal, not a replacement planner. Facts come from order_metrics and
queued_yield_by_line. Free ready units, kits and loose parts follow the shared
stock_offers pass; preview never writes. The actual mix stays greedy cover.
PuLP/CBC and OR-Tools would add another solver/deployment dependency. HiGHS is
already required for calibration meshes and supplies bounded integer solving.
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import asdict, dataclass, field, replace
from fractions import Fraction
from math import gcd
from types import SimpleNamespace

from sqlalchemy import delete, select
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.auto_queue import AutoQueueItem
from backend.app.schemas.plate_fit import PlateFitOption, PlateFitPart, PlateFitRequest, PlateFitRun
from backend.app.services import order_metrics, plan_engine, queue_rebalance, stock_offers
from backend.app.services.line_composition import counted, has_shelf
from backend.app.services.preview_artifacts import disk
from backend.app.services.product_composition import recipes_for_products

MAX_QUANTITY = 1_000_000
MAX_SECONDS = 6.0


class FitError(Exception):
    def __init__(self, code: str, status: int = 409):
        self.code = code
        self.status = status
        super().__init__(code)


@dataclass(frozen=True)
class Part:
    id: int
    name: str
    per: int
    extra: Fraction
    fixed: int
    allocated: int = 0
    completed: int = 0
    printing: int = 0
    queued: int = 0

    def required(self, quantity: int) -> int:
        bonus = self.extra * quantity
        return self.per * quantity + (bonus.numerator + bonus.denominator - 1) // bonus.denominator


@dataclass(frozen=True)
class Plate:
    id: int
    yields: tuple[int, ...]
    seconds: int | None = None
    grams: float | None = None


@dataclass
class Snapshot:
    line_id: int
    quantity: int
    minimum: int
    parts: list[Part]
    plates: list[Plate]
    basis: str
    candidates: list[plan_engine.Candidate]
    removable: list[AutoQueueItem] = field(default_factory=list)
    context: order_metrics.OrderContext | None = None
    queued: dict[int, dict[int, int]] = field(default_factory=dict)
    supply: stock_offers.Supply | None = None


async def load(
    db: AsyncSession,
    order_id: int,
    line_id: int,
    plate_ids: list[int] | None,
    *,
    replace_pending: bool = False,
    lock_pending: bool = False,
) -> Snapshot:
    ctx = await order_metrics.load_order_context(db, order_id)
    if ctx is None:
        raise FitError("not_found", 404)
    line = next((row for row in ctx.lines if row.id == line_id), None)
    if line is None:
        raise FitError("not_found", 404)
    if ctx.project.status != "active":
        raise FitError("order_closed")
    if line.mode != "product":
        raise FitError("parts_line")
    comp = counted(order_metrics.composition_of(ctx, line))
    if not comp or len(comp) > 128:
        raise FitError("composition")
    # A quantity edit can redistribute an implicit print across repeated-product
    # lines. Keep ambiguous output outside this calculator rather than freezing
    # yesterday's greedy attribution and promising it to two lines.
    if any(
        a.project_line_id is None
        and a.status in ("completed", "printing")
        and line.product_id
        in order_metrics.products_for_print(
            ctx.plate_product,
            ctx.whole_file_product,
            library_file_id=a.library_file_id,
            plate_index=a.plate_index,
        )
        and sum(
            row.product_id
            in order_metrics.products_for_print(
                ctx.plate_product,
                ctx.whole_file_product,
                library_file_id=a.library_file_id,
                plate_index=a.plate_index,
            )
            for row in ctx.lines
        )
        > 1
        for a in ctx.archives
    ):
        raise FitError("ambiguous_output")
    figures, _unallocated = order_metrics.attribute(ctx)
    recipes = await recipes_for_products(db, ctx.products_by_id.values())
    queued = await plan_engine.queued_yield_by_line(
        db,
        recipes,
        ctx.lines,
        {lid: {p.part_id for p in f.parts if p.per > 0} for lid, f in figures.items()},
    )
    removable = []
    if replace_pending:
        stmt = (
            select(AutoQueueItem)
            .where(
                AutoQueueItem.project_line_id == line_id,
                AutoQueueItem.status == "pending",
                AutoQueueItem.assigned_to_item_id.is_(None),
                AutoQueueItem.cancelled_at.is_(None),
            )
            .order_by(AutoQueueItem.id)
            .execution_options(populate_existing=True)
        )
        if lock_pending:
            stmt = stmt.with_for_update(nowait=True)
        try:
            pending = list((await db.execute(stmt)).scalars())
        except DBAPIError as exc:
            raise FitError("stale") from exc
        by_plate, by_file = plan_engine.plate_recipe_index(recipes)
        for item in pending:
            if queue_rebalance.refusal(item) is not None:
                continue
            recipe = plan_engine.recipes_for_row(by_plate, by_file, item.library_file_id, item.plate_id or 0).get(
                line.product_id
            )
            if recipe is None or not any(recipe.yield_by_part.get(p.id, 0) for p, _per in comp):
                continue
            removable.append(item)
            for p, _per in comp:
                bucket = queued.setdefault(line_id, {})
                bucket[p.id] = max(0, bucket.get(p.id, 0) - recipe.yield_by_part.get(p.id, 0))
    supply = await stock_offers.load_supply(db, ctx)
    all_candidates = recipes.get(line.product_id, [])
    if plate_ids is None:
        plan = await plan_engine.plan_for_order(db, order_id)
        plate_ids = [row.plate_id for item in plan.lines if item.line_id == line_id for row in item.rows]
        if not plate_ids:
            # A fully covered line has no outstanding plan. Its linked, sliced
            # plates still make sense for exploring a larger order quantity.
            plate_ids = [
                p.id
                for p, _f, recipe in all_candidates
                if recipe.sliced and order_metrics.line_accepts_materials(line, recipe.materials)
            ]
    if len(plate_ids) > 64:
        raise FitError("plates")
    if not plate_ids or len(set(plate_ids)) != len(plate_ids):
        raise FitError("plates")
    candidates = sorted([row for row in all_candidates if row[0].id in plate_ids], key=lambda row: row[0].id)
    if len(candidates) != len(plate_ids) or any(
        not recipe.sliced or not order_metrics.line_accepts_materials(line, recipe.materials)
        for _plate, _file, recipe in candidates
    ):
        raise FitError("plates")
    counted_ids = {part.id for part, _per in comp}
    shelf_ids = {part.id for part in ctx.parts_by_product[line.product_id] if has_shelf(part)}
    if any(recipe.unassigned or (set(recipe.yield_by_part) & shelf_ids) - counted_ids for _p, _f, recipe in candidates):
        raise FitError("unmapped_output")
    figs = figures[line_id]
    if line.returned or any(p.already_banked for p in figs.parts):
        raise FitError("banked_output")
    parts = []
    for pf in figs.parts:
        if pf.per <= 0:
            if pf.usable or pf.in_progress:
                raise FitError("unmapped_output")
            continue
        percent = Fraction(str((line.extra_percentages or {}).get(str(pf.part_id), 0)))
        extra = pf.per * percent / 100
        if percent < 0 or extra.denominator > 1_000_000 or extra.numerator > 1_000_000_000:
            raise FitError("composition")
        completed = max(
            pf.usable, pf.per * figs.received - pf.stock_used_qty + pf.extra_received_qty - pf.extra_stock_received_qty
        )
        allocated = pf.allocated_qty + pf.stock_used_qty + pf.extra_stock_received_qty
        fixed = (
            pf.per * (figs.from_finished + figs.assembled - figs.written_off)
            + allocated
            + completed
            + pf.in_progress
            + queued.get(line_id, {}).get(pf.part_id, 0)
            - pf.extra_written_off_qty
        )
        parts.append(
            Part(
                pf.part_id,
                pf.name,
                pf.per,
                extra,
                fixed,
                allocated,
                completed,
                pf.in_progress,
                queued.get(line_id, {}).get(pf.part_id, 0),
            )
        )
    plates = [
        Plate(
            p.id,
            tuple(recipe.yield_by_part.get(part.id, 0) for part in parts),
            recipe.print_time_seconds,
            recipe.filament_used_grams,
        )
        for p, _file, recipe in candidates
    ]
    if any(not any(p.yields) for p in plates):
        raise FitError("plates")
    minimum = max(
        1,
        (line.issued or 0)
        + max(
            0,
            (line.from_finished or 0)
            + (line.assembled or 0)
            + (line.received or 0)
            - (line.issued or 0)
            - (line.returned or 0)
            - (line.written_off or 0),
        ),
        figs.from_stock_units,
    )
    payload = {
        "order": order_id,
        "line": line_id,
        "quantity": line.quantity,
        "configuration": line.config_key,
        "minimum": minimum,
        "parts": [asdict(p) | {"extra": str(p.extra)} for p in parts],
        "plates": [asdict(p) for p in plates],
        "replace_pending": replace_pending,
        "supply": asdict(supply),
        "shared_claims": {lid: asdict(f) for lid, f in figures.items()},
        "shared_queued": queued,
        "removable": [{c.name: getattr(item, c.name) for c in AutoQueueItem.__table__.columns} for item in removable],
    }
    basis = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()
    return Snapshot(line_id, line.quantity, minimum, parts, plates, basis, candidates, removable, ctx, queued, supply)


def option(
    snapshot: Snapshot, quantity: int, counts: list[int], offer: stock_offers.Offer | None = None
) -> PlateFitOption | None:
    if not snapshot.minimum <= quantity <= MAX_QUANTITY or len(counts) != len(snapshot.plates):
        return None
    if any(type(n) is not int or n < 0 or n > MAX_QUANTITY for n in counts):
        return None
    made = [
        sum(plate.yields[i] * n for plate, n in zip(snapshot.plates, counts, strict=True))
        for i in range(len(snapshot.parts))
    ]
    offer = offer or stock_offers.Offer(snapshot.line_id, "", 0, 0)
    from_free = [p.per * (offer.from_finished + offer.kits) + offer.parts.get(p.id, 0) for p in snapshot.parts]
    if any(
        part.required(quantity) != part.fixed + n + stock
        for part, n, stock in zip(snapshot.parts, made, from_free, strict=True)
    ):
        return None
    active = [(plate, n) for plate, n in zip(snapshot.plates, counts, strict=True) if n]
    return PlateFitOption(
        quantity=quantity,
        from_finished=offer.from_finished,
        from_kits=offer.kits,
        stock_parts=offer.parts,
        runs=[PlateFitRun(plate_id=p.id, count=n) for p, n in active],
        parts=[
            PlateFitPart(
                part_id=p.id,
                name=p.name,
                required=p.required(quantity),
                allocated=p.allocated,
                completed=p.completed,
                printing=p.printing,
                queued=p.queued,
                new_printed=n,
                free_stock=stock,
                other_coverage=p.fixed - p.allocated - p.completed - p.printing - p.queued,
            )
            for p, n, stock in zip(snapshot.parts, made, from_free, strict=True)
        ],
        print_time_seconds=sum(p.seconds * n for p, n in active)
        if all(p.seconds and p.seconds > 0 for p, _n in active)
        else None,
        filament_used_grams=sum(p.grams * n for p, n in active)
        if all(p.grams is not None for p, _n in active)
        else None,
    )


def greedy_option(snapshot: Snapshot, quantity: int) -> tuple[PlateFitOption | None, bool]:
    """Accept only the existing greedy cover after the existing greedy shelf offer."""
    offer = stock_offers.Offer(snapshot.line_id, "", 0, 0)
    if snapshot.context is not None and snapshot.supply is not None:
        # Plain value objects: changing an ORM line even in a rolled-back preview
        # would mark the live session dirty and could autoflush it on a later read.
        lines = [
            SimpleNamespace(**{c.name: getattr(line, c.name) for c in line.__table__.columns})
            for line in snapshot.context.lines
        ]
        next(line for line in lines if line.id == snapshot.line_id).quantity = quantity
        ctx = replace(snapshot.context, lines=lines)
        figures, _ = order_metrics.attribute(ctx)
        offer = next(
            (
                o
                for o in stock_offers.offers_for(ctx, figures, snapshot.queued, snapshot.supply)
                if o.line_id == snapshot.line_id
            ),
            offer,
        )
    need = {
        p.id: p.required(quantity) - p.fixed - p.per * (offer.from_finished + offer.kits) - offer.parts.get(p.id, 0)
        for p in snapshot.parts
    }
    if any(n < 0 for n in need.values()):
        return None, False
    rows, surplus, truncated = plan_engine.cover(need, snapshot.candidates, set(need), None)
    if truncated:
        return None, True
    if surplus:
        return None, False
    runs = {row.plate_id: row.count for row in rows}
    return option(snapshot, quantity, [runs.get(p.id, 0) for p in snapshot.plates], offer), False


def solve(
    snapshot: Snapshot, lower: int, upper: int, direction: int, deadline: float
) -> tuple[PlateFitOption | None, str]:
    """HiGHS only skips impossible quantities; stock_offers + greedy cover decide.

    The integer model is a necessary-condition relaxation of the canonical
    greedy choices, never a replacement objective or returned plate mix. Each
    optimally nearest candidate is checked by those existing algorithms. A
    rejected quantity is excluded and search continues, under one time budget.
    """
    import numpy as np
    from scipy.optimize import Bounds, LinearConstraint, milp

    lower, upper = max(lower, snapshot.minimum), min(upper, MAX_QUANTITY)
    if lower > upper:
        return None, "none"
    if deadline <= time.monotonic():
        return None, "limited"
    edge, truncated = greedy_option(snapshot, lower if direction == 1 else upper)
    if truncated:
        return None, "limited"
    if edge is not None:
        return edge, "found"
    ready = 0
    loose = [0] * len(snapshot.parts)
    if snapshot.supply is not None and snapshot.context is not None:
        line = next(row for row in snapshot.context.lines if row.id == snapshot.line_id)
        ready = snapshot.supply.ready[line.id].finished_free
        loose = [snapshot.supply.parts.get(line.product_id, {}).get(p.id, 0) for p in snapshot.parts]
    if not ready and not any(loose):
        for i, left in enumerate(snapshot.parts):
            for j, right in enumerate(snapshot.parts[:i]):
                if left.extra or right.extra:
                    continue
                divisor = gcd(*(right.per * p.yields[i] - left.per * p.yields[j] for p in snapshot.plates))
                offset = right.per * left.fixed - left.per * right.fixed
                if (divisor == 0 and offset != 0) or (divisor and offset % divisor):
                    return None, "none"
    saturation = MAX_QUANTITY + 1
    shared_product = False
    if snapshot.context is not None:
        shared_product = any(
            row.id != snapshot.line_id and row.product_id == line.product_id for row in snapshot.context.lines
        )

    # Above this BASE-unit bound, even after all already covered/queued
    # components, enough base-kit room remains to take every ready unit and
    # loose part. Extras alone cannot establish it: all base units might
    # already be covered, in which case the ready-goods offer must stay zero.
    # Another configuration's whole-kit pass can precede this line's loose
    # pass, even when that line is later. Shared products therefore retain the
    # conservative relaxation; never assume their shelf belongs to this line.
    if not shared_product:
        covered_bound = max((-(-max(0, p.fixed) // p.per) for p in snapshot.parts), default=0)
        if snapshot.context is not None:
            figures, _ = order_metrics.attribute(snapshot.context)
            existing = figures[snapshot.line_id]
            # This deliberately overestimates covered BASE units. Do not let
            # extra write-offs cancel that bound merely because they subtract
            # from the exact part equation above.
            covered_bound = max(
                covered_bound,
                sum(max(0, getattr(line, key) or 0) for key in ("from_finished", "assembled", "received"))
                + max(
                    (
                        -(-(p.usable + p.allocated_qty + p.stock_used_qty + p.extra_stock_received_qty) // p.per)
                        for p in existing.parts
                        if p.per > 0
                    ),
                    default=0,
                ),
            )
        parts_bound = max((-(-cap // p.per) for p, cap in zip(snapshot.parts, loose, strict=True)), default=0)
        saturation = max(snapshot.minimum, covered_bound + ready + parts_bound)
    regions = [(lower, min(upper, saturation - 1), False), (max(lower, saturation), upper, True)]
    if direction == -1:
        regions.reverse()
    m, n = len(snapshot.plates), len(snapshot.parts)
    stock_at = 1 + m + n
    size = stock_at + 1 + n
    matrix, lo, hi = [], [], []
    for i, part in enumerate(snapshot.parts):
        row = [0] * size
        row[0], row[1 + m + i] = part.per, 1
        row[stock_at], row[stock_at + 1 + i] = -part.per, -1
        for j, plate in enumerate(snapshot.plates):
            row[1 + j] = -plate.yields[i]
        matrix.append(row)
        lo.append(part.fixed)
        hi.append(part.fixed)
        row = [0] * size
        row[0], row[1 + m + i] = -part.extra.numerator, part.extra.denominator
        matrix.append(row)
        lo.append(0)
        hi.append(part.extra.denominator - 1)
    objective = np.zeros(size)
    objective[0] = direction
    for region_low, region_high, saturated in regions:
        lower, upper = region_low, region_high
        while lower <= upper:
            seconds = deadline - time.monotonic()
            if seconds <= 0:
                return None, "limited"
            bounds = Bounds(
                [lower] + [0] * (m + n) + ([ready] + loose if saturated else [0] * (n + 1)),
                [upper] + [MAX_QUANTITY] * m + [np.inf] * n + [ready] + loose,
            )
            try:
                result = milp(
                    objective,
                    integrality=np.ones(size),
                    bounds=bounds,
                    constraints=LinearConstraint(np.array(matrix, dtype=float), lo, hi),
                    options={"time_limit": min(1.5, seconds), "mip_rel_gap": 0.0, "node_limit": 100_000},
                )
            except (ValueError, RuntimeError):
                return None, "limited"
            if result.status == 2:
                break
            if result.status != 0 or result.x is None or len(result.x) != size:
                return None, "limited"
            values = [int(round(v)) for v in result.x]
            q, picked_ready = values[0], values[stock_at]
            picked_parts = values[stock_at + 1 :]
            if (
                not lower <= q <= upper
                or not 0 <= picked_ready <= ready
                or any(not 0 <= value <= maximum for value, maximum in zip(picked_parts, loose, strict=True))
            ):
                return None, "limited"
            relaxed_offer = stock_offers.Offer(
                snapshot.line_id,
                "",
                picked_ready,
                0,
                {p.id: v for p, v in zip(snapshot.parts, picked_parts, strict=True) if v},
            )
            if option(snapshot, q, values[1 : 1 + m], relaxed_offer) is None:
                return None, "limited"
            found, truncated = greedy_option(snapshot, q)
            if truncated:
                return None, "limited"
            if found is not None:
                return found, "found"
            if direction == 1:
                lower = q + 1
            else:
                upper = q - 1

    return None, "none"


async def proposals(snapshot: Snapshot, request: PlateFitRequest) -> dict:
    def run():
        deadline = time.monotonic() + MAX_SECONDS
        same, same_status = solve(snapshot, request.around, request.around, 1, deadline)
        options = [same] if same is not None else []
        statuses = {}
        for direction, key in ((-1, "lower"), (1, "upper")):
            cursor = request.around
            statuses[key] = "none"
            for step in range(request.steps):
                low, high = (
                    (snapshot.minimum, cursor - 1)
                    if direction == -1
                    else (max(snapshot.minimum, cursor + 1), MAX_QUANTITY)
                )
                found, status = solve(snapshot, low, high, direction, deadline)
                if step == 0:
                    statuses[key] = status
                if found is None:
                    break
                options.append(found)
                cursor = found.quantity
        return dict(options=sorted(options, key=lambda o: o.quantity), current=same_status, **statuses)

    return await disk(run)


def confirm(snapshot: Snapshot, quantity: int, confirmation) -> PlateFitOption:
    if snapshot.basis != confirmation.basis:
        raise FitError("stale")
    if snapshot.removable and not confirmation.acknowledge_queue_change:
        raise FitError("queue_change")
    if abs(quantity - snapshot.quantity) * 100 > snapshot.quantity * 10 and not confirmation.acknowledge_large_change:
        raise FitError("large_change")
    runs = {row.plate_id: row.count for row in confirmation.runs}
    if len(runs) != len(confirmation.runs) or not set(runs) <= {p.id for p in snapshot.plates}:
        raise FitError("invalid_plan")
    result, truncated = greedy_option(snapshot, quantity)
    if truncated or result is None or runs != {r.plate_id: r.count for r in result.runs}:
        raise FitError("invalid_plan")
    return result


async def remove_reviewed_pending(db: AsyncSession, snapshot: Snapshot) -> None:
    """The pre-dispatch cancel rule: delete only rows never handed to a printer.

    This shares the quantity edit's transaction and never commits. The rows were
    re-read under NOWAIT row locks after the normal line/stock locks; the final
    predicate is still the scheduler's pending->assigned CAS counterpart. A race
    refuses the entire edit. Blob GC remains the existing collector's job.
    """
    ids = [item.id for item in snapshot.removable]
    if not ids:
        return
    result = await db.execute(
        delete(AutoQueueItem).where(
            AutoQueueItem.id.in_(ids),
            AutoQueueItem.status == "pending",
            AutoQueueItem.assigned_to_item_id.is_(None),
            AutoQueueItem.cancelled_at.is_(None),
        )
    )
    if result.rowcount != len(ids):
        raise FitError("stale")
