"""A source's swap declaration from the door it came in by to the plate it leaves (swap-source-lifecycle plan T7/T8).

Every seam is pinned on its own elsewhere; these walk the joined chain once with the real doors, the real
capture, the real scheduler and dispatcher, and the real completion -- on their own file database, with one
printer manager for dispatch and completion, so the run the dispatcher binds is the run the completion accepts:

* a file that declares its own sequence (by its name, at upload) is captured True, keeps it after its library
  row and file are gone, is dispatched without our swap macros, clears the plate at completion, and its
  reprint from the archive is True again;
* a plain file renamed to look like a swap file stays False through a copy of its job, gets our swap start at
  dispatch and our change_table at completion.

Hardware is replaced (the MQTT client, the macro executor); no farm is reached.
"""

from __future__ import annotations

import asyncio
import os
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from backend.app import main
from backend.app.core.config import settings
from backend.app.core.database import Base
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.models.printer_queue import PrinterQueue
from backend.app.schemas.print_queue import PrintQueueItemCreate
from backend.app.services import queue_sources, swap_compatibility as sc
from backend.app.services.bambu_mqtt import BambuMQTTClient
from backend.tests.fixtures.filament_routing_cases import write_routing_3mf
from backend.tests.integration.test_dispatch_without_original import (
    dispatch_mocks,
    drain,
    scheduler_with_captured_dispatch,
)

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]

PLATE = 15
BOTH = ["swap_mode_start", "swap_mode_change_table"]


@pytest.fixture(autouse=True)
def clean_state():
    from backend.app.services import archive_write_scope
    from backend.app.services.printer_manager import printer_manager

    def clear():
        queue_sources._reset_state()
        for attribute in (
            "_print_run_bindings",
            "_print_run_finishing_bindings",
            "_print_start_resolutions",
            "_pending_print_terminals",
        ):
            registry = getattr(printer_manager, attribute, None)
            if isinstance(registry, dict):
                registry.clear()
        printer_manager._awaiting_plate_clear.clear()
        archive_write_scope._archive_locks.clear()
        archive_write_scope._archive_file_locks.clear()
        main._active_swap_config.clear()
        main._active_prints.clear()

    clear()
    yield
    clear()


class Farm(SimpleNamespace):
    pass


@pytest.fixture
async def farm(test_engine, tmp_path, monkeypatch):
    from backend.app.services.printer_manager import printer_manager

    if test_engine.dialect.name == "sqlite":
        engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'chain.db'}")
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
    else:
        engine = test_engine
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr(main, "async_session", factory)
    monkeypatch.setattr("backend.app.core.database.async_session", factory)
    real_register_swap_config = main.register_swap_config
    service = dispatch_mocks(monkeypatch, factory)
    settings.archive_dir.mkdir(parents=True, exist_ok=True)

    async with factory() as db:
        printer = Printer(
            name="Swap mini",
            serial_number="00M09E000000001",
            ip_address="192.0.2.77",
            access_code="12345678",
            is_active=True,
            auto_archive=True,
            model="P1P",
            plate_detection_enabled=False,
            require_plate_clear=True,
            swap_mode_enabled=True,
        )
        db.add(printer)
        await db.flush()
        db.add(PrinterQueue(id=printer.id, printer_id=printer.id, auto_distribute_eligible=True))
        await db.commit()
        printer_id = printer.id

    mqtt = BambuMQTTClient("127.0.0.1", "SYNTHETIC", "00000000", model="P1P")
    mqtt._client = MagicMock()
    mqtt.state.connected = True
    mqtt.state.state = "IDLE"
    mqtt._process_message(
        {
            "print": {
                "command": "push_status",
                "ams": {"ams": []},
                "vt_tray": {"id": 254, "tray_type": "PLA", "tray_color": "0000FF"},
            }
        }
    )
    monkeypatch.setitem(printer_manager._clients, printer_id, mqtt)
    monkeypatch.setitem(printer_manager._models, printer_id, "P1P")

    sent: list[str] = []

    async def execute_macro_and_wait(_printer_id, gcode, name, **_kwargs):
        sent.append(name)
        return True, "ok"

    async def find_swap_macro(_db, event, _printer):
        return SimpleNamespace(gcode=f"; {event}", name=event)

    monkeypatch.setattr(printer_manager, "execute_macro_and_wait", execute_macro_and_wait)
    monkeypatch.setattr("backend.app.services.macro_executor.find_swap_macro", find_swap_macro)
    # The dispatcher's real swap step, not dispatch_mocks' stub.
    import backend.app.services.background_dispatch as bd

    monkeypatch.setattr(
        service,
        "_run_swap_macro_if_needed",
        bd.BackgroundDispatchService._run_swap_macro_if_needed.__get__(service),
    )
    # What dispatch hands the completion: its swap config (dispatch_mocks stubs it out).
    monkeypatch.setattr("backend.app.main.register_swap_config", real_register_swap_config)

    for name in ("ws_manager", "mqtt_relay", "smart_plug_manager", "notification_service"):
        monkeypatch.setattr(main, name, AsyncMock())
    monkeypatch.setattr(main, "_record_print_energy", AsyncMock())
    monkeypatch.setattr(
        "backend.app.services.archive_download_retry.archive_download_retry.retry_archive",
        AsyncMock(return_value="already_has_file"),
    )
    monkeypatch.setattr("backend.app.services.macro_trigger.fire_event_macros", AsyncMock())
    monkeypatch.setattr("backend.app.services.usage_tracker.on_print_complete", AsyncMock(return_value=[]))
    finish_tasks: list = []
    real_spawn = main.spawn_background_task

    def spawn(coro, *, name):
        if name.startswith("post-print-cleanup-"):
            coro.close()
            done = asyncio.get_running_loop().create_future()
            done.set_result(None)
            return done
        task = real_spawn(coro, name=name)
        finish_tasks.append(task)
        return task

    monkeypatch.setattr(main, "spawn_background_task", spawn)
    yield Farm(printer_id=printer_id, factory=factory, manager=printer_manager, sent=sent, tasks=finish_tasks)
    if engine is not test_engine:
        await engine.dispose()


