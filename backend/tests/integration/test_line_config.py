"""The one writer of a line's configuration (spec workshop-product-variants, rules 5, 11–14)."""

import pytest
from sqlalchemy import select

from backend.app.models.archive import PrintArchive
from backend.app.models.archive_part import PrintArchivePart
from backend.app.models.library import LibraryFile
from backend.app.models.line_config import ProjectLineChoice, ProjectLinePartCount
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer_queue import PrinterQueue
from backend.app.models.product import Product, ProductPart, ProductPlate
from backend.app.models.product_variant import ProductVariantGroup, ProductVariantOption
from backend.app.models.project import Project, ProjectEvent
from backend.app.models.project_line import ProjectLine
from backend.app.services import line_config, part_stock

pytestmark = pytest.mark.integration


async def _group(db, product, name, options, default_index=0):
    group = ProductVariantGroup(product_id=product.id, name=name, position=0)
    db.add(group)
    await db.flush()
    opts = [ProductVariantOption(group_id=group.id, name=o, position=i) for i, o in enumerate(options)]
    db.add_all(opts)
    await db.flush()
    group.default_option_id = opts[default_index].id
    await db.flush()
    return group, opts


@pytest.fixture
async def pipe(db_session):
    """«Pipe»: flask ×1; tail straight (standard) / angled; one order with a line of 4."""
    product = Product(name="Pipe")
    db_session.add(product)
    await db_session.flush()
    group, (straight, angled) = await _group(db_session, product, "Tail", ["straight", "angled"])
    parts = {
        name: ProductPart(
            product_id=product.id,
            kind="printed",
            name=name,
            name_key=name,
            qty_per_unit=1,
            aliases=[name],
            variant_option_id=option,
            sort_order=i,
        )
        for i, (name, option) in enumerate((("flask", None), ("straight", straight.id), ("angled", angled.id)))
    }
    db_session.add_all(parts.values())
    project = Project(name="O")
    db_session.add(project)
    await db_session.flush()
    line = ProjectLine(project_id=project.id, product_id=product.id, quantity=4)
    db_session.add(line)
    await db_session.flush()
    await line_config.seed_line(db_session, line, choices=None, counts=None)
    await db_session.commit()
    return {"product": product, "group": group, "straight": straight, "angled": angled, "parts": parts, "line": line}


async def _choices(db, line_id):
    rows = (
        await db.execute(
            select(ProjectLineChoice.group_id, ProjectLineChoice.option_id).where(ProjectLineChoice.line_id == line_id)
        )
    ).all()
    return dict(rows)


async def _counts(db, line_id):
    rows = (
        await db.execute(
            select(ProjectLinePartCount.part_id, ProjectLinePartCount.qty).where(
                ProjectLinePartCount.line_id == line_id
            )
        )
    ).all()
    return dict(rows)


@pytest.mark.asyncio
async def test_a_new_line_gets_the_standard_option_written(db_session, pipe):
    line = pipe["line"]
    assert await _choices(db_session, line.id) == {pipe["group"].id: pipe["straight"].id}
    assert line.config_key == f"{pipe['group'].id}={pipe['straight'].id}"


@pytest.mark.asyncio
async def test_choosing_another_option_rewrites_choice_key_and_journal(db_session, pipe):
    line, gid = pipe["line"], pipe["group"].id
    await line_config.set_configuration(db_session, line, choices={gid: pipe["angled"].id}, counts={}, actor=None)
    await db_session.commit()
    assert await _choices(db_session, line.id) == {gid: pipe["angled"].id}
    assert line.config_key == f"{gid}={pipe['angled'].id}"
    events = (
        (await db_session.execute(select(ProjectEvent).where(ProjectEvent.kind == "line_configured"))).scalars().all()
    )
    assert len(events) == 1
    payload = events[0].payload
    assert payload["line_id"] == line.id and payload["product"] == "Pipe"
    assert payload["from"]["choices"] == [["Tail", "straight"]]
    assert payload["to"]["choices"] == [["Tail", "angled"]]


@pytest.mark.asyncio
async def test_a_count_equal_to_the_standard_is_not_stored(db_session, pipe):
    line, flask = pipe["line"], pipe["parts"]["flask"]
    await line_config.set_configuration(db_session, line, choices={}, counts={flask.id: 1}, actor=None)
    assert await _counts(db_session, line.id) == {}
    await line_config.set_configuration(db_session, line, choices={}, counts={flask.id: 2}, actor=None)
    assert await _counts(db_session, line.id) == {flask.id: 2}
    assert line.config_key.endswith(f"|{flask.id}=2")


@pytest.mark.asyncio
async def test_foreign_option_or_part_is_422(db_session, pipe):
    other = Product(name="Other")
    db_session.add(other)
    await db_session.flush()
    other_group, (other_option,) = await _group(db_session, other, "X", ["x"])
    other_part = ProductPart(product_id=other.id, kind="printed", name="o", name_key="o", qty_per_unit=1)
    db_session.add(other_part)
    await db_session.flush()
    line = pipe["line"]
    for kwargs in (
        {"choices": {other_group.id: other_option.id}, "counts": {}},
        {"choices": {pipe["group"].id: other_option.id}, "counts": {}},
        {"choices": {}, "counts": {other_part.id: 1}},
        {"choices": {}, "counts": {pipe["parts"]["flask"].id: 10000}},
    ):
        with pytest.raises(line_config.LineConfigError) as err:
            await line_config.set_configuration(db_session, line, actor=None, **kwargs)
        assert err.value.status == 422


