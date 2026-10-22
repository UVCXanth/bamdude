"""Execute the real nested usage callback without starting the farm lifespan."""

import ast
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from backend.app.models.print_usage_event import PrintUsageEvent
from backend.app.services.print_usage_journal import load_events
from backend.tests.unit.services.test_print_usage_journal import _make_archive, printer  # noqa: F401


def callback(db, sent):
    @asynccontextmanager
    async def session():
        yield db

    tree = ast.parse(Path("backend/app/main.py").read_text(encoding="utf8"))
    node = next(n for n in ast.walk(tree) if isinstance(n, ast.AsyncFunctionDef) and n.name == "on_usage_event")
    namespace = {
        "async_session": session,
        "logging": logging,
        "__name__": __name__,
        "notification_service": SimpleNamespace(on_filament_runout=sent),
        "printer_manager": SimpleNamespace(get_printer=lambda _id: SimpleNamespace(name="Synthetic")),
    }
    exec(compile(ast.Module(body=[node], type_ignores=[]), "backend/app/main.py", "exec"), namespace)
    return namespace["on_usage_event"]


@pytest.mark.asyncio
async def test_usage_callback_notifies_new_and_upgrade_but_not_duplicate_fold_or_weaker_replay(
    db_session, printer, monkeypatch
):
    archive = await _make_archive(db_session, printer)
    monkeypatch.setattr("backend.app.services.print_usage_journal._slot_occupied_now", lambda *_: None)
    sent = AsyncMock()
    apply = callback(db_session, sent)
    for kind, tray in [("pause", 0), ("pause", 0), ("pause", None), ("autoswitch", 0), ("pause", 0)]:
        await apply(printer.id, "runout", kind, tray, 38)
    assert [call.kwargs["kind"] for call in sent.await_args_list] == ["pause", "autoswitch"]
    events = await load_events(db_session, printer.id, archive.id)
    assert len(events) == 1 and events[0].kind == "autoswitch"


@pytest.mark.asyncio
async def test_usage_callback_never_notifies_a_refill_repeat_after_assignment_disappeared(
    db_session, printer, monkeypatch
):
    archive = await _make_archive(db_session, printer)
    for event, kind, tray, spool, layer in [
        ("runout", "autoswitch", 0, 300, 35),
        ("tray_change", None, 1, 306, 35),
        ("spool_loaded", None, 0, 309, 37),
    ]:
        db_session.add(
            PrintUsageEvent(
                printer_id=printer.id,
                archive_id=archive.id,
                layer_num=layer,
                event=event,
                kind=kind,
                global_tray_id=tray,
                spool_id=spool,
                slot_occupied=event != "runout",
            )
        )
    await db_session.commit()
    monkeypatch.setattr("backend.app.services.print_usage_journal._slot_occupied_now", lambda *_: True)
    sent = AsyncMock()
    await callback(db_session, sent)(printer.id, "runout", "autoswitch", 0, 38)
    sent.assert_not_awaited()
    assert len(await load_events(db_session, printer.id, archive.id)) == 3
