"""Synthetic Product A/B only, in the suite's isolated in-memory database."""

import pytest
from sqlalchemy import select

from backend.app.models.archive import PrintArchive
from backend.app.models.archive_part import PrintArchivePart
from backend.app.models.auto_queue import AutoQueueItem
from backend.app.models.library import LibraryFile
from backend.app.models.line_config import ProjectLinePartCount
from backend.app.models.part_stock import ProductPartStockMovement
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.product import Product, ProductPart, ProductPlate
from backend.app.models.project import Project
from backend.app.models.project_line import ProjectLine
from backend.app.services.printer_queues import ensure_printer_queue

pytestmark = pytest.mark.integration


async def print_part(db, order, line, file, key="part a", qty=5, defective=1, status="completed", **extra):
    archive = PrintArchive(
        project_id=order.id,
        project_line_id=line.id if line else None,
        library_file_id=file.id,
        filename="misleading-name-part-b.3mf",
        file_path="",
        file_size=0,
        plate_index=1,
        status=status,
        filament_type="PLA",
        **extra,
    )
    db.add(archive)
    await db.flush()
    db.add(PrintArchivePart(archive_id=archive.id, name=key, name_key=key, quantity=qty, defective=defective))
    return archive


@pytest.fixture
async def progress_fixture(db_session, printer_factory):
    db = db_session
    order, a, b = Project(name="Synthetic order"), Product(name="Product A"), Product(name="Product B")
    # Two plates in one file, plus a second interchangeable file. Display names
    # deliberately disagree with object identity.
    file = LibraryFile(
        filename="part-b.3mf",
        file_path="",
        file_size=0,
        file_type="gcode",
        file_metadata={
            "plates": [
                {
                    "index": 1,
                    "printable_objects": {"1": "part a", "2": "part a", "3": "part a"},
                    "filaments": [{"type": "PLA"}],
                },
                {"index": 2, "printable_objects": {"1": "part b"}, "filaments": [{"type": "PLA"}]},
            ]
        },
    )
    second = LibraryFile(
        filename="alternative.3mf",
        file_path="",
        file_size=0,
        file_type="gcode",
        file_metadata={
            "plates": [
                {"index": 1, "printable_objects": {str(i): "part a" for i in range(6)}, "filaments": [{"type": "PLA"}]},
            ]
        },
    )
    db.add_all([order, a, b, file, second])
    await db.flush()
    pa = ProductPart(product_id=a.id, name="Part A", name_key="part a", qty_per_unit=3)
    pb = ProductPart(product_id=a.id, name="Part B", name_key="part b", qty_per_unit=1)
    pc = ProductPart(product_id=b.id, name="Part C", name_key="part c", qty_per_unit=2)
    la = ProjectLine(project_id=order.id, product_id=a.id, quantity=4, material="PLA")
    lb = ProjectLine(project_id=order.id, product_id=b.id, quantity=2, material="PLA", sort_order=1)
    db.add_all(
        [
            pa,
            pb,
            pc,
            la,
            lb,
            ProductPlate(product_id=a.id, library_file_id=file.id, plate_index=0),
            ProductPlate(product_id=a.id, library_file_id=second.id, plate_index=1),
        ]
    )
    await db.flush()
    db.add_all(
        [
            ProductPartStockMovement(product_part_id=pa.id, delta=9, reason="manual"),
            ProductPartStockMovement(
                product_part_id=pa.id, delta=-3, reason="reserved_for_order", project_line_id=la.id
            ),
            ProductPartStockMovement(product_part_id=pb.id, delta=5, reason="manual"),
        ]
    )
    await print_part(db, order, la, file)
    await print_part(db, order, la, file, qty=3, defective=0, status="printing")
    printer = await printer_factory(name="Synthetic printer")
    await ensure_printer_queue(db, printer.id)
    queue = PrintQueueItem(
        queue_id=printer.id,
        project_id=order.id,
        project_line_id=la.id,
        library_file_id=file.id,
        plate_id=1,
        status="pending",
    )
    db.add(queue)
    await db.flush()
    db.add(
        AutoQueueItem(
            project_id=order.id,
            project_line_id=la.id,
            library_file_id=file.id,
            plate_id=1,
            status="pending",
            assigned_to_item_id=queue.id,
        )
    )
    await db.commit()
    return order, la, lb, pa, pb, pc, file, second, queue


async def read(client, order):
    response = await client.get(f"/api/v1/projects/{order.id}/part-progress")
    assert response.status_code == 200, response.text
    return response.json()


