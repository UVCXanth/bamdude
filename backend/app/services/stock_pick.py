"""What an order line would take from stock — ONE function (spec workshop-add-to-order, rule 5).

Ready units of the line's own configuration first (its finished-goods position),
then whole kits of free parts for that configuration, up to the quantity; the
rest is printed. The add-to-order dialog's proposal (``POST /stock/suggest``),
the batch's ``stock: "auto"`` and the order card's «take from stock» (WS-11)
all ask this function, so the three cannot disagree about what the shelf holds.

Read-only, and a fixed number of statements whatever the length of the list:
the products with their parts and groups in one read, the positions of every
(product, configuration) in one, the free-parts balances of every product in
one. A request naming an existing ``line_id`` also counts what that line already
holds as free for it — the line may keep its own reservation when it is
rewritten (the writers release before they take).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.product import ProductOrigin
from backend.app.models.project_line import ProjectLine
from backend.app.services import finished_stock, line_config, part_stock
from backend.app.services.entity_codes import code_for
from backend.app.services.line_composition import composition, counted


class StockPickError(Exception):
    """A request the proposal cannot answer; ``status`` is the HTTP answer."""

    def __init__(self, detail: str, status: int = 422) -> None:
        super().__init__(detail)
        self.status = status


@dataclass(frozen=True, slots=True)
class PickRequest:
    product_id: int
    choices: Mapping[int, int]
    counts: Mapping[int, int]
    quantity: int
    line_id: int | None = None


@dataclass(frozen=True, slots=True)
class Suggestion:
    product_id: int
    #: Free ready units in the position of THIS configuration.
    finished_free: int
    #: Whole kits of this configuration the free-parts shelf can make.
    kits_free: int
    from_finished: int
    from_kits: int
    to_print: int
    position_id: int | None
    position_code: str | None


async def _line_back(
    db: AsyncSession, line_id: int, product_id: int, key: str, shelf: dict[int, int]
) -> tuple[int, dict[int, int]]:
    """What an existing line holds that it may keep: its ready units in this
    position, and its reserved kits put back on its product's shelf."""
    line = await db.get(ProjectLine, line_id)
    if line is None or line.product_id != product_id:
        return 0, shelf
    held = 0
    position = await finished_stock.position_for_key(db, product_id, key)
    if position is not None:
        held = (await finished_stock.held_by_item(db, line.id)).get(position.id, 0)
    kits = await part_stock.reserved_units_for_line(db, line)
    if kits:
        shelf = dict(shelf)
        for part, per in counted(await part_stock.line_composition_of(db, line)):
            shelf[part.id] = shelf.get(part.id, 0) + kits * per
    return held, shelf


async def suggest(db: AsyncSession, requests: Sequence[PickRequest]) -> list[Suggestion]:
    """The proposal for each request, in the order asked."""
    products = await line_config.load_products(db, {r.product_id for r in requests})
    resolved = []
    for request in requests:
        product = products.get(request.product_id)
        if product is None:
            raise StockPickError("Product not found", 404)
        if request.quantity < 1:
            raise StockPickError("Quantity must be at least 1", 422)
        try:
            key, choices, counts = line_config.resolve_on(product, request.choices, request.counts)
        except line_config.LineConfigError as e:
            raise StockPickError(str(e), e.status) from e
        resolved.append((request, product, key, choices, counts))
    catalogue = [
        (product.id, key) for _r, product, key, _c, _n in resolved if product.origin == ProductOrigin.CATALOG.value
    ]
    positions = await finished_stock.free_by_keys(db, catalogue)
    balances = await part_stock.balances_for_products(db, sorted(products))
    out: list[Suggestion] = []
    for request, product, key, choices, counts in resolved:
        item = positions.get((product.id, key))
        finished_free = item.on_hand - item.reserved if item is not None else 0
        shelf = balances.get(product.id, {})
        if request.line_id is not None:
            held, shelf = await _line_back(db, request.line_id, product.id, key, shelf)
            finished_free += held
        defaults = {g.id: g.default_option_id for g in product.variant_groups if g.default_option_id is not None}
        kit = composition(list(product.parts), "product", set({**defaults, **choices}.values()), counts)
        kits_free = part_stock.kits_of(shelf, kit)
        from_finished = min(request.quantity, finished_free)
        from_kits = min(request.quantity - from_finished, kits_free)
        out.append(
            Suggestion(
                product_id=product.id,
                finished_free=finished_free,
                kits_free=kits_free,
                from_finished=from_finished,
                from_kits=from_kits,
                to_print=request.quantity - from_finished - from_kits,
                position_id=item.id if item is not None else None,
                position_code=code_for("stock_item", item.id) if item is not None else None,
            )
        )
    return out
