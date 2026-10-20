"""Durable, addressed consumption at the existing queue publication commit."""

from copy import deepcopy
from dataclasses import dataclass

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from backend.app.models.order_working_plan import OrderPlanReceipt, OrderPlanSubmission
from backend.app.models.printer import Printer
from backend.app.schemas.order_auto_eject import AutoEjectSettings
from backend.app.schemas.order_print_options import OrderPrintOptions
from backend.app.services import order_draft, order_plan_access as authority, order_working_plan as working
from backend.app.services.order_print_options import override_options
from backend.app.services.print_option_defaults import preference_options
from backend.app.utils.model_compatibility import model_compatibility


@dataclass(frozen=True)
class PlanConsumption:
    plan_id: int
    operation_id: str
    entry_id: str
    access: authority.PlanAccess


@dataclass
class ConsumptionTicket:
    plan: object
    operation: OrderPlanSubmission
    part: dict


class AlreadyPublished(Exception):
    """The staged duplicate must roll back; its first receipt is authoritative."""

    def __init__(self, outcome):
        self.outcome = outcome


def target_scope(entry, printers):
    target = entry.get("target", {"kind": "auto"})
    if printers is not None and (target["kind"] == "auto" or target.get("printer_id") not in printers):
        raise HTTPException(403, {"code": "plan_printer_scope"})


async def _operation(db, plan_id, operation_id, *, lock=False):
    query = select(OrderPlanSubmission).where(OrderPlanSubmission.id == operation_id)
    if lock:
        query = query.with_for_update()
    operation = await db.scalar(query.execution_options(populate_existing=True))
    if operation is None or operation.plan_id != plan_id:
        raise HTTPException(404, "Submission not found")
    return operation


async def _out(db, operation):
    receipts = list(
        (await db.scalars(select(OrderPlanReceipt).where(OrderPlanReceipt.operation_id == operation.id))).all()
    )
    done = {r.entry_id for r in receipts}
    return {
        "operation_id": operation.id,
        "status": operation.status,
        "created": [deepcopy(r.outcome) for r in receipts],
        "remaining": [
            {"entry_id": p["entry"]["entry_id"], "count": p["count"]}
            for p in operation.request["parts"]
            if p["entry"]["entry_id"] not in done
        ],
    }


async def read(db, plan_id, operation_id, access):
    _, _, printers = await authority.fresh(db, access, edit=False, receipts=True)
    operation = await _operation(db, plan_id, operation_id)
    if operation.actor != access.identity:
        raise working.refusal("operation_actor_changed")
    for part in operation.request["parts"]:
        target_scope(part["entry"], printers)
    return await _out(db, operation)


