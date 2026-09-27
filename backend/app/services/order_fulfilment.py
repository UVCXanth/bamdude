"""An order's goods assembled, received and issued in batches — one function reads, one performs
(spec workshop-order-issue, rules 11, 12, 24).

:func:`state` is what the issue window shows and what :func:`apply` checks against: the same
arithmetic for the display and for the act. ``apply`` reads it again under the locks, refuses any
number above it with a sentence (409 — never clamped: an issue is physical units handed over) and
writes nothing then; otherwise, per line, assemble → receive → issue, one :class:`StockIssue` for
the whole request, the journal, and — asked and allowed — the order closed. It writes through the
ledgers' own writers only (``finished_stock``, ``part_stock``, ``stock_issues``) and never commits.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.project import Project
from backend.app.models.project_line import ProjectLine, ProjectLinePartStock
from backend.app.models.stock_issue import StockIssue
from backend.app.models.user import User
from backend.app.services import finished_stock, order_journal, part_stock, stock_issues
from backend.app.services.order_metrics import LineFigures, OrderContext, attribute, load_order_context
from backend.app.services.stock_issues import Recipient


class FulfilmentError(Exception):
    """A batch the order refuses; ``status`` is the HTTP answer."""

    def __init__(self, detail: str, status: int = 409) -> None:
        super().__init__(detail)
        self.status = status


@dataclass(frozen=True, slots=True)
class PartState:
    part_id: int
    name: str
    wanted: int
    can_receive: int
    held: int
    issued: int


@dataclass(frozen=True, slots=True)
class LineState:
    line_id: int
    product_name: str
    mode: str
    ordered: int
    from_finished: int
    #: The line's live kit reservation.
    kits_reserved: int
    can_assemble: int
    can_receive: int
    #: On the shelf under the order (spec rule 7).
    held: int
    issued: int
    #: A parts line's parts, each counted on its own; empty for a product line.
    parts: list[PartState] = field(default_factory=list)

    @property
    def fully_issued(self) -> bool:
        if self.mode == "parts":
            return all(part.issued >= part.wanted for part in self.parts)
        return self.issued >= self.ordered


@dataclass(frozen=True, slots=True)
class OrderState:
    lines: list[LineState]
    ordered: int
    issued: int
    held: int
    fully_issued: bool


@dataclass(frozen=True, slots=True)
class LineRequest:
    line_id: int
    assemble: int = 0
    receive: int = 0
    issue: int = 0
    #: A parts line's numbers: ``part_id → (receive, issue)``.
    parts: dict[int, tuple[int, int]] = field(default_factory=dict)

    def numbers(self) -> list[int]:
        return [self.assemble, self.receive, self.issue, *(n for pair in self.parts.values() for n in pair)]


def _product_line(ctx: OrderContext, line, figs: LineFigures, name: str) -> LineState:
    kits = ctx.reserved_by_line.get(line.id, 0)
    from_finished, assembled, received = line.from_finished or 0, line.assembled or 0, line.received or 0
    # What the shelf and the kits already cover is not printed work to receive; what is
    # received covers the printed units from before (defects recorded later can make
    # ``units_printed`` smaller than ``received`` — then there is simply nothing more).
    room = line.quantity - from_finished - (kits + assembled)
    # A kit is assembled only into a unit the order still needs: past the quantity it
    # would leave finished units held for an order that closes (spec rule 12).
    covered = from_finished + assembled + received
    return LineState(
        line_id=line.id,
        product_name=name,
        mode=line.mode,
        ordered=line.quantity,
        from_finished=from_finished,
        kits_reserved=kits,
        can_assemble=max(0, min(kits, line.quantity - covered)),
        can_receive=max(0, min(room, figs.units_printed) - received),
        held=finished_stock.held_units(line),
        issued=line.issued or 0,
    )


def _parts_line(line, figs: LineFigures, name: str, counters: dict[int, ProjectLinePartStock]) -> LineState:
    parts = []
    # The parts with a shelf — the ones the parts ledger can hold for the order.
    for pf in figs.parts:
        if pf.per <= 0 or not pf.shelf:
            continue
        row = counters.get(pf.part_id)
        received = row.received if row is not None else 0
        parts.append(
            PartState(
                part_id=pf.part_id,
                name=pf.name,
                wanted=pf.per,
                can_receive=max(0, min(pf.per, pf.usable) - received),
                held=part_stock.part_held(row) if row is not None else 0,
                issued=row.issued if row is not None else 0,
            )
        )
    return LineState(
        line_id=line.id,
        product_name=name,
        mode=line.mode,
        ordered=sum(part.wanted for part in parts),
        from_finished=0,
        kits_reserved=0,
        can_assemble=0,
        can_receive=0,
        held=sum(part.held for part in parts),
        issued=sum(part.issued for part in parts),
        parts=parts,
    )


async def moved_line_ids(db: AsyncSession, lines: Sequence[ProjectLine]) -> set[int]:
    """The lines whose stock has moved (spec rule 13): a product line assembled, received
    or issued something; a parts line received or issued a part. One read for the parts lines."""
    moved = {line.id for line in lines if line.mode != "parts" and finished_stock.moved(line)}
    counters = await part_stock.line_part_stock(db, [line.id for line in lines if line.mode == "parts"])
    for line_id, rows in counters.items():
        if any(row.received + row.issued > 0 for row in rows.values()):
            moved.add(line_id)
    return moved


async def state(db: AsyncSession, project: Project) -> OrderState:
    """What each line can assemble, receive and issue now — the order's context and the
    parts lines' counters read once each, whatever the order's size."""
    ctx = await load_order_context(db, project.id)
    if ctx is None:
        raise FulfilmentError("Project not found", 404)
    figures, _other = attribute(ctx)
    counters = await part_stock.line_part_stock(db, [line.id for line in ctx.lines if line.mode == "parts"])
    lines = []
    for line in ctx.lines:
        product = ctx.products_by_id.get(line.product_id)
        name = product.name if product is not None else ""
        if line.mode == "parts":
            lines.append(_parts_line(line, figures[line.id], name, counters.get(line.id, {})))
        else:
            lines.append(_product_line(ctx, line, figures[line.id], name))
    return OrderState(
        lines=lines,
        ordered=sum(row.ordered for row in lines),
        issued=sum(row.issued for row in lines),
        held=sum(row.held for row in lines),
        fully_issued=all(row.fully_issued for row in lines),
    )


def _check(row: LineState, request: LineRequest) -> None:
    """Refuse the first number above what ``row`` allows — the order is assemble, receive,
    issue, because what is issued may come from the first two of the same request."""
    name = row.product_name
    if row.mode == "parts":
        if request.assemble or request.receive or request.issue:
            raise FulfilmentError(f"«{name}» is received and issued part by part", 422)
        by_id = {part.part_id: part for part in row.parts}
        for part_id, (receive, issue) in sorted(request.parts.items()):
            part = by_id.get(part_id)
            if part is None:
                raise FulfilmentError(f"«{name}» does not count this part", 422)
            if receive > part.can_receive:
                raise FulfilmentError(f"«{name}», {part.name}: only {part.can_receive} can be received")
            if issue > part.held + receive:
                raise FulfilmentError(f"«{name}», {part.name}: only {part.held + receive} can be issued")
        return
    if request.parts:
        raise FulfilmentError(f"«{name}» is issued as whole units", 422)
    if request.assemble > row.can_assemble:
        raise FulfilmentError(f"«{name}»: only {row.can_assemble} can be assembled")
    if request.receive > row.can_receive:
        raise FulfilmentError(f"«{name}»: only {row.can_receive} can be received")
    if request.issue > row.held + request.assemble + request.receive:
        raise FulfilmentError(f"«{name}»: only {row.held + request.assemble + request.receive} can be issued")


def _issued_after(row: LineState, request: LineRequest | None) -> bool:
    """Would ``row`` be fully issued once ``request`` is done?"""
    if row.mode == "parts":
        asked = request.parts if request is not None else {}
        return all(part.issued + asked.get(part.part_id, (0, 0))[1] >= part.wanted for part in row.parts)
    return row.issued + (request.issue if request is not None else 0) >= row.ordered


async def apply(
    db: AsyncSession,
    project: Project,
    requests: Sequence[LineRequest],
    *,
    recipient: Recipient,
    waybill: str | None,
    note: str | None,
    complete: bool,
    actor: User | None,
) -> StockIssue | None:
    """Perform one batch in the caller's transaction; the issue it opened, or None."""
    if project.status != "active":
        raise FulfilmentError("Only an active order can be fulfilled")
    # Read, not the relationship: a caller may hold the order without its lines loaded.
    lines = {
        line.id: line
        for line in (await db.execute(select(ProjectLine).where(ProjectLine.project_id == project.id))).scalars()
    }
    asked: dict[int, LineRequest] = {}
    for request in requests:
        if request.line_id not in lines:
            raise FulfilmentError("Order line not found", 404)
        if request.line_id in asked:
            raise FulfilmentError("A line is named twice", 422)
        if any(n < 0 for n in request.numbers()):
            raise FulfilmentError("Quantity must be at least 0", 422)
        asked[request.line_id] = request
    if not complete and not any(n > 0 for request in asked.values() for n in request.numbers()):
        raise FulfilmentError("Nothing to do", 422)

    # Positions first, in ascending id, then the lines — the order every closing door
    # takes (WS-10 M4) — and only then the numbers, read fresh under the locks.
    await finished_stock.lock_positions_for_lines(db, list(lines))
    for line_id in sorted(lines):
        await finished_stock.lock_line(db, lines[line_id])
    current = {row.line_id: row for row in (await state(db, project)).lines}
    for line_id in sorted(asked):
        _check(current[line_id], asked[line_id])
    if complete and not all(_issued_after(row, asked.get(row.line_id)) for row in current.values()):
        raise FulfilmentError("Issue everything the order holds before completing it")
    issuing = sum(request.issue + sum(i for _r, i in request.parts.values()) for request in asked.values())
    if issuing and project.customer_id is None:
        raise FulfilmentError("An issue names its customer — set the order's customer first")

    created_by = actor.id if actor is not None else None
    for line_id in sorted(asked):
        line, request, name = lines[line_id], asked[line_id], current[line_id].product_name
        if request.assemble:
            await finished_stock.assemble_for_line(db, line, request.assemble, actor=actor)
            await order_journal.record(
                db,
                project.id,
                "kits_assembled",
                {"line_id": line_id, "product": name, "units": request.assemble},
                actor=actor,
            )
        if request.receive:
            await finished_stock.produce_for_line(db, line, request.receive, actor=actor)
            await order_journal.record(
                db,
                project.id,
                "goods_received",
                {"line_id": line_id, "product": name, "units": request.receive},
                actor=actor,
            )
        received = {pid: r for pid, (r, _i) in request.parts.items() if r > 0}
        if received:
            await part_stock.receive_parts_for_line(db, line, received, created_by=created_by)
            names = {part.part_id: part.name for part in current[line_id].parts}
            await order_journal.record(
                db,
                project.id,
                "goods_received",
                {
                    "line_id": line_id,
                    "product": name,
                    "parts": [[names[pid], n] for pid, n in sorted(received.items())],
                },
                actor=actor,
            )

    issue = None
    if issuing:
        issue = await stock_issues.create(
            db,
            customer_id=project.customer_id,
            project_id=project.id,
            recipient=recipient,
            waybill=waybill,
            note=note,
            actor=actor,
        )
        for line_id in sorted(asked):
            line, request = lines[line_id], asked[line_id]
            if request.issue:
                await finished_stock.issue_from_line(db, line, request.issue, stock_issue=issue, actor=actor)
            given = {pid: i for pid, (_r, i) in request.parts.items() if i > 0}
            if given:
                await part_stock.issue_parts_for_line(db, line, given, stock_issue_id=issue.id, created_by=created_by)
        await order_journal.record(
            db,
            project.id,
            "goods_issued",
            {"issue_id": issue.id, "units": issuing, "waybill": issue.waybill},
            actor=actor,
        )

    if complete:
        project.status = "completed"
        # Everything ordered went out; kits nobody assembled go back on the shelf (spec rule 12).
        for line_id in sorted(lines):
            await part_stock.release_for_line(db, lines[line_id], note=part_stock.NOTE_ORDER_COMPLETED)
        await order_journal.record(db, project.id, "status_changed", {"from": "active", "to": "completed"}, actor=actor)
    await db.flush()
    return issue