@pytest.mark.asyncio
async def test_a_parts_line_needs_a_part(db_session, pipe):
    line = ProjectLine(project_id=pipe["line"].project_id, product_id=pipe["product"].id, quantity=1, mode="parts")
    db_session.add(line)
    await db_session.flush()
    with pytest.raises(line_config.LineConfigError) as err:
        await line_config.seed_line(db_session, line, choices=None, counts={pipe["parts"]["flask"].id: 0})
    assert err.value.status == 422
    await line_config.seed_line(db_session, line, choices=None, counts={pipe["parts"]["angled"].id: 3})
    assert await _choices(db_session, line.id) == {}
    assert line.config_key == f"parts:{pipe['parts']['angled'].id}=3"


@pytest.mark.asyncio
async def test_the_reservation_moves_to_the_new_configuration(db_session, pipe):
    line, parts = pipe["line"], pipe["parts"]
    for name, qty in (("flask", 5), ("straight", 5), ("angled", 2)):
        await part_stock.move(db_session, part_id=parts[name].id, delta=qty, reason="manual", note="counted")
    assert await part_stock.reserve_for_line(db_session, line, 4) == 4
    outcome = await line_config.set_configuration(
        db_session, line, choices={pipe["group"].id: pipe["angled"].id}, counts={}, actor=None
    )
    assert (outcome.reserved_before, outcome.reserved_after) == (4, 2)
    balances = await part_stock.balances(db_session, pipe["product"].id)
    assert balances[parts["straight"].id] == 5
    assert balances[parts["angled"].id] == 0
    assert balances[parts["flask"].id] == 3


@pytest.mark.asyncio
async def test_dry_run_reports_printed_and_queued_of_parts_that_drop(db_session, pipe):
    line = pipe["line"]
    file = LibraryFile(
        filename="t.gcode.3mf",
        file_path="t",
        file_size=1,
        file_type="gcode",
        file_metadata={"plates": [{"index": 1, "printable_objects": {"1": "straight"}, "print_time_seconds": 60}]},
    )
    db_session.add(file)
    await db_session.flush()
    db_session.add(ProductPlate(product_id=pipe["product"].id, library_file_id=file.id, plate_index=0))
    archive = PrintArchive(
        project_id=line.project_id,
        project_line_id=line.id,
        library_file_id=file.id,
        plate_index=1,
        filename="t",
        file_path="",
        file_size=0,
        status="completed",
        quantity=1,
    )
    db_session.add(archive)
    await db_session.flush()
    db_session.add(PrintArchivePart(archive_id=archive.id, name="straight", name_key="straight", quantity=3))
    queue = PrinterQueue(id=1, printer_id=1)
    db_session.add(queue)
    await db_session.flush()
    db_session.add(
        PrintQueueItem(
            queue_id=queue.id,
            project_id=line.project_id,
            project_line_id=line.id,
            library_file_id=file.id,
            plate_id=1,
            status="pending",
        )
    )
    await db_session.commit()
    before_key = line.config_key
    outcome = await line_config.set_configuration(
        db_session, line, choices={pipe["group"].id: pipe["angled"].id}, counts={}, actor=None, dry_run=True
    )
    dropped = {d.name: (d.per_before, d.per_after, d.printed, d.queued) for d in outcome.dropping}
    assert dropped == {"straight": (1, 0, 3, 1)}
    assert line.config_key == before_key
    assert await _choices(db_session, line.id) == {pipe["group"].id: pipe["straight"].id}
    assert (await db_session.execute(select(ProjectEvent))).scalars().all() == []


@pytest.mark.asyncio
async def test_a_new_group_is_written_into_existing_lines(db_session, pipe):
    group, (_black, white) = await _group(db_session, pipe["product"], "Colour", ["black", "white"], default_index=1)
    touched = await line_config.add_group_to_lines(db_session, group)
    assert touched == 1
    line = pipe["line"]
    assert (await _choices(db_session, line.id))[group.id] == white.id
    assert line.config_key == ";".join(
        f"{gid}={oid}" for gid, oid in sorted((await _choices(db_session, line.id)).items())
    )


@pytest.mark.asyncio
async def test_forget_part_and_line_remove_their_rows(db_session, pipe):
    line, flask = pipe["line"], pipe["parts"]["flask"]
    await line_config.set_configuration(db_session, line, choices={}, counts={flask.id: 2}, actor=None)
    await line_config.forget_part(db_session, flask.id)
    assert await _counts(db_session, line.id) == {}
    assert "|" not in line.config_key
    await line_config.forget_line(db_session, line.id)
    assert await _choices(db_session, line.id) == {}
