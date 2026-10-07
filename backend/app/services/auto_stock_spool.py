"""Opt-in stock selection on a witnessed AMS insertion; existing journal/publisher own the rest.

No scheduler or second usage book. SQL row locks arbitrate stock claims on
PostgreSQL; the existing SQLite write-lock helper serialises read/choose/write.
"""

import logging
from datetime import datetime, timezone

from pydantic import ValidationError
from sqlalchemy import func, select

from backend.app.core.database import take_write_lock
from backend.app.models.printer import Printer
from backend.app.models.spool import Spool
from backend.app.models.spool_assignment import SpoolAssignment
from backend.app.schemas.auto_stock_spool import AutoStockSpoolPolicy, StockSpoolGroup
from backend.app.services.ams_slot_presence import spool_present
from backend.app.services.spool_tag_matcher import is_valid_tag

logger = logging.getLogger(__name__)
NAMESPACE = "auto_stock_spool"


def policy_for(printer) -> AutoStockSpoolPolicy:
    raw = getattr(printer, "ams_policies", None)
    try:
        return AutoStockSpoolPolicy.model_validate(raw.get(NAMESPACE, {}) if isinstance(raw, dict) else {})
    except ValidationError:
        return AutoStockSpoolPolicy()  # unreadable persisted policy never admits a claim


def available_filters():
    return [
        Spool.archived_at.is_(None),
        # The ordinary internal create/bulk-create API leaves this optional
        # historical marker NULL. Full stock is still represented by zero
        # actual consumption and no use history below; an explicit False
        # continues to exclude a spool entered as partial.
        Spool.added_full.is_not(False),
        Spool.weight_used == 0,
        Spool.label_weight > 0,
        Spool.filament_diameter == "1.75",
        func.coalesce(Spool.extra_colors, "") == "",
        Spool.last_used.is_(None),
        func.coalesce(Spool.tag_uid, "").in_(["", "0000000000000000"]),
        func.coalesce(Spool.tray_uuid, "").in_(["", "00000000000000000000000000000000"]),
        ~select(SpoolAssignment.id).where(SpoolAssignment.spool_id == Spool.id).exists(),
    ]


def group_columns():
    return {
        "material": Spool.material,
        "rgba": func.upper(Spool.rgba),
        "brand": func.coalesce(Spool.brand, ""),
        "subtype": func.coalesce(Spool.subtype, ""),
        "filament_family_id": func.coalesce(Spool.filament_family_id, ""),
        "label_weight": Spool.label_weight,
    }


async def available_groups(db):
    columns = group_columns()
    rows = (
        await db.execute(
            select(*(c.label(k) for k, c in columns.items()), func.count().label("available_count"))
            .where(*available_filters(), Spool.rgba.is_not(None))
            .group_by(*columns.values())
            .order_by(columns["material"], columns["brand"])
        )
    ).mappings()
    groups = []
    for row in rows:
        try:
            StockSpoolGroup.model_validate(dict(row))
        except ValidationError:
            continue
        groups.append(dict(row))
    return groups


