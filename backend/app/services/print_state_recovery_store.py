"""Bounded reads and a single addressed writer for operator recovery."""

from __future__ import annotations

import base64
import json
import logging
import time
from contextlib import AsyncExitStack
from dataclasses import asdict
from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import and_, func, literal, or_, select, union_all
from sqlalchemy.exc import IntegrityError

from backend.app.core.database import Base
from backend.app.models.archive import PrintArchive
from backend.app.models.auto_queue import AutoQueueItem
from backend.app.models.calibration_session import CalibrationSession
from backend.app.models.print_completion_receipt import PrintCompletionReceipt
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.print_state_recovery_action import PrintStateRecoveryAction
from backend.app.models.printer import Printer
from backend.app.models.printer_queue import PrinterQueue
from backend.app.services import print_state_recovery_preview as previews, queue_sources
from backend.app.services.archive_write_scope import archive_write_scope, load_active_archive_for_write
from backend.app.services.print_state_recovery import RecoveryFacts, classify, plan_action, utc
from backend.app.services.queue_ops import queue_claim_scope

logger = logging.getLogger(__name__)
_observations: dict[tuple, float] = {}
_ITEM_FIELDS = (
    "id",
    "recovery_identity",
    "queue_id",
    "archive_id",
    "status",
    "started_at",
    "completed_at",
    "source_snapshot",
    "source_auto_item_id",
    "project_id",
    "project_line_id",
    "waiting_reason",
    "queue_source_id",
    "auto_eject",
    "auto_eject_settings",
    "swap_macro_events",
    "execute_swap_macros",
)
_ARCHIVE_FIELDS = (
    "id",
    "recovery_identity",
    "printer_id",
    "queue_id",
    "status",
    "started_at",
    "completed_at",
    "deleted_at",
    "print_time_seconds",
    "extra_data",
)
_QUEUE_FIELDS = ("id", "recovery_identity", "printer_id", "status", "is_paused", "current_item_id")


def project(row, fields):
    return {name: getattr(row, name, None) for name in fields} if row is not None else None


def live_snapshot(printer_id: int) -> dict:
    """Read owners, never resolve, cancel or clear them. Changes fence apply."""
    from backend.app.services.background_dispatch import background_dispatch
    from backend.app.services.print_reconciliation import _live_completions
    from backend.app.services.print_run_binding import current_print_run, finishing_print_runs
    from backend.app.services.print_scheduler import scheduler
    from backend.app.services.printer_manager import printer_manager

    state, received, stale = printer_manager.peek_status(printer_id)
    run = current_print_run(printer_manager, printer_id)
    finishing = finishing_print_runs(printer_manager, printer_id)
    resolutions = getattr(printer_manager, "_print_start_resolutions", {})
    admissions = getattr(printer_manager, "_print_start_admissions", {})
    busy = bool(
        scheduler.has_dispatch_in_flight(printer_id)
        or background_dispatch.has_work_for_printer(printer_id)
        or (isinstance(resolutions, dict) and resolutions.get(printer_id))
        or (isinstance(admissions, dict) and admissions.get(printer_id) and run is None)
    )
    effects = bool(finishing or _live_completions.get(printer_id, 0))
    fresh = bool(state and state.connected and received is not None and not stale)
    identity = (
        getattr(state, "connection_generation", None),
        getattr(state, "state", None),
        getattr(state, "subtask_id", None),
        asdict(run) if run else None,
        tuple(asdict(r) for r in finishing),
        busy,
        effects,
        repr(resolutions.get(printer_id)) if isinstance(resolutions, dict) else "unknown",
    )
    mode = "unknown"
    if fresh and not busy and not effects:
        if state.state in {"IDLE", "FINISH", "FAILED"} and run is None:
            mode = "inactive"
        elif state.state in {"RUNNING", "PAUSE"} and run and str(state.subtask_id or "") not in {"", "0"}:
            if (
                str(run.observed_subtask_id or "") == str(state.subtask_id)
                and run.client_generation == state.connection_generation
            ):
                mode = "successor"
    return {
        "mode": mode,
        "identity": identity,
        "busy": busy,
        "effects": effects,
        "item_id": run.queue_item_id if run else None,
        "archive_id": run.archive_id if run else None,
        "started_at": run.claim_started_at if run else None,
        "observed_at": received,
    }


