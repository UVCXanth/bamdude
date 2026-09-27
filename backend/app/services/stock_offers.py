"""«Взяти зі складу» — ready units and kits for what an order has not printed, is not
printing and has not queued (spec workshop-order-issue, rule 17).

The offer is the plan's own arithmetic — ``plan_engine.unplanned_units`` over the figures
and the queue reading the plan endpoint uses — handed to ``stock_pick.suggest``, the one
function that answers what the shelves give; asked WITHOUT a line id, because an offer
ADDS to the line and the units it already holds are not free for it. Taking goes through
the two add-only doors (``finished_stock.take_for_line``, ``part_stock.add_kits_for_line``)
— never a release first, whatever the line has moved — and what it gets may be less than
what was shown: the shelf is clamped, never refused (a reservation, as in WS-10).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.project import Project
from backend.app.models.project_line import ProjectLine
from backend.app.models.user import User
from backend.app.services import finished_stock, order_journal, part_stock, plan_engine, stock_pick
from backend.app.services.line_composition import load_line_configs
from backend.app.services.order_metrics import attribute, load_order_context
from backend.app.services.product_composition import recipes_for_products


class StockOfferError(Exception):
    """A take the order refuses; ``status`` is the HTTP answer."""

    def __init__(self, detail: str, status: int = 409) -> None:
        super().__init__(detail)
        self.status = status


@dataclass(frozen=True, slots=True)
class Offer:
    line_id: int
    product_name: str
    from_finished: int
    kits: int


@dataclass(frozen=True, slots=True)
class Taken:
    line_id: int
    asked_finished: int
    got_finished: int
    asked_kits: int
    got_kits: int


async def offers(db: AsyncSession, project: Project) -> list[Offer]:
    """What each product line of an ACTIVE order could take off the shelves now — lines
    with nothing to take are left out."""
    if project.status != "active":
        return []
    ctx = await load_order_context(db, project.id)
    if ctx is None:
        return []
    figures, _other = attribute(ctx)
    lines = [line for line in ctx.lines if line.mode == "product"]
    if not lines:
        return []
    recipes = await recipes_for_products(db, ctx.products_by_id.values())
    queued = await plan_engine.queued_yield_by_line(
        db, recipes, ctx.lines, plan_engine.counted_parts_by_line({project.id: figures})
    )
    wants: dict[int, int] = {}
    for line in lines:
        figs = figures[line.id]
        want = min(
            plan_engine.unplanned_units(figs, queued.get(line.id, {})), max(0, figs.quantity - figs.covered_units)
        )
        if want > 0:
            wants[line.id] = want
    if not wants:
        return []
    configs = await load_line_configs(db, list(wants))
    asked = [line for line in lines if line.id in wants]
    suggestions = await stock_pick.suggest(
        db,
        [
            stock_pick.PickRequest(
                product_id=line.product_id,
                choices=configs[line.id].choices if line.id in configs else {},
                counts=configs[line.id].counts if line.id in configs else {},
                quantity=wants[line.id],
            )
            for line in asked
        ],
    )
    out = []
    for line, suggestion in zip(asked, suggestions, strict=True):
        if suggestion.from_finished or suggestion.from_kits:
            product = ctx.products_by_id.get(line.product_id)
            out.append(
                Offer(
                    line_id=line.id,
                    product_name=product.name if product is not None else "",
                    from_finished=suggestion.from_finished,
                    kits=suggestion.from_kits,
                )
            )
    return out


async def take(
    db: AsyncSession,
    project: Project,
    shown: Mapping[int, tuple[int, int]] | None = None,
    *,
    actor: User | None,
) -> list[Taken]:
    """Take the offers — the numbers the operator was SHOWN (``line_id → (ready, kits)``),
    or the current offers when nothing was shown — no more than the offer is now, and
    what the add doors can actually take. Journals ``stock_taken`` per line that got any."""
    if project.status != "active":
        raise StockOfferError("Only an active order takes finished goods from stock")
    lines = {
        line.id: line
        for line in (
            await db.execute(
                select(ProjectLine).where(ProjectLine.project_id == project.id, ProjectLine.mode == "product")
            )
        ).scalars()
    }
    # Positions in ascending id, then the lines — then the offers, read fresh under the locks.
    await finished_stock.lock_positions_for_lines(db, list(lines))
    for line_id in sorted(lines):
        await finished_stock.lock_line(db, lines[line_id])
    current = {offer.line_id: offer for offer in await offers(db, project)}
    asked = dict(shown) if shown is not None else {lid: (o.from_finished, o.kits) for lid, o in current.items()}
    out = []
    for line_id in sorted(asked):
        line = lines.get(line_id)
        if line is None:
            continue
        asked_finished, asked_kits = asked[line_id]
        offer = current.get(line_id)
        finished = min(asked_finished, offer.from_finished) if offer is not None else 0
        kits = min(asked_kits, offer.kits) if offer is not None else 0
        got_finished = await finished_stock.take_for_line(db, line, finished, actor=actor) if finished else 0
        got_kits = (
            await part_stock.add_kits_for_line(db, line, kits, created_by=actor.id if actor is not None else None)
            if kits
            else 0
        )
        if got_finished or got_kits:
            await order_journal.record(
                db,
                project.id,
                "stock_taken",
                {
                    "line_id": line_id,
                    "product": offer.product_name if offer is not None else None,
                    "from_finished": got_finished,
                    "kits": got_kits,
                },
                actor=actor,
            )
        out.append(Taken(line_id, asked_finished, got_finished, asked_kits, got_kits))
    await db.flush()
    return out