def a_3mf(path, tag: str) -> bytes:
    import zipfile

    write_routing_3mf(path, {PLATE: [{"id": 3, "type": "PLA", "color": "#FF0000", "used_g": "0.0001"}]})
    with zipfile.ZipFile(path, "a") as zf:
        zf.writestr("Metadata/tag.txt", tag)
    return path.read_bytes()


async def upload(farm, tmp_path, name: str, tag: str) -> int:
    from backend.app.api.routes.library import store_library_upload

    content = a_3mf(tmp_path / f"src-{tag}.3mf", tag)
    async with farm.factory() as db:
        result = await store_library_upload(db, filename=name, content=content, target_folder=None)
        return result.file.id


async def queue_job(farm, **source) -> int:
    from backend.app.services.queue_add import add_items_to_printer_queue

    async with farm.factory() as db:
        items, _queue = await add_items_to_printer_queue(
            db,
            PrintQueueItemCreate(
                queue_id=farm.printer_id,
                plate_id=PLATE,
                execute_swap_macros=True,
                swap_macro_events=BOTH,
                **source,
            ),
            None,
        )
        return items[0].id


async def dispatch(farm, monkeypatch) -> int:
    """Run the scheduler once; returns the execution archive of the job it started."""
    scheduler, spawned = scheduler_with_captured_dispatch(monkeypatch)
    assert await scheduler.check_queue() is True
    assert await drain(spawned) == 1
    async with farm.factory() as db:
        item = (await db.execute(select(PrintQueueItem).where(PrintQueueItem.status == "printing"))).scalar_one()
        return item.archive_id


async def finish(farm) -> None:
    await main.on_print_complete(farm.printer_id, {"status": "completed"})
    while farm.tasks:
        running, farm.tasks[:] = list(farm.tasks), []
        await asyncio.gather(*running, return_exceptions=True)
    # The next print may start: the printer reports idle again.
    farm.manager._clients[farm.printer_id].state.state = "IDLE"


async def archive_fact(farm, archive_id: int):
    async with farm.factory() as db:
        return sc.archive_fact(await db.get(PrintArchive, archive_id)).value


async def test_a_declared_swap_file_keeps_its_fact_from_upload_to_reprint(farm, tmp_path, monkeypatch):
    library_id = await upload(farm, tmp_path, "plate.swaps.gcode.3mf", "declared")
    job_id = await queue_job(farm, library_file_id=library_id)

    # The original goes: the job answers from its own captured bytes and fact.
    async with farm.factory() as db:
        row = await db.get(LibraryFile, library_id)
        path = row.file_path
        job = await db.get(PrintQueueItem, job_id)
        job.library_file_id = None
        await db.delete(row)
        await db.commit()
    from backend.app.api.routes.library import to_absolute_path

    os.remove(to_absolute_path(path))

    archive_id = await dispatch(farm, monkeypatch)
    assert farm.sent == [], "the file carries its own sequence: none of our swap macros go out"
    assert await archive_fact(farm, archive_id) is True

    await finish(farm)
    assert farm.manager.is_awaiting_plate_clear(farm.printer_id) is False, "the baked sequence cleared the plate"

    await queue_job(farm, archive_id=archive_id)
    reprint_archive = await dispatch(farm, monkeypatch)
    assert reprint_archive != archive_id
    assert await archive_fact(farm, reprint_archive) is True
    assert farm.sent == []


async def test_a_renamed_plain_file_stays_false_through_a_copy_and_gets_our_swap(farm, tmp_path, monkeypatch):
    from backend.app.services.queue_ops import clone_item

    library_id = await upload(farm, tmp_path, "plate.gcode.3mf", "plain")
    async with farm.factory() as db:
        row = await db.get(LibraryFile, library_id)
        row.filename = "plate.swap.gcode.3mf"  # a display rename declares nothing
        await db.commit()
    job_id = await queue_job(farm, library_file_id=library_id)
    async with farm.factory() as db:
        copy = await clone_item(db, job_id)
        await db.commit()
        copy_id = copy.id
        await db.delete(await db.get(PrintQueueItem, job_id))
        await db.commit()

    archive_id = await dispatch(farm, monkeypatch)
    async with farm.factory() as db:
        assert (await db.get(PrintQueueItem, copy_id)).archive_id == archive_id
    assert await archive_fact(farm, archive_id) is False
    assert farm.sent == ["swap_mode_start"]

    await finish(farm)
    assert farm.sent == ["swap_mode_start", "swap_mode_change_table"]
    assert farm.manager.is_awaiting_plate_clear(farm.printer_id) is False, "our table swap cleared the plate"
    async with farm.factory() as db:
        extra = (await db.get(PrintArchive, archive_id)).extra_data
    assert "swap_mode_change_table" not in (extra.get("swap_macro_events_pending") or [])
    assert extra.get("swap_start_effect") == "fired"