def unknown_inbound_refs() -> bool:
    allowed = {("auto_queue_items", "assigned_to_item_id"), ("calibration_session", "print_queue_item_id")}
    for table in Base.metadata.tables.values():
        for column in table.columns:
            if any(fk.target_fullname == "print_queue.id" for fk in column.foreign_keys):
                if (table.name, column.name) not in allowed:
                    return True
    return False


async def read_facts(db, printer_ids: list[int], targets: list[tuple[int, str, int]], *, locked=False):
    """One page, fixed query count; never load terminal archive history."""
    if not printer_ids:
        return {}, {}, {}
    queues = list(
        (
            await db.scalars(
                select(PrinterQueue)
                .where(PrinterQueue.printer_id.in_(printer_ids))
                .execution_options(populate_existing=True)
            )
        ).all()
    )
    qs = {q.printer_id: q for q in queues}
    qids = [q.id for q in queues]
    target_ids = [key for _, kind, key in targets if kind == "item"]
    needed = set(target_ids) | {q.current_item_id for q in queues if q.current_item_id}
    item_stmt = select(PrintQueueItem).where(PrintQueueItem.id.in_(needed)).execution_options(populate_existing=True)
    if locked:
        item_stmt = item_stmt.order_by(PrintQueueItem.id).with_for_update()
    items = {i.id: i for i in (await db.scalars(item_stmt)).all()}
    counts = dict(
        (
            await db.execute(
                select(PrintQueueItem.queue_id, func.count())
                .where(PrintQueueItem.queue_id.in_(qids), PrintQueueItem.status == "printing")
                .group_by(PrintQueueItem.queue_id)
            )
        ).all()
    )
    aid = {i.archive_id for i in items.values() if i.archive_id}
    aid.update(key for _, kind, key in targets if kind == "archive")
    archives = {
        a.id: a
        for a in (
            await db.scalars(
                select(PrintArchive).where(PrintArchive.id.in_(aid)).execution_options(populate_existing=True)
            )
        ).all()
    }
    acounts = dict(
        (
            await db.execute(
                select(PrintArchive.printer_id, func.count())
                .where(
                    PrintArchive.printer_id.in_(printer_ids),
                    PrintArchive.status == "printing",
                    PrintArchive.deleted_at.is_(None),
                )
                .group_by(PrintArchive.printer_id)
            )
        ).all()
    )
    users = dict(
        (
            await db.execute(
                select(PrintQueueItem.archive_id, func.count())
                .where(PrintQueueItem.archive_id.in_(aid))
                .group_by(PrintQueueItem.archive_id)
            )
        ).all()
    )
    refs = {key: set() for key in needed}
    for _model, col, reason in (
        (AutoQueueItem, AutoQueueItem.assigned_to_item_id, "auto_child"),
        (CalibrationSession, CalibrationSession.print_queue_item_id, "calibration"),
        (PrintCompletionReceipt, PrintCompletionReceipt.rearmed_queue_item_id, "receipt"),
    ):
        for value in (await db.scalars(select(col).where(col.in_(needed)))).all():
            refs[value].add(reason)
    unknown_ref = unknown_inbound_refs()
    result = {}
    now = datetime.now(timezone.utc)
    for pid, kind, key in targets:
        q = qs.get(pid)
        if q is None:
            continue
        item = items.get(key) if kind == "item" else None
        if kind == "item" and (item is None or item.queue_id != q.id):
            continue
        current = items.get(q.current_item_id)
        archive = (
            archives.get(item.archive_id)
            if item
            else archives.get(key)
            if kind == "archive"
            else (archives.get(current.archive_id) if current and current.queue_id == q.id else None)
        )
        if kind == "header" and key != q.id:
            continue
        if kind == "archive" and (archive is None or archive.printer_id != pid):
            continue
        live = live_snapshot(pid)
        if live["mode"] == "successor":
            successor = archives.get(live["archive_id"])
            if (
                current is None
                or current.status != "printing"
                or current.queue_id != q.id
                or current.id != live["item_id"]
                or current.archive_id != live["archive_id"]
                or successor is None
                or successor.status != "printing"
                or successor.printer_id != pid
                or successor.queue_id != q.id
                or utc(current.started_at) != utc(live["started_at"])
                or not successor.started_at
                or utc(successor.started_at) < utc(current.started_at)
                or acounts.get(pid, 0) != 1
            ):
                live = {**live, "mode": "unknown"}
        active = tuple(i.id for i in items.values() if i.queue_id == q.id and i.status == "printing")
        if counts.get(q.id, 0) > len(active):
            active += (-1,)
        references = set(refs.get(key, ())) if item else set()
        if item:
            if item.source_auto_item_id:
                references.add("auto_parent")
            if item.project_id or item.project_line_id:
                references.add("project")
            if unknown_ref:
                references.add("unknown_fk")
        elif current is not None and (current.queue_id != q.id or current.status == "printing"):
            references.add("ambiguous_owner")
        if kind == "archive" and live["mode"] == "inactive":
            stamp = (
                pid,
                archive.recovery_identity if archive else key,
                previews.digest(live["identity"]),
                queue_sources.current_epoch(),
            )
            mono = time.monotonic()
            for old in list(_observations):
                if mono - _observations[old] > 300:
                    _observations.pop(old, None)
            if len(_observations) >= 1000:
                _observations.pop(next(iter(_observations)))
            seen = _observations.setdefault(stamp, mono)
            live = {**live, "stable_inactive": mono - seen >= 10}
        result[(pid, kind, key)] = RecoveryFacts(
            pid,
            project(q, _QUEUE_FIELDS),
            project(item, _ITEM_FIELDS),
            project(archive, _ARCHIVE_FIELDS),
            live,
            active,
            (-1,) if acounts.get(pid, 0) else (),
            users.get(item.archive_id, 0) if item else 0,
            tuple(sorted(references)),
            now,
        )
    return result, qs, (items, archives)