async def register(db, plan_id, request, access):
    plan = await working.lock(db, plan_id)
    if plan is None:
        raise working.refusal()
    user, scope, printers = await authority.fresh(db, access, execute=True, receipts=True)
    digest = order_draft.digest(
        [plan_id, request.expected_revision, sorted((p.entry_id, p.count) for p in request.parts)]
    )
    previous = await db.get(OrderPlanSubmission, request.operation_id, populate_existing=True)
    if previous is not None:
        if previous.plan_id != plan_id or previous.actor != access.identity or previous.request_digest != digest:
            raise working.refusal("operation_conflict")
        for part in previous.request["parts"]:
            target_scope(part["entry"], printers)
        return await _out(db, previous)
    working.check(plan, request.expected_revision)
    data = await order_draft.inputs(db, plan_id)
    if data.ctx.project.status != "active":
        raise working.refusal("order_closed")
    entries = {e["entry_id"]: e for e in plan.entries}
    parts = []
    overrides = OrderPrintOptions(overrides=data.ctx.project.order_print_options or {}).model_dump()["overrides"]
    for requested in request.parts:
        entry = entries.get(requested.entry_id)
        if entry is None or requested.count > entry["count"]:
            raise working.refusal("entry_changed")
        target_scope(entry, printers)

        def visible(file):
            return authority.visible(file, user, scope)

        exact, _, issues = working.projection(data, [entry], plan.facts, visible=visible)
        if issues:
            raise working.refusal("source_review_required")
        selected = next(row for line in exact.lines for row in line.rows)
        printer = (
            await db.get(Printer, entry["target"]["printer_id"], populate_existing=True)
            if entry["target"]["kind"] == "printer"
            else None
        )
        if entry["target"]["kind"] == "printer" and (printer is None or printer.archived):
            raise working.refusal("target_unavailable")
        model = printer.model if printer else selected.printer_model
        if printer and model_compatibility(selected.printer_model, model) == "incompatible":
            raise working.refusal("target_incompatible")
        profile = await preference_options(db, user, model)
        options = profile.for_printer_queue() if profile and printer else profile.for_auto_queue() if profile else {}
        try:
            options.update(override_options(overrides, selected.printer_model, model if printer else None))
        except ValueError as exc:
            raise HTTPException(422, "Order print options do not fit the target printer") from exc
        file = next(
            file
            for candidates in data.recipes.values()
            for plate, file, _ in candidates
            if plate.id == entry["plate_id"]
        )
        parts.append(
            {
                "entry": deepcopy(entry),
                "count": requested.count,
                "expected_hash": file.file_hash,
                "frozen_options": {"options": options, "order_overrides": overrides},
                "auto_eject": {
                    "enabled": bool(data.ctx.project.auto_eject_enabled),
                    "settings": AutoEjectSettings.model_validate(
                        data.ctx.project.auto_eject_settings or {}
                    ).model_dump(),
                },
            }
        )
    operation = OrderPlanSubmission(
        id=request.operation_id,
        plan_id=plan_id,
        actor=access.identity,
        request_digest=digest,
        request={"schema_version": 1, "parts": parts},
    )
    db.add(operation)
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise working.refusal("operation_conflict") from exc
    plan.active_operation = operation.id
    await db.flush()
    return await _out(db, operation)


async def claim(db, context: PlanConsumption, sha256: str):
    """Called after the publisher's existing source/lane guards, before rows."""
    from backend.app.models.project import Project
    from backend.app.models.project_line import ProjectLine

    # Queue inserts take these FK key-share locks anyway. Acquire them BEFORE
    # draft: stock/lifecycle writers can already hold a line FOR UPDATE and
    # later fence its draft. Taking the implicit FK lock after draft reverses
    # that order. NO KEY UPDATE on the order remains compatible with key share.
    before = await _operation(db, context.plan_id, context.operation_id)
    intended = next((p for p in before.request["parts"] if p["entry"]["entry_id"] == context.entry_id), None)
    if intended is None:
        raise working.refusal("entry_changed")
    await db.execute(select(Project.id).where(Project.id == context.plan_id).with_for_update(read=True, key_share=True))
    line = await db.scalar(
        select(ProjectLine.id)
        .where(ProjectLine.id == intended["entry"]["line_id"], ProjectLine.project_id == context.plan_id)
        .with_for_update(read=True, key_share=True)
    )
    if line is None:
        raise working.refusal("line_unavailable")
    plan = await working.lock(db, context.plan_id)
    operation = await _operation(db, context.plan_id, context.operation_id, lock=True)
    user, scope, printers = await authority.fresh(db, context.access, execute=True)
    if operation.actor != context.access.identity:
        raise working.refusal("operation_actor_changed")
    part = next((p for p in operation.request["parts"] if p["entry"]["entry_id"] == context.entry_id), None)
    if part is None:
        raise working.refusal("entry_changed")
    target_scope(part["entry"], printers)
    previous = await db.get(OrderPlanReceipt, f"{operation.id}:{context.entry_id}")
    if previous:
        raise AlreadyPublished(deepcopy(previous.outcome))
    if plan is None or plan.active_operation != operation.id or operation.status != "pending":
        raise working.refusal("submission_cancelled")
    entry = next((e for e in plan.entries if e["entry_id"] == context.entry_id), None)
    if (
        entry is None
        or entry["count"] < part["count"]
        or entry.get("source_token") != part["entry"].get("source_token")
    ):
        raise working.refusal("entry_changed")
    data = await order_draft.inputs(db, context.plan_id)
    if data.ctx.project.status != "active":
        raise working.refusal("order_closed")
    exact, _, issues = working.projection(
        data, [entry], plan.facts, visible=lambda file: authority.visible(file, user, scope)
    )
    if issues or part["expected_hash"] and part["expected_hash"] != sha256:
        raise working.refusal("source_changed")
    if entry["target"]["kind"] == "printer":
        printer = await db.get(Printer, entry["target"]["printer_id"], populate_existing=True)
        selected = next(row for line in exact.lines for row in line.rows)
        if (
            printer is None
            or printer.archived
            or model_compatibility(selected.printer_model, printer.model) == "incompatible"
        ):
            raise working.refusal("target_unavailable")
    return ConsumptionTicket(plan, operation, part)


