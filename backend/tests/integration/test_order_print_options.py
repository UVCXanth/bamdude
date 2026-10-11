"""Synthetic Product A/B, real API/intake/promotion; no hardware or network."""

from contextlib import asynccontextmanager
from copy import deepcopy

import pytest
from sqlalchemy import select

from backend.app.api.routes.auto_queue import _apply_item_update
from backend.app.models.auto_queue import AutoQueueItem
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer_queue import PrinterQueue
from backend.app.models.product import Product, ProductPart, ProductPlate
from backend.app.models.project import Project
from backend.app.services.auto_queue_scheduler import AutoQueueScheduler
from backend.tests.fixtures.filament_routing_cases import DUAL_SETTINGS, write_routing_3mf
from backend.tests.integration.test_filament_routing_dispatch import setup_source

pytestmark = pytest.mark.integration


@pytest.fixture
async def mixed_order(committing_client, db_session, tmp_path):
    products, plates = [], {}
    for name, models in (("Product A", ("A1 Mini", "P1S")), ("Product B", ("H2D", "P2S"))):
        product = Product(name=name)
        db_session.add(product)
        await db_session.flush()
        db_session.add_all(
            [
                ProductPart(product_id=product.id, kind="printed", name="Part A", name_key="part a", qty_per_unit=3),
                ProductPart(product_id=product.id, kind="printed", name="Part B", name_key="part b", qty_per_unit=1),
            ]
        )
        products.append(product)
        for model in models:
            path = write_routing_3mf(
                tmp_path / f"unrelated-{model.replace(' ', '')}.gcode.3mf",
                {1: [{"id": 1, "type": "PLA", "color": "#FF0000", "used_g": "1", "group_id": 0}]},
                model=model,
                settings=DUAL_SETTINGS if model == "H2D" else None,
                prediction=60,
            )
            file = LibraryFile(
                filename="H2D-name-is-not-the-model.gcode.3mf",
                file_path=str(path),
                file_size=path.stat().st_size,
                file_type="gcode",
                file_metadata={
                    "sliced_for_model": model,
                    "plates": [
                        {
                            "index": 1,
                            "printable_objects": {"1": "Part A", "2": "Part A", "3": "Part A", "4": "Part B"},
                            "print_time_seconds": 60,
                        }
                    ],
                },
            )
            db_session.add(file)
            await db_session.flush()
            plate = ProductPlate(product_id=product.id, library_file_id=file.id, plate_index=0)
            db_session.add(plate)
            await db_session.flush()
            plates[model] = (plate.id, product.id)
    await db_session.commit()
    response = await committing_client.post(
        "/api/v1/projects/",
        json={
            "name": "Synthetic mixed order",
            "lines": [{"product_id": p.id, "quantity": 10} for p in products],
        },
    )
    assert response.status_code == 200, response.text
    order = response.json()
    line_ids = {line["product_id"]: line["id"] for line in order["lines"]}
    return order["id"], {m: (plate, line_ids[product]) for m, (plate, product) in plates.items()}


async def custom_options(client, pid):
    response = await client.get(f"/api/v1/projects/{pid}/print-options")
    assert response.status_code == 200, response.text
    return {m["model"]: m["inherited"] for m in response.json()["models"]}


async def enqueue(client, pid, plates, *, printer_id=None, models=None):
    return await client.post(
        f"/api/v1/projects/{pid}/plan/enqueue",
        json={
            "items": [
                {"plate_id": plate, "line_id": line, "count": 2}
                for model, (plate, line) in plates.items()
                if models is None or model in models
            ],
            "target": {"kind": "auto"} if printer_id is None else {"kind": "printer", "printer_id": printer_id},
        },
    )


async def test_roundtrip_models_are_metadata_and_settings_reset(committing_client, db_session, mixed_order):
    pid, _ = mixed_order
    options = await custom_options(committing_client, pid)
    assert set(options) == {"A1 Mini", "P1S", "H2D", "P2S"}
    assert options["P1S"]["flow_cali"] == "off"
    assert options["H2D"]["nozzle_offset_cali"] == "on"
    options["A1 Mini"]["flow_cali"] = "off"
    response = await committing_client.put(f"/api/v1/projects/{pid}/print-options", json={"overrides": options})
    assert response.status_code == 200, response.text
    assert response.json()["overrides"] == options
    assert (await custom_options(committing_client, pid))["A1 Mini"]["flow_cali"] == "on"
    assert (await db_session.get(Project, pid)).order_print_options == options
    reset = await committing_client.put(f"/api/v1/projects/{pid}/print-options", json={"overrides": {}})
    assert reset.status_code == 200
    assert reset.json()["overrides"] == {}
    await db_session.refresh(await db_session.get(Project, pid))
    assert (await db_session.get(Project, pid)).order_print_options is None