def revision(f: RecoveryFacts) -> str:
    data = asdict(f)
    data.pop("now")
    data["live"].pop("observed_at", None)
    return previews.digest(data)


def public_issue(key, f):
    issue = classify(f)
    if issue is None:
        return None
    visible_archive = f.archive if f.archive and f.archive.get("printer_id") == f.printer_id else None
    return {
        **issue,
        "printer_id": f.printer_id,
        "queue_id": f.queue["id"],
        "kind": key[1],
        "target_id": key[2],
        "item_id": f.item["id"] if f.item else None,
        "archive_id": visible_archive["id"] if visible_archive else None,
        "observed_at": f.live.get("observed_at"),
        "live_mode": f.live["mode"],
        "started_at": (visible_archive or {}).get("started_at"),
        "completed_at": (visible_archive or {}).get("completed_at"),
    }


def encode_cursor(row):
    return base64.urlsafe_b64encode(previews.canonical(list(row))).decode()


def decode_cursor(value):
    try:
        if len(value) > 160:
            raise ValueError
        row = json.loads(base64.urlsafe_b64decode(value))
        if (
            not isinstance(row, list)
            or len(row) != 3
            or type(row[0]) is not int
            or row[1] not in {"header", "item", "archive"}
            or type(row[2]) is not int
        ):
            raise ValueError
        return row
    except (ValueError, TypeError):
        raise ValueError("invalid_cursor") from None


async def list_issues(db, scope, *, printer_id=None, cursor=None):
    after = decode_cursor(cursor) if cursor else None
    stmt = select(Printer.id, Printer.name).order_by(Printer.id)
    if scope is not None:
        stmt = stmt.where(Printer.id.in_(scope))
    if printer_id is not None:
        stmt = stmt.where(Printer.id == printer_id)
    if after:
        stmt = stmt.where(Printer.id >= after[0])
    printers = (await db.execute(stmt.limit(21))).all()
    page = printers[:20]
    pids = [p.id for p in page]
    names = {p.id: p.name for p in page}
    headers = select(
        PrinterQueue.printer_id.label("pid"), literal("header").label("kind"), PrinterQueue.id.label("target")
    ).where(
        PrinterQueue.printer_id.in_(pids),
        or_(
            PrinterQueue.status == "printing",
            PrinterQueue.id.in_(
                select(PrintQueueItem.queue_id)
                .where(PrintQueueItem.status == "printing")
                .group_by(PrintQueueItem.queue_id)
                .having(func.count() > 1)
            ),
        ),
    )
    items = (
        select(PrinterQueue.printer_id, literal("item"), PrintQueueItem.id)
        .join(PrintQueueItem, PrintQueueItem.queue_id == PrinterQueue.id)
        .where(PrinterQueue.printer_id.in_(pids), PrintQueueItem.status == "printing")
    )
    archives = select(PrintArchive.printer_id, literal("archive"), PrintArchive.id).where(
        PrintArchive.printer_id.in_(pids), PrintArchive.status == "printing", PrintArchive.deleted_at.is_(None)
    )
    candidates = union_all(headers, items, archives).subquery()
    query = select(candidates).order_by(candidates.c.pid, candidates.c.kind, candidates.c.target)
    if after:
        pid, kind, target = after
        query = query.where(
            or_(
                candidates.c.pid > pid,
                and_(candidates.c.pid == pid, candidates.c.kind > kind),
                and_(candidates.c.pid == pid, candidates.c.kind == kind, candidates.c.target > target),
            )
        )
    rows = (await db.execute(query.limit(101))).all()
    targets = [tuple(row) for row in rows[:100]]
    facts, _, _ = await read_facts(db, pids, targets)
    issues = []
    for key, f in facts.items():
        issue = public_issue(key, f)
        if issue:
            issues.append({**issue, "printer_name": names[key[0]]})
    next_cursor = (
        encode_cursor(rows[99])
        if len(rows) > 100
        else (encode_cursor((printers[20].id, "archive", -1)) if len(printers) > 20 else None)
    )
    return {
        "issues": issues,
        "next_cursor": next_cursor,
        "truncated": next_cursor is not None,
        "checked_at": datetime.now(timezone.utc),
    }