async def test_full_bom_stock_good_defects_and_expected_parts(async_client, progress_fixture):
    order, la, lb, pa, pb, pc, *_ = progress_fixture
    body = await read(async_client, order)
    rows = {(p["order_line_id"], p["part_id"]): p for p in body["parts"]}
    a = rows[la.id, pa.id]
    assert {
        key: a[key]
        for key in (
            "required_qty",
            "free_stock_qty",
            "allocated_stock_qty",
            "completed_good_qty",
            "printing_qty",
            "queued_qty",
            "rejected_qty",
            "secured_qty",
            "remaining_qty",
        )
    } == {
        "required_qty": 12,
        "free_stock_qty": 6,
        "allocated_stock_qty": 3,
        "completed_good_qty": 4,
        "printing_qty": 3,
        "queued_qty": 3,
        "rejected_qty": 1,
        "secured_qty": 7,
        "remaining_qty": 0,
    }
    assert sum(c["runs"] for c in a["contributions"] if c["source_kind"] == "printer_queue") == 1
    # Whole-file link must not count the second plate's B when plate 1 is queued.
    assert rows[la.id, pb.id]["queued_qty"] == 0
    assert rows[la.id, pb.id]["required_qty"] == rows[la.id, pb.id]["remaining_qty"] == 4
    assert rows[la.id, pb.id]["free_stock_qty"] == 5
    assert rows[lb.id, pc.id]["required_qty"] == rows[lb.id, pc.id]["remaining_qty"] == 4
    assert len(a["contributions"]) == 4  # two prints, one queue, one unused recipe
    assert body["unallocated"] == []


async def test_ambiguous_completed_and_queued_output_is_not_greedily_allocated(
    async_client, db_session, progress_fixture
):
    order, la, _lb, pa, _pb, _pc, file, *_ = progress_fixture
    sibling = ProjectLine(project_id=order.id, product_id=la.product_id, quantity=2, material="PLA")
    db_session.add(sibling)
    await db_session.flush()
    await print_part(db_session, order, None, file, qty=8, defective=2)
    db_session.add(AutoQueueItem(project_id=order.id, library_file_id=file.id, plate_id=1, status="pending"))
    await db_session.commit()
    body = await read(async_client, order)
    a = next(p for p in body["parts"] if p["order_line_id"] == la.id and p["part_id"] == pa.id)
    assert a["completed_good_qty"] == 4 and a["queued_qty"] == 3
    other = next(p for p in body["parts"] if p["order_line_id"] == sibling.id and p["part_id"] == pa.id)
    assert other["completed_good_qty"] == other["queued_qty"] == 0
    assert [u["reason"] for u in body["unallocated"]] == ["ambiguous", "ambiguous"]
    assert body["unallocated"][0]["completed_good_qty"] == 6
    assert body["unallocated"][0]["rejected_qty"] == 2
    assert body["unallocated"][0]["candidate_pairs"] == [[la.id, pa.id], [sibling.id, pa.id]]


async def test_missing_objects_and_recipe_report_unknown_not_zero_success(async_client, db_session, progress_fixture):
    order, la, *_ = progress_fixture
    db_session.add_all(
        [
            PrintArchive(
                project_id=order.id,
                project_line_id=la.id,
                filename="Part A.stl",
                file_path="",
                file_size=0,
                status="completed",
            ),
            AutoQueueItem(project_id=order.id, project_line_id=la.id, status="pending"),
        ]
    )
    await db_session.commit()
    body = await read(async_client, order)
    assert [u["reason"] for u in body["unallocated"]] == ["missing_part_rows", "missing_recipe"]
    assert all(u["expected_qty"] is None for u in body["unallocated"])


async def test_explicit_line_without_order_queue_id_and_auto_tier(async_client, db_session, progress_fixture):
    order, la, _lb, pa, _pb, _pc, _file, second, *_ = progress_fixture
    db_session.add(AutoQueueItem(project_line_id=la.id, library_file_id=second.id, plate_id=1, status="pending"))
    await db_session.commit()
    body = await read(async_client, order)
    a = next(p for p in body["parts"] if p["part_id"] == pa.id)
    assert a["queued_qty"] == 9  # three parts + six parts, two runs


async def test_missing_order_returns_404(async_client):
    assert (await async_client.get("/api/v1/projects/999999/part-progress")).status_code == 404


async def test_shared_bed_can_credit_a_unique_foreign_product_part(async_client, db_session, progress_fixture):
    order, la, lb, _pa, _pb, pc, file, *_ = progress_fixture
    db_session.add(ProductPlate(product_id=lb.product_id, library_file_id=file.id, plate_index=1))
    await print_part(db_session, order, la, file, key=pc.name_key, qty=2, defective=0)
    await db_session.commit()
    body = await read(async_client, order)
    c = next(p for p in body["parts"] if p["part_id"] == pc.id)
    assert c["order_line_id"] == lb.id and c["completed_good_qty"] == 2
    assert body["unallocated"] == []


