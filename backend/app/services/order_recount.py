"""Counted loose output of an order, using the existing figures and journal.

Archive defects describe a known print; free-stock corrections describe a shelf;
fulfilment writes off received goods. None describes an unexplained shortage of
unreceived order parts. A signed line projection supplies that missing fact.
There is no stock movement, queue mutation, or replacement of print history.
"""

from fastapi import HTTPException
from sqlalchemy import func, select

from backend.app.models.project import ProjectEvent
from backend.app.models.project_line import ProjectLine
from backend.app.services import order_journal, order_metrics, part_stock
from backend.app.services.order_draft import digest
from backend.app.services.product_gate import product_gate


def refuse(code="order_recount_changed"):
    return HTTPException(409, {"code": code, "message": "Read the part count again before saving"})


def adjustments(line):
    return {int(pid): int(n) for pid, n in (getattr(line, "part_count_adjustments", None) or {}).items() if n}


async def ensure_attribution_can_change(db, project_id, product_ids, *, configuration=False):
    """Do not redistribute pooled raw yield away from an outstanding signed count.

    The caller holds the existing product gates/stock locks, as recount does.
    Explicitly filed output is independent of line need and stays editable.
    A pooled correction must be reversed through the reviewed recount door
    before adding siblings or changing their need/configuration/reservations.
    """
    candidates = await db.execute(
        select(ProjectLine.product_id, ProjectLine.part_count_adjustments).where(
            ProjectLine.project_id == project_id,
            ProjectLine.product_id.in_(product_ids),
            ProjectLine.part_count_adjustments.is_not(None),
        )
    )
    corrected = {pid for pid, values in candidates if values and any(values.values())}
    if not corrected:
        return
    ctx = await order_metrics.load_order_context(db, project_id)
    line_ids = {line.id for line in ctx.lines}
    if configuration or any(
        a.status == "completed"
        and a.project_line_id not in line_ids
        and corrected.intersection(
            order_metrics.products_for_print(
                ctx.plate_product, ctx.whole_file_product, library_file_id=a.library_file_id, plate_index=a.plate_index
            )
        )
        for a in ctx.archives
    ):
        raise HTTPException(409, "Reverse this product's recount corrections before redistributing pooled order output")


async def ensure_history_can_change(db, project_id, archives):
    """A recount has no run provenance: unfiling raw output must not credit lost
    parts back to free stock. Reverse the aggregate correction before refiling.
    Pending and failed work has no completed output and can still move normally.
    """
    if not any(a.project_id == project_id and a.status == "completed" for a in archives):
        return
    values = await db.scalars(
        select(ProjectLine.part_count_adjustments).where(
            ProjectLine.project_id == project_id,
            ProjectLine.part_count_adjustments.is_not(None),
        )
    )
    if any(values):
        raise HTTPException(409, "Reverse the order's recount corrections before changing completed print filing")


def apply_figures(ctx, figures):
    """A correction changes completed yield only; running/queued yield is untouched.

    Applied after archive attribution: a count must not cause the greedy hand-out
    to refill the very shortage the operator just counted from another line.
    """
    for line in ctx.lines:
        values = adjustments(line)
        if not values:
            continue
        present = {p.part_id for p in figures[line.id].parts}
        for part in ctx.parts_by_product.get(line.product_id, []):
            if part.id in values and part.id not in present:
                figures[line.id].parts.append(
                    order_metrics.PartFigures(
                        part_id=part.id,
                        name=part.name,
                        kind=part.kind,
                        per=0,
                        already_banked=ctx.banked_by_line_part.get((line.id, part.id), 0),
                    )
                )
        for pf in figures[line.id].parts:
            delta = values.get(pf.part_id, 0)
            pf.count_adjustment = delta
            pf.usable = max(0, pf.usable + delta)