async def claim_on_insertion(db, *, printer_id: int, event: dict, manager) -> dict:
    """One already-deduplicated, locally witnessed insertion; commit with its journal boundary.

    An existing assignment wins unless THIS slot has an open, unambiguous
    runout of THAT spool. Colour/profile matching for dispatch is deliberately
    not consulted: ignoring a colour in a job is not permission to choose a
    different physical stock group.
    """
    from backend.app.api.routes.inventory import _find_tray_in_ams_data
    from backend.app.api.routes.settings import get_setting
    from backend.app.models.print_usage_event import EVENT_RUNOUT, EVENT_SPOOL_LOADED, KIND_AUTOSWITCH, KIND_PAUSE
    from backend.app.services.print_usage_journal import active_archive_id, load_events, note_assignment_change

    ams_id, tray_id = event["ams_id"], event["tray_id"]
    state = manager.get_status(printer_id)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    if (
        not state
        or not state.connected
        or state.connection_generation != event["generation"]
        or not 0 <= (now - event["observed_at"]).total_seconds() <= 30
    ):
        return {"reason": "stale_insertion"}
    tray = _find_tray_in_ams_data(state.raw_data.get("ams", []), ams_id, tray_id)
    if ams_id >= 254 or spool_present(tray) is not True:
        return {"reason": "presence_unknown"}
    if is_valid_tag(tray.get("tag_uid"), tray.get("tray_uuid")):
        return {"reason": "rfid_priority"}
    await take_write_lock(db, Printer.__table__, printer_id)
    printer = (await db.execute(select(Printer).where(Printer.id == printer_id).with_for_update())).scalar_one_or_none()
    policy = policy_for(printer)
    if not printer or printer.archived or not printer.is_active or not policy.enabled:
        return {"reason": "policy_off"}
    if (await get_setting(db, "spoolman_enabled") or "").lower() == "true":
        return {"reason": "spoolman_enabled"}
    existing = (
        await db.execute(
            select(SpoolAssignment).where(
                SpoolAssignment.printer_id == printer_id,
                SpoolAssignment.ams_id == ams_id,
                SpoolAssignment.tray_id == tray_id,
            )
        )
    ).scalar_one_or_none()
    if existing:
        # A deliberate pre-assignment or a manual answer after this signal wins.
        if not existing.fingerprint_type or existing.created_at > event["observed_at"]:
            return {"reason": "assignment_priority"}
        archive_id = await active_archive_id(db, printer_id)
        events = await load_events(db, printer_id, archive_id) if archive_id else []
        global_tray = ams_id if ams_id >= 128 else ams_id * 4 + tray_id
        last = next(
            (
                e
                for e in reversed(events)
                if e.global_tray_id == global_tray and e.event in (EVENT_RUNOUT, EVENT_SPOOL_LOADED)
            ),
            None,
        )
        if (
            not last
            or last.event != EVENT_RUNOUT
            or last.kind not in (KIND_PAUSE, KIND_AUTOSWITCH)
            or last.spool_id != existing.spool_id
        ):
            return {"reason": "assignment_priority"}
    columns = group_columns()
    group = policy.group.model_dump()
    spool = (
        await db.execute(
            select(Spool)
            .where(*available_filters(), *(columns[k] == v for k, v in group.items()))
            .order_by(Spool.created_at, Spool.id)
            .limit(1)
            .with_for_update(skip_locked=True)
        )
    ).scalar_one_or_none()
    if spool is None:
        return {"reason": "no_full_stock"}
    # Recheck the live connection immediately before writing; a reconnect while
    # waiting for SQL must not turn its old insertion into a new assignment.
    state = manager.get_status(printer_id)
    if (
        not state
        or not state.connected
        or state.connection_generation != event["generation"]
        or not 0 <= (datetime.now(timezone.utc).replace(tzinfo=None) - event["observed_at"]).total_seconds() <= 30
    ):
        return {"reason": "stale_insertion"}
    tray = _find_tray_in_ams_data(state.raw_data.get("ams", []), ams_id, tray_id)
    if spool_present(tray) is not True:
        return {"reason": "presence_unknown"}
    if is_valid_tag(tray.get("tag_uid"), tray.get("tray_uuid")):
        return {"reason": "rfid_priority"}
    if existing:
        await db.delete(existing)
        await db.flush()
    assignment = SpoolAssignment(
        spool_id=spool.id,
        printer_id=printer_id,
        ams_id=ams_id,
        tray_id=tray_id,
        fingerprint_color=tray.get("tray_color", ""),
        fingerprint_type=tray.get("tray_type") or spool.material,
        created_at=now,
    )
    db.add(assignment)
    await db.flush()
    # The existing journal's writer commits the replacement and its boundary
    # together when a runout exists. Failure is NOT swallowed on this auto path.
    await note_assignment_change(
        db,
        printer_id=printer_id,
        ams_id=ams_id,
        tray_id=tray_id,
        spool_id=spool.id,
        layer_num=getattr(state, "layer_num", 0),
    )
    await db.commit()
    logger.info("Stock insertion: assigned spool %s to printer %s AMS%s-T%s", spool.id, printer_id, ams_id, tray_id)
    return {"reason": "assigned", "spool_id": spool.id}
