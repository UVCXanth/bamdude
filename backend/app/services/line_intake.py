"""One road for every new order line (spec workshop-add-to-order, rules 6–7, 11–12).

The add-to-order dialog's batch (``POST /projects/{id}/lines/batch``), the old
single-line route and an order created with its lines all come through
:func:`add_lines`, so a line is born the same way whatever door it came in by:
its row, its configuration (``line_config.seed_line``), its stock and its
journal entry, in the caller's transaction.

Stock is taken only by an ACTIVE order, and only by a product line: ready units
of the line's configuration first (``finished_stock.reserve_for_line``), kits of
free parts for the rest (``part_stock.reserve_for_line``). ``stock: "auto"``
asks :func:`stock_pick.suggest`; explicit numbers are taken as far as the shelf
goes — the writers CLAMP, never refuse, so a shelf that moved while the dialog
was open gives less and the answer says how much (``asked`` / ``got``).

A refusal of any line raises :class:`LineIntakeError` with that line's own
sentence; the route turns it into the HTTP answer and the request's transaction
rolls back — a batch is added whole or not at all.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.library import LibraryFile
from backend.app.models.product import Product
from backend.app.models.project import Project
from backend.app.models.project_line import ProjectLine
from backend.app.models.user import User
from backend.app.schemas.project import BatchPartsLineIn, BatchPlateLineIn, BatchProductLineIn, BatchStockIn
from backend.app.services import finished_stock, line_config, order_from_files, order_journal, part_stock, stock_pick


class LineIntakeError(Exception):
    """A line the batch refuses; ``status`` is the HTTP answer."""

    def __init__(self, detail: str, status: int) -> None:
        super().__init__(detail)
        self.status = status


@dataclass(slots=True)
class Intake:
    line: ProjectLine
    asked_finished: int = 0
    got_finished: int = 0
    asked_kits: int = 0
    got_kits: int = 0


_PLATE_ERRORS: dict[type, tuple[str, int]] = {
    order_from_files.FileNotFound: ("Library file not found", 404),
    order_from_files.NotPlannable: ("Only 3MF files can be planned", 400),
    order_from_files.PlateNotFound: ("Plate not found", 404),
}


async def _new_line(
    db: AsyncSession, spec, sort_order: int, visible: Callable[[LibraryFile], bool] | None
) -> ProjectLine:
    common = {"material": spec.material, "color": spec.color, "note": spec.note, "sort_order": sort_order}
    if isinstance(spec, BatchPlateLineIn):
        try:
            product = await order_from_files.plate_product_for(
                db, spec.library_file_id, spec.plate_index, visible=visible
            )
        except order_from_files.OrderFromFilesError as e:
            detail, status = _PLATE_ERRORS.get(type(e), ("Plate not found", 404))
            raise LineIntakeError(detail, status) from e
        return ProjectLine(product_id=product.id, quantity=spec.copies, mode="product", **common)
    if await db.get(Product, spec.product_id) is None:
        raise LineIntakeError("Product not found", 404)
    if isinstance(spec, BatchPartsLineIn):
        return ProjectLine(product_id=spec.product_id, quantity=1, mode="parts", **common)
    return ProjectLine(product_id=spec.product_id, quantity=spec.quantity, mode="product", **common)


async def _asked(db: AsyncSession, line: ProjectLine, spec) -> tuple[int, int]:
    """What the line asks of the shelf: the server's proposal, or the operator's numbers."""
    stock = getattr(spec, "stock", "auto")
    if isinstance(stock, BatchStockIn):
        return stock.from_finished, stock.from_kits
    choices = dict(getattr(spec, "choices", None) or {})
    counts = dict(getattr(spec, "part_counts", None) or {})
    [answer] = await stock_pick.suggest(db, [stock_pick.PickRequest(line.product_id, choices, counts, line.quantity)])
    return answer.from_finished, answer.from_kits


async def add_lines(
    db: AsyncSession,
    project: Project,
    specs: Sequence[BatchProductLineIn | BatchPartsLineIn | BatchPlateLineIn],
    *,
    actor: User | None,
    visible: Callable[[LibraryFile], bool] | None = None,
) -> list[Intake]:
    """Add every line in ``specs`` to ``project`` with its configuration, stock and
    journal entry; never commits. ``visible`` is the caller's library ownership
    gate for plate lines — a file it rejects is the same 404 as a missing one."""
    active = project.status == "active"
    sort_order = max((ln.sort_order for ln in project.lines), default=-1) + 1
    out: list[Intake] = []
    for spec in specs:
        line = await _new_line(db, spec, sort_order, visible)
        sort_order += 1
        project.lines.append(line)
        # Flushed first so the configuration, the movements and the journal have an id to name.
        await db.flush()
        choices = getattr(spec, "choices", None) or None
        counts = getattr(spec, "part_counts", None) or None
        try:
            await line_config.seed_line(db, line, choices=choices, counts=counts)
        except line_config.LineConfigError as e:
            raise LineIntakeError(str(e), e.status) from e
        intake = Intake(line)
        if active and line.mode == "product":
            try:
                intake.asked_finished, intake.asked_kits = await _asked(db, line, spec)
            except stock_pick.StockPickError as e:
                raise LineIntakeError(str(e), e.status) from e
            intake.got_finished = await finished_stock.reserve_for_line(
                db, line, min(intake.asked_finished, line.quantity), actor=actor
            )
            kits = min(intake.asked_kits, line.quantity - intake.got_finished)
            if kits > 0:
                await part_stock.reserve_for_line(db, line, kits, created_by=actor.id if actor else None)
                intake.got_kits = await part_stock.reserved_units_for_line(db, line)
        product = await db.get(Product, line.product_id)
        await order_journal.record(
            db,
            project.id,
            "line_added",
            {
                "line_id": line.id,
                "product": product.name if product else None,
                "quantity": line.quantity,
                "from_finished": intake.got_finished,
                "from_stock": intake.got_kits,
            },
            actor=actor,
        )
        out.append(intake)
    return out
