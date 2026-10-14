"""A job's incarnation for the declaration refresh's CAS; sources have none (T9 spec r3 §3; plan T9.1).

A queue job and an AutoQueue item get a ``swap_declaration_identity`` when they are created -- a new one for a
clone, a promotion, a reused integer id -- and keep it across ordinary updates. Archives and library files do not
have one: their equality is content-bound. The audit of a declaration outlives the source it names.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy import select

from backend.app.models.archive import PrintArchive
from backend.app.models.auto_queue import AutoQueueItem
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.models.printer_queue import PrinterQueue

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]


async def a_queue(db) -> PrinterQueue:
    printer = Printer(name="P", serial_number="00M09I000000001", ip_address="192.0.2.5", access_code="12345678")
    db.add(printer)
    await db.flush()
    queue = PrinterQueue(id=printer.id, printer_id=printer.id, status="idle")
    db.add(queue)
    await db.flush()
    return queue


async def test_a_job_is_born_with_an_identity_it_keeps_and_a_clone_gets_its_own(db_session):
    from backend.app.services.queue_ops import clone_item

    queue = await a_queue(db_session)
    job = PrintQueueItem(queue_id=queue.id, status="pending", position=1)
    db_session.add(job)
    await db_session.commit()
    born = job.swap_declaration_identity
    assert born and len(born) == 36

    job.position = 7
    await db_session.commit()
    await db_session.refresh(job)
    assert job.swap_declaration_identity == born

    second = Printer(name="Q", serial_number="00M09I000000002", ip_address="192.0.2.6", access_code="12345678")
    db_session.add(second)
    await db_session.flush()
    elsewhere = PrinterQueue(id=second.id, printer_id=second.id, status="idle")
    db_session.add(elsewhere)
    await db_session.flush()
    job.queue_id = elsewhere.id  # a move is the same job
    await db_session.commit()
    await db_session.refresh(job)
    assert job.swap_declaration_identity == born

    copy = await clone_item(db_session, job.id)
    await db_session.commit()
    assert copy.swap_declaration_identity and copy.swap_declaration_identity != born


async def test_a_reused_integer_id_is_another_job(db_session):
    queue = await a_queue(db_session)
    job = PrintQueueItem(queue_id=queue.id, status="pending", position=1, started_at=None)
    db_session.add(job)
    await db_session.commit()
    job_id, before = job.id, job.swap_declaration_identity
    await db_session.delete(job)
    await db_session.commit()

    again = PrintQueueItem(id=job_id, queue_id=queue.id, status="pending", position=1)
    db_session.add(again)
    await db_session.commit()

    assert again.id == job_id and again.swap_declaration_identity != before


async def test_an_auto_queue_item_has_its_own_identity(db_session):
    item = AutoQueueItem(status="pending", target_model="P1S")
    db_session.add(item)
    await db_session.commit()

    assert item.swap_declaration_identity and len(item.swap_declaration_identity) == 36


async def test_sources_carry_no_identity_column():
    assert "swap_declaration_identity" not in PrintArchive.__table__.c
    assert "swap_declaration_identity" not in LibraryFile.__table__.c
    assert "swap_source_declaration" in PrintArchive.__table__.c
    assert "swap_source_declaration" in LibraryFile.__table__.c


async def test_the_audit_outlives_the_source_it_names(db_session):
    from backend.app.models.swap_source_declaration_audit import SwapSourceDeclarationAudit

    archive = PrintArchive(filename="a.3mf", file_path="", file_size=0, status="completed")
    db_session.add(archive)
    await db_session.flush()
    db_session.add(
        SwapSourceDeclarationAudit(
            operation_id="9b2f1c7e-0d1a-4c7e-9c2a-3f4b5d6e7f80",
            action="declare",
            source_kind="archive",
            source_id=archive.id,
            sha256="ab" * 32,
            old_value=None,
            new_value=True,
            declaration_id="1b4e28ba-2fa1-41d2-883f-0016d3cca427",
            actor_label="admin",
            actor_kind="user",
            created_at=datetime.now(timezone.utc),
        )
    )
    await db_session.commit()
    source_id = archive.id
    await db_session.delete(archive)
    await db_session.commit()

    rows = (await db_session.execute(select(SwapSourceDeclarationAudit))).scalars().all()
    assert [(row.source_kind, row.source_id) for row in rows] == [("archive", source_id)]