async def make_preview(db, printer_id, kind, target_id, action, actor, *, confirmed_completed=False, note=""):
    key = (printer_id, kind, target_id)
    facts, _, _ = await read_facts(db, [printer_id], [key])
    f = facts.get(key)
    if f is None:
        raise LookupError
    plan = plan_action(f, action, confirmed_completed=confirmed_completed)
    nonce = str(uuid4())
    body = {
        "version": 1,
        "nonce": nonce,
        "actor": actor,
        "printer_id": printer_id,
        "kind": kind,
        "target_id": target_id,
        "action": action,
        "confirmed_completed": confirmed_completed,
        "note": note,
        "revision": revision(f),
        "epoch": queue_sources.current_epoch(),
        "plan_hash": previews.digest(plan),
    }
    return {
        "preview_token": previews.sign(body),
        "action": action,
        "before": {
            "queue": f.queue,
            "item": {
                **{k: v for k, v in (f.item or {}).items() if k in {"id", "status", "completed_at"}},
                "waiting_reason": True if (f.item or {}).get("waiting_reason") else None,
            },
            "archive": {k: v for k, v in (f.archive or {}).items() if k in {"id", "status", "completed_at"}},
        },
        "after": public_plan(plan),
        "estimate": {
            "started_at": f.archive["started_at"],
            "duration_seconds": f.archive["print_time_seconds"],
            "completed_at": plan["archive"]["completed_at"],
        }
        if plan["archive"]
        else None,
        "archive_preserved": True,
        "expires_in": previews.TTL,
    }


def public_plan(plan):
    """Only the changed time/provenance may leave the server, never historical extra_data."""
    if not plan["archive"]:
        return plan
    archive = plan["archive"]
    return {**plan, "archive": {"completed_at": archive["completed_at"], "time_source": "slicer_estimate"}}