@pytest.mark.parametrize(
    "model,key,value",
    [
        ("P1S", "flow_cali", "on"),
        ("P1S", "flow_cali", "auto"),
        ("A1 Mini", "flow_cali", "auto"),
        ("A1 Mini", "nozzle_offset_cali", "on"),
        ("P2S", "nozzle_offset_cali", "auto"),
        ("H2D", "layer_inspect", True),
        ("H2D", "preheat_chamber_target_override", 999),
        ("P1S", "preheat_chamber_target_override", 30),
        ("H2D", "flow_cali", "garbage"),
        ("H2D", "unrecognized", True),
    ],
)
async def test_unsupported_or_invalid_never_saves(committing_client, db_session, mixed_order, model, key, value):
    pid, _ = mixed_order
    options = await custom_options(committing_client, pid)
    options[model][key] = value
    response = await committing_client.put(f"/api/v1/projects/{pid}/print-options", json={"overrides": options})
    assert response.status_code == 422, response.text
    assert (await db_session.get(Project, pid)).order_print_options is None


async def test_aliases_duplicate_models_unknown_and_closed_order(committing_client, db_session, mixed_order):
    pid, _ = mixed_order
    p1 = (await custom_options(committing_client, pid))["P1S"]
    response = await committing_client.put(
        f"/api/v1/projects/{pid}/print-options",
        json={
            "overrides": {"C12": p1},
        },
    )
    assert response.status_code == 200
    assert set(response.json()["overrides"]) == {"P1S"}
    for overrides in ({"P1S": p1, "C12": p1}, {"fictional": p1}):
        response = await committing_client.put(f"/api/v1/projects/{pid}/print-options", json={"overrides": overrides})
        assert response.status_code == 422
    response = await committing_client.patch(f"/api/v1/projects/{pid}", json={"status": "cancelled"})
    assert response.status_code == 200
    response = await committing_client.put(f"/api/v1/projects/{pid}/print-options", json={"overrides": {}})
    assert response.status_code == 409


async def test_read_only_user_cannot_change_order_defaults(committing_client, db_session, mixed_order):
    from backend.tests.integration.test_queue_rebalance_api import _as_viewer

    pid, _ = mixed_order
    await _as_viewer(committing_client, db_session)
    response = await committing_client.get(f"/api/v1/projects/{pid}/print-options")
    assert response.status_code == 200, response.text
    response = await committing_client.put(f"/api/v1/projects/{pid}/print-options", json={"overrides": {}})
    assert response.status_code == 403, response.text
    assert (await db_session.get(Project, pid)).order_print_options is None


async def test_mixed_enqueue_snapshots_only_new_jobs(committing_client, db_session, mixed_order):
    pid, plates = mixed_order
    options = await custom_options(committing_client, pid)
    options["A1 Mini"]["flow_cali"] = "off"
    options["H2D"]["nozzle_offset_cali"] = "auto"
    options["P2S"]["bed_levelling"] = "auto"
    options["P2S"]["preheat_override"] = "off"
    response = await enqueue(committing_client, pid, plates, models={"P1S"})
    assert response.status_code == 200, response.text
    old_ids = response.json()["created"][0]["queue_item_ids"]
    response = await committing_client.put(f"/api/v1/projects/{pid}/print-options", json={"overrides": options})
    assert response.status_code == 200, response.text
    response = await enqueue(committing_client, pid, plates)
    assert response.status_code == 200, response.text
    rows = (await db_session.execute(select(AutoQueueItem))).scalars().all()
    for row in rows:
        if row.id in old_ids:
            assert row.order_print_options is None
        else:
            assert row.order_print_options == options
            if row.target_model == "A1 Mini":
                assert row.flow_cali is False
            if row.target_model == "P2S":
                assert row.bed_levelling is False  # tri-state lives in snapshot
    await committing_client.put(f"/api/v1/projects/{pid}/print-options", json={"overrides": {}})
    for row in rows:
        await db_session.refresh(row)
        assert row.order_print_options == (None if row.id in old_ids else options)


