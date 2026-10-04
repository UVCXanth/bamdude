"""A reprint's new archive is filed where the JOB says, not where the source print was
(WS-13 E13 O10, Q-07).

The route decides the link — the source's order inherited by default (asked with the filing
right and an open order), or none with ``keep_order=false`` — and the claim row and the job
carry it. The dispatcher used to take the SOURCE archive's order instead: a reprint without
the order was filed under it anyway, and a queue row filed under order A from an archive of
order B printed into B.
"""

import pytest

from backend.app.models.archive import PrintArchive
from backend.app.models.product import Product
from backend.app.models.project import Project
from backend.app.models.project_line import ProjectLine
from backend.tests.integration.test_reprint_creates_new_archive import run_reprint

pytestmark = pytest.mark.integration


async def _order(db, name: str) -> tuple[int, int]:
    product = Product(name=f"{name} lamp")
    order = Project(name=name)
    db.add_all([product, order])
    await db.flush()
    line = ProjectLine(project_id=order.id, product_id=product.id, quantity=1)
    db.add(line)
    await db.commit()
    return order.id, line.id


async def _new_archive(db, ran) -> PrintArchive:
    db.expire_all()
    return await db.get(PrintArchive, ran["job"].outcome["archive_id"])


@pytest.mark.asyncio
async def test_the_job_without_an_order_files_the_reprint_under_none(
    db_session, test_engine, tmp_path, monkeypatch, printer_factory
):
    source = await _order(db_session, "Source order")
    ran = await run_reprint(
        db_session,
        test_engine,
        tmp_path,
        monkeypatch,
        printer_factory,
        source_project_id=source[0],
        source_line_id=source[1],
    )
    new = await _new_archive(db_session, ran)
    assert (new.project_id, new.project_line_id) == (None, None)


@pytest.mark.asyncio
async def test_the_job_files_the_reprint_under_its_own_order(
    db_session, test_engine, tmp_path, monkeypatch, printer_factory
):
    source = await _order(db_session, "Order B")
    target = await _order(db_session, "Order A")
    ran = await run_reprint(
        db_session,
        test_engine,
        tmp_path,
        monkeypatch,
        printer_factory,
        source_project_id=source[0],
        source_line_id=source[1],
        job_project_id=target[0],
        job_line_id=target[1],
    )
    new = await _new_archive(db_session, ran)
    assert (new.project_id, new.project_line_id) == target
