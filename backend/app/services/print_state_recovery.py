"""Pure, conservative plans for addressed operator print-state recovery.

No driver, accounting, queue cleanup or completion callbacks belong here.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

OUTCOMES = {
    "completed": "completed",
    "failed": "failed",
    "cancelled": "cancelled",
    "aborted": "cancelled",
    "stopped": "cancelled",
}
ACTIONS = ("align_terminal_item", "fill_estimated_end_and_align", "release_orphan_header", "delete_stale_item")


@dataclass(frozen=True)
class RecoveryFacts:
    printer_id: int
    queue: dict
    item: dict | None
    archive: dict | None
    live: dict
    active_item_ids: tuple[int, ...]
    printing_archive_ids: tuple[int, ...]
    archive_users: int = 0
    references: tuple[str, ...] = ()
    now: datetime | None = None


def utc(value):
    if not isinstance(value, datetime):
        return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def effects_pending(archive: dict | None) -> bool:
    if archive is None:
        return False
    extra = archive.get("extra_data")
    if extra is None:
        return False
    if not isinstance(extra, dict):
        return True
    pending = extra.get("swap_macro_events_pending")
    if pending is not None and (not isinstance(pending, list) or bool(pending)):
        return True
    # This generation does not own newer completion carriers. Until its accessor
    # is integrated, seeing one is a veto, never permission to erase it.
    return any(
        key in extra
        for key in (
            "bamdude_terminal_effects",
            "swap_hold",
            "auto_eject_pending",
            "cleanup_pending",
            "completion_effects",
        )
    )


def estimated_end(f: RecoveryFacts):
    a = f.archive or {}
    start = utc(a.get("started_at"))
    duration = a.get("print_time_seconds")
    if start is None or type(duration) not in (float, int) or not math.isfinite(duration) or duration <= 0:
        return None
    try:
        result = start + timedelta(seconds=duration)
    except (OverflowError, ValueError):
        return None
    claim = utc((f.item or {}).get("started_at"))
    return result if claim and claim < result <= utc(f.now) else None


def classify(f: RecoveryFacts) -> dict | None:
    q, i, a = f.queue, f.item, f.archive
    if i is None and a and a.get("status") == "printing":
        if f.live.get("stable_inactive"):
            return {"code": "active_archive_without_current_run", "actions": [], "blocked_reasons": ["outcome_unknown"]}
        return None
    if i is not None and i.get("status") != "printing":
        return None
    if i:
        if a is None:
            code = "active_item_missing_archive"
        elif a.get("printer_id") != f.printer_id or a.get("queue_id") != q["id"]:
            code = "archive_owner_mismatch"
        elif a.get("status") in OUTCOMES:
            code = "terminal_archive_active_item"
        else:
            return None
    elif len(f.active_item_ids) > 1:
        return {"code": "multiple_active_items", "actions": [], "blocked_reasons": ["ambiguous_owner"]}
    elif q.get("status") == "printing" and not f.active_item_ids:
        code = "header_without_active_item"
    else:
        return None

    reasons = []
    mode = f.live.get("mode")
    if mode not in {"inactive", "successor"}:
        reasons.append("live_unknown")
    if f.live.get("busy"):
        reasons.append("live_busy")
    if effects_pending(a) or f.live.get("effects"):
        reasons.append("effects_pending")
    if not q.get("recovery_identity") or (i and not i.get("recovery_identity")):
        reasons.append("identity_missing")
    if i is None:
        if mode != "inactive" or f.active_item_ids or f.printing_archive_ids or f.references:
            reasons.append("ambiguous_owner")
        return {
            "code": code,
            "actions": [] if reasons else ["release_orphan_header"],
            "blocked_reasons": sorted(set(reasons)),
        }

    if not a or not a.get("recovery_identity"):
        reasons.append("execution_unproven")
    else:
        extra = a.get("extra_data")
        snapshot = i.get("source_snapshot")
        if snapshot is not None and not isinstance(snapshot, dict):
            reasons.append("execution_unproven")
        else:
            if (
                snapshot
                and "version" in snapshot
                and (type(snapshot["version"]) is not int or snapshot["version"] != 1)
            ):
                reasons.append("execution_unproven")
            provenance = (snapshot or {}).get("provenance")
            if (
                provenance is not None
                and not isinstance(provenance, dict)
                or provenance
                and (provenance.get("kind") not in {"archive", "library_file"} or type(provenance.get("id")) is not int)
            ):
                reasons.append("execution_unproven")
            elif provenance and provenance.get("kind") == "archive" and provenance.get("id") == a["id"]:
                reasons.append("source_archive")
        if (
            a.get("printer_id") != f.printer_id
            or a.get("queue_id") != q["id"]
            or i.get("queue_id") != q["id"]
            or q.get("printer_id") != f.printer_id
            or a.get("deleted_at") is not None
            or f.archive_users != 1
        ):
            reasons.append("execution_unproven")
        if extra is not None and (not isinstance(extra, dict) or extra.get("recovered_outcome_uncertain")):
            reasons.append("outcome_unknown")
        claim, start, end = utc(i.get("started_at")), utc(a.get("started_at")), utc(a.get("completed_at"))
        if not claim or not start or start < claim:
            reasons.append("invalid_run_times")
        if a.get("status") not in OUTCOMES:
            reasons.append("outcome_unknown")
        if mode == "inactive":
            if f.printing_archive_ids or q.get("current_item_id") not in (None, i["id"]):
                reasons.append("ambiguous_owner")
        elif mode == "successor":
            successor_start = utc(f.live.get("started_at"))
            if (
                not end
                or not successor_start
                or successor_start <= end
                or q.get("current_item_id") != f.live.get("item_id")
                or i["id"] == f.live.get("item_id")
            ):
                reasons.append("ambiguous_owner")
        if end and (not claim or not start or end <= max(claim, start) or end > utc(f.now)):
            reasons.append("invalid_run_times")
        if end is None and not (a.get("status") == "completed" and mode == "inactive" and estimated_end(f)):
            reasons.append("missing_run_times")

    actions = []
    if not reasons:
        if a.get("completed_at") is None:
            actions.append("fill_estimated_end_and_align")
        else:
            actions.append("align_terminal_item")
            extra = a.get("extra_data") or {}
            if a["status"] == "completed" and "operator_recovery_end" not in extra and not f.references:
                actions.append("delete_stale_item")
    if f.references:
        reasons.append("delete_has_dependencies")
    if a and isinstance(a.get("extra_data"), dict) and "operator_recovery_end" in a["extra_data"]:
        reasons.append("estimated_time")
    return {"code": code, "actions": actions, "blocked_reasons": sorted(set(reasons))}


def plan_action(f: RecoveryFacts, action: str, *, confirmed_completed=False) -> dict:
    issue = classify(f)
    if issue is None or action not in issue["actions"]:
        raise ValueError("recovery_not_allowed")
    q, i, a = f.queue, f.item, f.archive
    plan = {"item": {}, "archive": {}, "queue": {}, "delete_item": False}
    if action == "fill_estimated_end_and_align":
        if confirmed_completed is not True:
            raise ValueError("recovery_not_allowed")
        plan["archive"] = {
            "completed_at": estimated_end(f),
            "extra_data": {
                **(a.get("extra_data") or {}),
                "operator_recovery_end": {
                    "version": 1,
                    "source": "slicer_estimate",
                    "estimated_at": estimated_end(f),
                },
            },
        }
    if i:
        if action == "delete_stale_item":
            plan["delete_item"] = True
        else:
            plan["item"] = {
                "status": OUTCOMES[a["status"]],
                "completed_at": plan["archive"].get("completed_at", a.get("completed_at")),
                "waiting_reason": None,
            }
    if f.live["mode"] == "inactive" and q.get("current_item_id") in (None, (i or {}).get("id")):
        plan["queue"] = {
            "current_item_id": None,
            "status": "error" if q["status"] == "error" else "paused",
            "is_paused": True,
        }
    elif action == "release_orphan_header":
        plan["queue"] = {"current_item_id": None, "status": "paused", "is_paused": True}
    return plan