async def test_direct_queue_modes_preheat_and_baked_macros(committing_client, db_session, mixed_order, printer_factory):
    pid, plates = mixed_order
    printer = await printer_factory(model="H2D")
    db_session.add(PrinterQueue(printer_id=printer.id))
    await db_session.commit()
    options = (await custom_options(committing_client, pid))["H2D"]
    options.update(
        bed_levelling="auto", flow_cali="off", nozzle_offset_cali="auto", preheat_override="off", gcode_injection=True
    )
    response = await committing_client.put(
        f"/api/v1/projects/{pid}/print-options", json={"overrides": {"H2D": options}}
    )
    assert response.status_code == 200, response.text
    response = await enqueue(committing_client, pid, plates, printer_id=printer.id, models={"H2D"})
    assert response.status_code == 200, response.text
    rows = (await db_session.execute(select(PrintQueueItem))).scalars().all()
    assert len(rows) == 2
    for row in rows:
        assert row.bed_levelling_mode == "auto" and not row.bed_levelling
        assert row.flow_cali_mode == "off" and not row.flow_cali
        assert row.nozzle_offset_cali_mode == "auto"
        assert row.preheat_override == "off" and row.gcode_injection
        assert not row.execute_swap_macros  # Not enabled for the target printer.


@pytest.mark.parametrize("target", ["P1P", "P1S"])
async def test_real_promotion_explicit_order_choices_outlive_profile_changes(
    committing_client,
    db_session,
    tmp_path,
    printer_factory,
    monkeypatch,
    target,
):
    # Existing real-intake fixture routes P1P-compatible bytes onto a P1P. MQTT
    # telemetry is synthetic; only tick/assignment runs, never hardware dispatch.
    source, printer, queue, _mqtt = await setup_source(db_session, tmp_path, printer_factory, monkeypatch)
    if target != "P1P":
        from backend.app.models.settings import Settings
        from backend.app.services.printer_manager import printer_manager

        printer.model = target
        printer_manager._models[printer.id] = target
        db_session.add(Settings(key="auto_queue_compatible_models", value="true"))
        await db_session.commit()
    response = await committing_client.post("/api/v1/auto-queue/", json={"library_file_id": source.id})
    assert response.status_code == 200, response.text
    auto = (await db_session.execute(select(AutoQueueItem))).scalar_one()
    from backend.app.services.order_print_options import inherited_options

    options = (await inherited_options(db_session, None, "P1P")).model_dump()
    options.update(bed_levelling="off", gcode_injection=True, preheat_override="off", timelapse=True)
    auto.order_print_options = {"P1P": options}
    from backend.app.models.print_options_preference import PrintOptionsPreference

    # A later default disagrees with every explicit choice. It must not win,
    # including when the compatible target is another printer model.
    profile = {**options, "bed_levelling": "on", "gcode_injection": False, "timelapse": False, "preheat_override": "on"}
    db_session.add(
        PrintOptionsPreference(
            user_id=auto.created_by_id,
            printer_model=target,
            options={
                "print_options": profile,
                "swap_macros": {"execute": False, "events": []},
            },
        )
    )
    await db_session.commit()

    @asynccontextmanager
    async def session():
        yield db_session

    monkeypatch.setattr("backend.app.services.auto_queue_scheduler.async_session", session)
    await AutoQueueScheduler().tick()
    row = (await db_session.execute(select(PrintQueueItem))).scalar_one()
    assert row.bed_levelling_mode == "off" and not row.bed_levelling
    assert row.flow_cali_mode == "off"
    assert row.gcode_injection and row.timelapse and row.preheat_override == "off"
    assert row.nozzle_offset_cali_mode == "off"
    assert auto.order_print_options == {"P1P": options}


async def test_auto_job_edit_updates_only_its_model_entry(committing_client, db_session, mixed_order):
    pid, plates = mixed_order
    options = await custom_options(committing_client, pid)
    await committing_client.put(f"/api/v1/projects/{pid}/print-options", json={"overrides": options})
    assert (await enqueue(committing_client, pid, plates, models={"A1 Mini"})).status_code == 200
    row = (await db_session.execute(select(AutoQueueItem))).scalars().first()
    before = deepcopy(row.order_print_options)
    _apply_item_update(row, {"flow_cali": "off", "timelapse": True})
    assert row.order_print_options["A1 Mini"]["flow_cali"] == "off"
    assert row.order_print_options["A1 Mini"]["timelapse"] is True
    assert row.order_print_options["H2D"] == before["H2D"]
    assert (await db_session.get(Project, pid)).order_print_options == before
    assert row.flow_cali is False