async def state(db, project_id, line_id):
    ctx = await order_metrics.load_order_context(db, project_id)
    if ctx is None:
        raise HTTPException(404, "Project not found")
    line = next((ln for ln in ctx.lines if ln.id == line_id), None)
    if line is None:
        raise HTTPException(404, "Order line not found")
    figures, _ = order_metrics.attribute(ctx)
    rows = []
    # made_for_order is the printed share of receipts (the rest came from stock).
    for pf in figures[line_id].parts:
        if pf.kind != "printed":
            continue
        received = (
            ctx.made_by_line_part.get((line_id, pf.part_id), 0)
            if line.mode == "parts"
            else max(0, pf.per * (line.received or 0) - pf.stock_used_qty)
            + ctx.made_by_line_part.get((line_id, pf.part_id), 0)
        )
        protected = received + pf.already_banked
        rows.append(
            {
                "part_id": pf.part_id,
                "name": pf.name,
                "usable": pf.usable,
                "protected": protected,
                "book": max(0, pf.usable - protected),
                "adjustment": pf.count_adjustment,
            }
        )
    # A pooled print can move between sibling lines when their need changes.
    # Do not turn one ambiguous share into an authoritative physical count.
    shared = any(
        other.id != line_id
        and other.product_id == line.product_id
        and (not other.material or not line.material or other.material.upper() == line.material.upper())
        for other in ctx.lines
    ) and any(a.status == "completed" and a.project_line_id not in figures for a in ctx.archives)
    blocked = (
        "order_recount_closed"
        if ctx.project.status != "active"
        else "order_recount_shared"
        if shared
        else "order_recount_received"
        if any(p["protected"] > p["usable"] for p in rows)
        else None
    )
    basis = [
        await db.scalar(select(func.max(ProjectEvent.id)).where(ProjectEvent.project_id == project_id)),
        ctx.project.status,
        line.plan_identity,
        line.quantity,
        line.mode,
        line.material,
        line.config_key,
        getattr(line, "part_count_adjustments", None),
        rows,
        [
            (
                a.id,
                a.status,
                a.project_line_id,
                [(r.id, r.name_key, r.quantity, r.defective) for r in ctx.archive_parts_by_archive.get(a.id, [])],
            )
            for a in ctx.archives
        ],
    ]
    return {"token": digest(basis), "parts": rows, "blocked": blocked}, ctx, line


async def write(db, project_id, line_id, data, access):
    from backend.app.core.auth import authorize_api_key
    from backend.app.services import finished_stock, order_fulfilment, order_plan_access, order_working_plan
    from backend.app.services.swap_source_declarations import fresh_api_key

    user, _, scope = await order_plan_access.fresh(db, access)
    rights = ["orders:read", "orders:update", "products:read", "stock:read", "stock:adjust"]
    if scope is not None:
        raise order_plan_access.denied()
    if access.actor.kind == "api_key":
        await authorize_api_key(db, await fresh_api_key(db, access.actor), rights)
    elif user is None or not all(user.has_permission(p) for p in rights):
        raise order_plan_access.denied()
    # Same product -> order -> parts lock order as the existing stock doors.
    product_ids = list(await db.scalars(select(ProjectLine.product_id).where(ProjectLine.project_id == project_id)))
    await product_gate(db, product_ids)
    await order_fulfilment.lock_order(db, project_id)
    line = await db.get(ProjectLine, line_id, populate_existing=True)
    if line is None or line.project_id != project_id:
        raise HTTPException(404, "Order line not found")
    await finished_stock.lock_line(db, line)
    await part_stock.lock_parts(db, await part_stock.counted_parts_of(db, product_ids))
    # Refresh already-loaded line/archive state after waiting for the locks.
    db.expire_all()
    current, ctx, line = await state(db, project_id, line_id)
    user, _, scope = await order_plan_access.fresh(db, access)
    if scope is not None:
        raise order_plan_access.denied()
    if access.actor.kind == "api_key":
        await authorize_api_key(db, await fresh_api_key(db, access.actor), rights)
    elif user is None or not all(user.has_permission(p) for p in rights):
        raise order_plan_access.denied()
    if current["token"] != data.expected_token:
        raise refuse()
    working = await order_working_plan.lock(db, project_id)
    if working and working.active_operation:
        raise order_working_plan.refusal("submission_pending")
    values = adjustments(line)
    rows = {p["part_id"]: p for p in current["parts"]}
    changes = []
    for part in data.parts:
        previous = rows.get(part.part_id)
        if previous is None:
            raise refuse()
        delta = part.actual - previous["book"]
        if delta:
            values[part.part_id] = values.get(part.part_id, 0) + delta
            changes.append(
                {
                    "part_id": part.part_id,
                    "name": previous["name"],
                    "before": previous["book"],
                    "after": part.actual,
                    "delta": delta,
                }
            )
    # Even an older order that already acquired a sibling can undo its count.
    # An ambiguous pool accepts ONLY an exact reversal of every correction,
    # never an ordinary recount or a partial reversal hidden in the same write.
    if current["blocked"] and not (
        current["blocked"] == "order_recount_shared" and adjustments(line) and not any(values.values())
    ):
        raise refuse(current["blocked"])
    if changes:
        line.part_count_adjustments = {str(pid): n for pid, n in values.items() if n} or None
        await order_journal.record(
            db,
            project_id,
            "parts_recounted",
            {
                "line_id": line_id,
                "product": ctx.products_by_id[line.product_id].name,
                "parts": changes,
                "note": data.reason,
            },
            actor_id=access.actor.user_id,
        )
        await db.flush()
    return (await state(db, project_id, line_id))[0]
