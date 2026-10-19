"""One pre-fix snapshot, two readers (T9 spec r3 §2, §8; plan T9.1).

The same queued job whose snapshot predates the declaration, linked to the same library row: the future read --
dispatch through ``item_descriptor`` -- may take the row's §8 answer (the name on the share, an operator's
carrier); the completion's read -- ``swap_terminal.pending_fact`` -- has no historical evidence in either and
stays unknown, so our owed change_table is held, not run. The snapshot itself is not rewritten.
"""

from __future__ import annotations

import pytest

from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.services import swap_compatibility as sc
from backend.tests.integration.swap_terminal_support import (
    CHANGE_TABLE,
    LEGACY,
    an_execution,
    archive_of,
    change_tables_sent,
    give_job_a_snapshot,
    make_rig,  # noqa: F401 -- the fixture
    recover,
)

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]

SHA = "ab" * 32


async def a_library_row(rig, *, path: str, external: bool, value: bool, record: dict | None = None) -> int:
    async with rig.db() as db:
        row = LibraryFile(
            filename="plate.gcode.3mf",  # the display name: never the classifier's input
            file_path=path,
            file_type="gcode",
            file_size=1,
            file_hash=SHA,
            swap_compatible=value,
            is_external=external,
        )
        if record is not None:
            sc.write_source_declaration(row, **record)
        db.add(row)
        await db.commit()
        return row.id


OPERATOR = {
    "value": True,
    "sha256": SHA,
    "origin": "operator",
    "operator": {
        "declaration_id": "1b4e28ba-2fa1-41d2-883f-0016d3cca427",
        "declared_at": "2026-10-14T10:00:00+00:00",
        "actor_id": 1,
        "actor_label": "admin",
        "actor_kind": "user",
    },
}


@pytest.mark.parametrize(
    "source",
    [
        {"path": "/mnt/share/plate.swaps.gcode.3mf", "external": True, "value": False},  # C: the name on the share
        {"path": "library/files/plate.gcode.3mf", "external": False, "value": True, "record": OPERATOR},
    ],
    ids=["classified-by-share-name", "operator-carrier"],
)
async def test_the_future_read_takes_the_rows_answer_and_the_completion_stays_unknown(source, make_rig):
    from backend.app.services import swap_terminal
    from backend.app.services.filament_intake import item_descriptor

    rig = await make_rig(require_plate_clear=False)
    archive_id, item_id = await an_execution(rig, fact=LEGACY, pending=[CHANGE_TABLE], bound=False)
    library_id = await a_library_row(rig, **source)
    await give_job_a_snapshot(rig, item_id, fact="missing", library_file_id=library_id, sha=SHA)

    async with rig.db() as db:
        item = await db.get(PrintQueueItem, item_id)
        future = await item_descriptor(db, item)
        execution = await swap_terminal.pending_fact(db, await db.get(PrintArchive, archive_id), item)
        snapshot = dict(item.source_snapshot)

    assert future.swap_fact.value is True
    assert execution is None
    assert sc.SNAPSHOT_FACT_KEY not in snapshot  # the stored snapshot is not rewritten by either read

    await recover(rig, archive_id)

    assert change_tables_sent(rig) == 0
    assert (await archive_of(rig, archive_id)).extra_data["swap_hold"]["reason"] == "swap_hold_source_unknown"