async def apply_preview(session_factory, payload, actor, actor_label, *, recheck=None):
    if payload.get("actor") != actor or payload.get("epoch") != queue_sources.current_epoch():
        raise ValueError("recovery_changed")
    key = (payload["printer_id"], payload["kind"], payload["target_id"])
    nonce = payload["nonce"]
    input_hash = previews.digest(payload)
    async with queue_sources.storage_mutation():
        if recheck:
            await recheck(payload["action"])
        async with session_factory() as preflight:
            prior = await preflight.get(PrintStateRecoveryAction, nonce)
            if prior:
                if prior.actor != actor or prior.input_hash != input_hash:
                    raise ValueError("recovery_changed")
                return prior.result
            facts, _, _ = await read_facts(preflight, [key[0]], [key])
            f = facts.get(key)
            if f is None:
                raise ValueError("recovery_changed")
            queue_id = f.queue["id"]
            archive_id = f.archive["id"] if f.archive else None
        async with session_factory() as db, AsyncExitStack() as guards:
            if archive_id is not None:
                await guards.enter_async_context(archive_write_scope(db, archive_id))
                await load_active_archive_for_write(db, archive_id)
            await guards.enter_async_context(queue_claim_scope(db, queue_id))
            await db.scalar(select(PrinterQueue).where(PrinterQueue.id == queue_id).with_for_update())
            prior = await db.get(PrintStateRecoveryAction, nonce, populate_existing=True)
            if prior:
                if prior.actor == actor and prior.input_hash == input_hash:
                    return prior.result
                raise ValueError("recovery_changed")
            facts, queues, (items, archives) = await read_facts(db, [key[0]], [key], locked=True)
            f = facts.get(key)
            if f is None or revision(f) != payload["revision"] or queue_sources.current_epoch() != payload["epoch"]:
                raise ValueError("recovery_changed")
            plan = plan_action(f, payload["action"], confirmed_completed=payload["confirmed_completed"])
            if previews.digest(plan) != payload["plan_hash"]:
                raise ValueError("recovery_changed")
            if recheck:
                await recheck(payload["action"])
            if previews.clock() > payload["expires"]:
                raise ValueError("recovery_preview_expired")
            # Explicit allowlists, no setattr loop over client fields.
            item = items.get(f.item["id"]) if f.item else None
            archive = archives.get(archive_id)
            if plan["archive"]:
                archive.completed_at = plan["archive"]["completed_at"]
                extra = plan["archive"]["extra_data"]
                extra["operator_recovery_end"]["action_id"] = nonce
                archive.extra_data = json.loads(previews.canonical(extra))
            if plan["item"]:
                item.status = plan["item"]["status"]
                item.completed_at = plan["item"]["completed_at"]
                item.waiting_reason = None
            if plan["delete_item"]:
                await db.delete(item)
            if plan["queue"]:
                q = queues[key[0]]
                q.current_item_id = None
                q.status = plan["queue"]["status"]
                q.is_paused = True
            result = json.loads(
                previews.canonical(
                    {
                        "id": nonce,
                        "action": payload["action"],
                        "printer_id": key[0],
                        "queue_id": queue_id,
                        "item_id": f.item["id"] if f.item else None,
                        "archive_id": archive_id,
                        "identities": {
                            "queue": f.queue["recovery_identity"],
                            "item": (f.item or {}).get("recovery_identity"),
                            "archive": (f.archive or {}).get("recovery_identity"),
                        },
                        "before": {
                            "item_status": (f.item or {}).get("status"),
                            "completed_at": (f.archive or {}).get("completed_at"),
                            "queue": f.queue,
                        },
                        "after": public_plan(plan),
                        "note": payload["note"],
                        "reason_codes": classify(f)["blocked_reasons"],
                        "archive_preserved": True,
                        "estimate": {
                            "started_at": (f.archive or {}).get("started_at"),
                            "duration": (f.archive or {}).get("print_time_seconds"),
                        }
                        if plan["archive"]
                        else None,
                    }
                )
            )
            db.add(
                PrintStateRecoveryAction(
                    id=nonce,
                    actor=actor,
                    actor_label=actor_label,
                    printer_id=key[0],
                    queue_id=queue_id,
                    item_id=f.item["id"] if f.item else None,
                    archive_id=archive_id,
                    action=payload["action"],
                    input_hash=input_hash,
                    result=result,
                )
            )
            try:
                await db.flush()
                # Observe again after DB awaits, including waits on a contended FK.
                latest = live_snapshot(key[0])
                if (
                    previews.digest(latest["identity"]) != previews.digest(f.live["identity"])
                    or latest["mode"] != f.live["mode"]
                    or queue_sources.current_epoch() != payload["epoch"]
                ):
                    raise ValueError("recovery_changed")
                await db.commit()
            except IntegrityError:
                await db.rollback()
                async with session_factory() as retry:
                    prior = await retry.get(PrintStateRecoveryAction, nonce)
                    if prior and prior.actor == actor and prior.input_hash == input_hash:
                        return prior.result
                raise ValueError("recovery_changed") from None
    logger.info("operator print-state recovery action=%s printer=%s target=%s outcome=applied", nonce, key[0], key[2])
    from backend.app.core.websocket import ws_manager

    try:
        await ws_manager.broadcast({"type": "queue_changed", "printer_id": key[0]})
        if plan["archive"]:
            await ws_manager.send_archive_updated({"id": archive_id})
    except Exception:
        logger.warning("operator recovery committed; event delivery failed action=%s", nonce)
    return result