async def test_conflicting_aliases_are_ambiguous_even_with_an_explicit_line(async_client, db_session, progress_fixture):
    order, la, _lb, pa, pb, *_ = progress_fixture
    pb.aliases = [pa.name_key]
    await db_session.commit()
    body = await read(async_client, order)
    assert all(p["completed_good_qty"] == p["printing_qty"] == p["queued_qty"] == 0 for p in body["parts"])
    assert all(u["reason"] == "ambiguous" for u in body["unallocated"])
    assert body["unallocated"][0]["candidate_pairs"] == [[la.id, pa.id], [la.id, pb.id]]


async def test_two_object_aliases_of_one_part_do_not_turn_one_archive_into_two_runs(
    async_client, db_session, progress_fixture
):
    order, _la, _lb, pa, *_ = progress_fixture
    pa.aliases = ["alternate a"]
    archive = (
        await db_session.execute(
            select(PrintArchive).where(
                PrintArchive.project_id == order.id,
                PrintArchive.status == "completed",
            )
        )
    ).scalar_one()
    db_session.add(
        PrintArchivePart(archive_id=archive.id, name="Alternate A", name_key="alternate a", quantity=2, defective=0)
    )
    await db_session.commit()
    body = await read(async_client, order)
    a = next(p for p in body["parts"] if p["part_id"] == pa.id)
    completed = next(c for c in a["contributions"] if c["source_kind"] == "archive" and c["source_id"] == archive.id)
    assert completed["runs"] == 1 and completed["expected_qty"] == 7
    assert completed["completed_good_qty"] == a["completed_good_qty"] == 6


async def test_parts_mode_uses_the_configured_composition_not_the_standard_bom(
    async_client, db_session, progress_fixture
):
    order, la, _lb, pa, pb, *_ = progress_fixture
    la.mode = "parts"
    la.quantity = 1
    db_session.add_all(
        [
            ProjectLinePartCount(line_id=la.id, part_id=pa.id, qty=5),
            ProjectLinePartCount(line_id=la.id, part_id=pb.id, qty=0),
        ]
    )
    await db_session.commit()
    body = await read(async_client, order)
    parts = [p for p in body["parts"] if p["order_line_id"] == la.id]
    assert len(parts) == 1 and parts[0]["required_qty"] == 5


async def test_deleted_and_aborted_archives_do_not_add_output(async_client, db_session, progress_fixture):
    from datetime import datetime

    order, la, _lb, _pa, _pb, _pc, file, *_ = progress_fixture
    await print_part(db_session, order, la, file, qty=1000, deleted_at=datetime.now())
    await print_part(db_session, order, la, file, qty=1000, extra_data={"dispatch_aborted": True})
    await db_session.commit()
    body = await read(async_client, order)
    assert body["parts"][0]["completed_good_qty"] == 4
    assert len(body["parts"][0]["contributions"]) == 4


async def test_recorded_rejects_on_a_failed_run_never_supply_good_coverage(async_client, db_session, progress_fixture):
    order, la, _lb, _pa, _pb, _pc, file, *_ = progress_fixture
    await print_part(db_session, order, la, file, qty=5, defective=2, status="failed")
    await db_session.commit()
    body = await read(async_client, order)
    assert body["parts"][0]["rejected_qty"] == 3
    assert body["parts"][0]["completed_good_qty"] == 4
    assert body["parts"][0]["secured_qty"] == 7


async def test_projection_does_not_change_existing_order_figures(async_client, progress_fixture):
    order, *_ = progress_fixture
    before = (await async_client.get(f"/api/v1/projects/{order.id}")).json()
    await read(async_client, order)
    after = (await async_client.get(f"/api/v1/projects/{order.id}")).json()
    assert before == after


async def test_printer_limited_key_sees_only_its_jobs_and_no_auto_queue(async_client, progress_fixture):
    order, _la, _lb, _pa, _pb, _pc, _file, _second, queue = progress_fixture
    created = await async_client.post(
        "/api/v1/api-keys/",
        json={
            "name": "synthetic-read",
            "can_read_status": True,
            "printer_ids": [queue.queue_id],
        },
    )
    assert created.status_code == 200, created.text
    async_client.headers["X-API-Key"] = created.json()["key"]
    async_client.headers.pop("Authorization", None)
    body = await read(async_client, order)
    assert body["scope_limited"] is True
    assert body["parts"][0]["completed_good_qty"] == body["parts"][0]["printing_qty"] == 0
    assert body["parts"][0]["queued_qty"] == 3
    assert not any(c["source_kind"] == "archive" for p in body["parts"] for c in p["contributions"])
