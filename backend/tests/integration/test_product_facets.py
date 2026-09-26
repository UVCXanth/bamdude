"""Stored plate facets follow the plate writer (spec workshop-product-catalog, rules 3–7)."""

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import selectinload

from backend.app.migrations import m188_order_stage_journal as m188
from backend.app.models.library import LibraryFile
from backend.app.models.product import Product, ProductFacet
from backend.app.services import product_facets
from backend.app.services.product_delete import delete_product
from backend.app.services.product_sync import purge_file_product_links, sync_product_for_file

pytestmark = pytest.mark.integration

PETG = {
    "sliced_for_model": "P1S",
    "plates": [{"index": 1, "printable_objects": {"1": "a.stl"}, "filaments": [{"type": "petg", "color": "#ff0000"}]}],
}
PLA = {
    "sliced_for_model": "Bambu Lab X1 Carbon",
    "plates": [{"index": 1, "printable_objects": {"1": "b.stl"}, "filaments": [{"type": "PLA", "color": "#00ff00"}]}],
}


async def _file(db, name, meta):
    f = LibraryFile(filename=name, file_path=name, file_size=1, file_type="gcode", file_metadata=meta)
    db.add(f)
    await db.flush()
    return f


async def _product(db, name):
    p = Product(name=name)
    db.add(p)
    await db.flush()
    return p


async def _facets(db, product_id):
    rows = (
        await db.execute(select(ProductFacet.kind, ProductFacet.value).where(ProductFacet.product_id == product_id))
    ).all()
    return {(kind, value) for kind, value in rows}


@pytest.mark.asyncio
async def test_linking_and_unlinking_files_moves_the_facets(db_session):
    p = await _product(db_session, "Lamp")
    a, b = await _file(db_session, "a.gcode.3mf", PETG), await _file(db_session, "b.gcode.3mf", PLA)
    await sync_product_for_file(db_session, library_file_id=a.id, product_ids=[p.id])
    await sync_product_for_file(db_session, library_file_id=b.id, product_ids=[p.id])
    assert await _facets(db_session, p.id) == {
        ("material", "PETG"),
        ("material", "PLA"),
        ("color", "#FF0000"),
        ("color", "#00FF00"),
        ("model", "P1S"),
        ("model", "X1C"),
    }
    await sync_product_for_file(db_session, library_file_id=b.id, product_ids=[])  # unlink one file
    assert await _facets(db_session, p.id) == {("material", "PETG"), ("color", "#FF0000"), ("model", "P1S")}
    await purge_file_product_links(db_session, [a.id])
    assert await _facets(db_session, p.id) == set()


@pytest.mark.asyncio
async def test_a_refresh_twice_in_one_session_does_not_collide(db_session):
    # The ORM identity map holds rows a reader loaded; the writer must still
    # replace them in the same session.
    p = await _product(db_session, "Twice")
    f = await _file(db_session, "t.gcode.3mf", PETG)
    await sync_product_for_file(db_session, library_file_id=f.id, product_ids=[p.id])
    (await db_session.execute(select(ProductFacet))).scalars().all()
    await product_facets.refresh(db_session, [p.id])
    await product_facets.refresh(db_session, [p.id])
    assert await _facets(db_session, p.id) == {("material", "PETG"), ("color", "#FF0000"), ("model", "P1S")}


@pytest.mark.asyncio
async def test_a_deleted_product_takes_its_facets(db_session):
    p = await _product(db_session, "Gone")
    f = await _file(db_session, "c.gcode.3mf", PETG)
    await sync_product_for_file(db_session, library_file_id=f.id, product_ids=[p.id])
    # delete_product needs the links loaded, as its callers load them.
    p = (
        await db_session.execute(
            select(Product)
            .where(Product.id == p.id)
            .options(selectinload(Product.library_files), selectinload(Product.library_folders))
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    await delete_product(db_session, p)
    await db_session.flush()
    assert (await db_session.execute(select(ProductFacet.product_id))).all() == []


@pytest.mark.asyncio
async def test_the_seed_fills_existing_products(db_session, test_engine):
    p = await _product(db_session, "Seeded")
    f = await _file(db_session, "s.gcode.3mf", PLA)
    await sync_product_for_file(db_session, library_file_id=f.id, product_ids=[p.id])
    await product_facets.delete_for_product(db_session, p.id)
    await db_session.commit()
    assert await _facets(db_session, p.id) == set()

    await m188.seed(async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False))

    assert await _facets(db_session, p.id) == {("material", "PLA"), ("color", "#00FF00"), ("model", "X1C")}


@pytest.mark.asyncio
async def test_each_row_remembers_the_file_it_came_from(db_session):
    p = await _product(db_session, "Two files")
    a, b = await _file(db_session, "x.gcode.3mf", PETG), await _file(db_session, "y.gcode.3mf", PETG)
    for f in (a, b):
        await sync_product_for_file(db_session, library_file_id=f.id, product_ids=[p.id])
    rows = (
        await db_session.execute(
            select(ProductFacet.library_file_id).where(ProductFacet.product_id == p.id, ProductFacet.kind == "material")
        )
    ).scalars()
    assert sorted(rows) == sorted([a.id, b.id])


@pytest.mark.asyncio
async def test_refresh_all_works_in_chunks(db_session, monkeypatch):
    monkeypatch.setattr(product_facets, "SQL_CHUNK", 1)
    ids = []
    for n in range(3):
        p = await _product(db_session, f"P{n}")
        f = await _file(db_session, f"c{n}.gcode.3mf", PLA)
        await sync_product_for_file(db_session, library_file_id=f.id, product_ids=[p.id])
        await product_facets.delete_for_product(db_session, p.id)
        ids.append(p.id)
    await product_facets.refresh_all(db_session)
    for pid in ids:
        assert await _facets(db_session, pid) == {("material", "PLA"), ("color", "#00FF00"), ("model", "X1C")}