async def consume(db, ticket: ConsumptionTicket, queue_ids, kind):
    """Same transaction as queue rows; no HTTP result is a consumption proof."""
    plan, operation, part = ticket.plan, ticket.operation, ticket.part
    if len(queue_ids) != part["count"]:
        raise working.refusal("publication_count_changed")
    entry = part["entry"]
    outcome = {
        "entry_id": entry["entry_id"],
        "line_id": entry["line_id"],
        "plate_id": entry["plate_id"],
        "count": part["count"],
        "queue_kind": kind,
        "queue_item_ids": list(queue_ids),
    }
    db.add(
        OrderPlanReceipt(
            id=f"{operation.id}:{entry['entry_id']}",
            operation_id=operation.id,
            entry_id=entry["entry_id"],
            count=part["count"],
            outcome=outcome,
        )
    )
    remaining = deepcopy(plan.entries)
    current = next(e for e in remaining if e["entry_id"] == entry["entry_id"])
    current["count"] -= part["count"]
    current["protected_count"] = max(0, current.get("protected_count", 0) - part["count"])
    if current["count"] > 0 and current["protected_count"] == 0:
        current["manual"] = False
    if current["count"] == 0:
        remaining.remove(current)
    plan.entries = remaining
    plan.revision += 1
    if not operation.epoch_advanced:
        plan.epoch += 1
        operation.epoch_advanced = True
    await db.flush()
    receipts = set(
        (await db.scalars(select(OrderPlanReceipt.entry_id).where(OrderPlanReceipt.operation_id == operation.id))).all()
    )
    if len(receipts) == len(operation.request["parts"]):
        operation.status = "complete"
        plan.active_operation = None
    await db.flush()


async def cancel(db, plan_id, operation_id, access):
    plan = await working.lock(db, plan_id)
    _, _, printers = await authority.fresh(db, access, receipts=True)
    operation = await _operation(db, plan_id, operation_id, lock=True)
    if operation.actor != access.identity:
        raise working.refusal("operation_actor_changed")
    for part in operation.request["parts"]:
        target_scope(part["entry"], printers)
    if operation.status == "pending":
        operation.status = "cancelled"
        if plan and plan.active_operation == operation.id:
            plan.active_operation = None
            plan.revision += 1
    await db.flush()
    return await _out(db, operation)


async def fence(db, plan_id):
    """Closing an order fences pending capture, without changing existing queues."""
    plan = await working.lock(db, plan_id)
    if plan and plan.active_operation:
        operation = await _operation(db, plan_id, plan.active_operation, lock=True)
        operation.status = "cancelled"
        plan.active_operation = None
        plan.revision += 1
        await db.flush()


async def execute(db, plan_id, operation_id, access, publish):
    # An explicit continuation is required after reconnect/restart. Never hold
    # a draft transaction while the existing writer captures source bytes.
    state = await read(db, plan_id, operation_id, access)
    if state["status"] != "pending":
        return state
    operation = await _operation(db, plan_id, operation_id)
    parts = deepcopy(operation.request["parts"])
    done = {r["entry_id"] for r in state["created"]}
    user, _, _ = await authority.fresh(db, access, execute=True, receipts=True)
    from backend.app.models.user import User

    actor = User(id=user.id, username=user.username) if user else None
    await db.rollback()
    for part in parts:
        entry = part["entry"]
        if entry["entry_id"] in done:
            continue
        context = PlanConsumption(plan_id, operation_id, entry["entry_id"], access)
        try:
            await publish(part, context, actor)
            await db.commit()
        except AlreadyPublished:
            await db.rollback()
        except Exception:
            await db.rollback()
            # Receipts, not a transport response, describe partial success.
            state = await read(db, plan_id, operation_id, access)
            if state["status"] == "pending":
                state["error"] = "publication_failed"
            return state
    return await read(db, plan_id, operation_id, access)
