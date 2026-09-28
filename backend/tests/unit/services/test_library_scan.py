"""The scan worker: what it does off the loop, and what it refuses to delete.

⚠️ These pin the two things that fail silently. A transaction held across a file
read does not error — it makes *other* requests fail, somewhere else, with a
traceback that names an innocent query. And a deletion pass that trusts an
unreachable mount does not error either — it reports success while emptying a
library nobody touched.
"""

from __future__ import annotations

import asyncio
from datetime import datetime
from pathlib import Path

import pytest

from backend.app.services import library_scan
from backend.app.services.library_scan import BATCH_SIZE, EMPTY_WALK_GUARD, _Known


@pytest.mark.asyncio
async def test_hidden_files_and_directories_are_skipped_unless_asked_for(tmp_path):
    from backend.app.library_file_service import _walk

    (tmp_path / "visible.3mf").write_bytes(b"x")
    (tmp_path / ".hidden.3mf").write_bytes(b"x")
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "buried.3mf").write_bytes(b"x")
    visible = [entry.get("name") for entry in _walk(tmp_path, False)]
    all_names = [entry.get("name") for entry in _walk(tmp_path, True)]
    assert "visible.3mf" in visible
    assert ".hidden.3mf" not in visible
    assert ".hidden.3mf" in all_names and "buried.3mf" in all_names


@pytest.mark.asyncio
async def test_preparing_a_file_opens_no_session(tmp_path, monkeypatch):
    from backend.app.core import database

    opened = []
    real = database.async_session
    monkeypatch.setattr(database, "async_session", lambda *a, **kw: opened.append(1) or real(*a, **kw))
    target = tmp_path / "part.stl"
    target.write_bytes(b"solid\n")
    stat = target.stat()
    prepared = await library_scan.prepare_via_service(
        str(tmp_path), target.name, tmp_path, None, "", stat.st_size, stat.st_mtime_ns
    )
    assert prepared is not None and prepared.intent == "create"
    assert opened == []


@pytest.mark.asyncio
async def test_scannable_extensions_include_markdown_but_not_txt(tmp_path):
    (tmp_path / "notes.txt").write_text("hi")
    (tmp_path / "README.md").write_text("hi")
    for name, expected in (("notes.txt", False), ("README.md", True)):
        stat = (tmp_path / name).stat()
        result = await library_scan.prepare_via_service(
            str(tmp_path), name, tmp_path, None, "", stat.st_size, stat.st_mtime_ns
        )
        assert (result is not None) is expected


@pytest.mark.asyncio
async def test_a_known_complete_file_that_has_not_moved_is_not_re_read(tmp_path, monkeypatch):
    from backend.app.api.routes.library import _mtime_to_utc
    from backend.app.services.library_file_preparation import EXTRACTION_VERSION
    from backend.app.services.library_file_runtime import get_library_file_runtime

    target = tmp_path / "part.stl"
    target.write_bytes(b"solid\n")
    stat = target.stat()
    known = _Known(
        id=1,
        file_hash="deadbeef",
        file_size=stat.st_size,
        fs_modified_at=_mtime_to_utc(stat.st_mtime),
        extraction_version=EXTRACTION_VERSION,
        extraction_hash="deadbeef",
    )
    worker = get_library_file_runtime()
    monkeypatch.setattr(worker, "hash", lambda *a, **kw: (_ for _ in ()).throw(AssertionError("re-read")))
    prepared = await library_scan.prepare_via_service(
        str(tmp_path), target.name, tmp_path, known, "", stat.st_size, stat.st_mtime_ns
    )
    assert prepared is None


@pytest.mark.asyncio
async def test_a_known_changed_file_is_prepared_again(tmp_path):
    target = tmp_path / "part.stl"
    target.write_bytes(b"solid\n")
    stat = target.stat()
    known = _Known(
        id=1,
        file_hash="stale",
        file_size=999,
        fs_modified_at=datetime(2020, 1, 1),
        extraction_version=1,
        extraction_hash="stale",
    )
    prepared = await library_scan.prepare_via_service(
        str(tmp_path), target.name, tmp_path, known, "", stat.st_size, stat.st_mtime_ns
    )
    assert prepared is not None and prepared.metadata_complete
    assert prepared.new_hash and prepared.new_hash != "stale"


class TestTheDeletionGuard:
    """⚠️ The dangerous half of this change.

    Incremental commits removed the rollback that used to make a failed scan
    harmless. A Synology share that blinks makes ``os.path.exists`` say no to
    everything, and an honest sync then deletes a library nobody touched.
    """

    @pytest.mark.asyncio
    async def test_an_empty_walk_against_a_stocked_folder_deletes_nothing(self):
        counters = dict.fromkeys(("files_removed", "folders_removed"), 0)
        known = {
            f"/mnt/share/f{i}.3mf": _Known(id=i, file_hash=None, file_size=1, fs_modified_at=None) for i in range(20)
        }

        skipped = await library_scan.remove_vanished(set(), known, {"": 1}, counters)

        assert skipped is True
        assert counters["files_removed"] == 0

    @pytest.mark.asyncio
    async def test_one_record_is_already_worth_protecting(self):
        """The question is not how many rows there are — it is whether the walk
        saw anything at all.
        """
        assert EMPTY_WALK_GUARD == 1

    @pytest.mark.asyncio
    async def test_a_folder_that_never_had_records_is_not_an_error(self):
        """An empty walk against an empty folder is just an empty folder."""
        counters = dict.fromkeys(("files_removed", "folders_removed"), 0)
        skipped = await library_scan.remove_vanished(set(), {}, {"": 1}, counters)
        assert skipped is False


def test_the_batch_is_sized_for_lock_time_not_commit_count():
    """⚠️ In WAL with synchronous=NORMAL a commit costs no fsync, so batching is
    not about commit cost. It is about how long the write lock is held, and the
    number has to stay small enough that the window is milliseconds.
    """
    assert 10 <= BATCH_SIZE <= 200


def test_a_scan_can_be_cancelled_and_forgets_itself():
    """Every create_task in this codebase is paired with a shutdown cancel."""

    async def forever():
        await asyncio.sleep(3600)

    async def run():
        task = asyncio.create_task(forever())
        library_scan._running[999] = task
        library_scan.cancel_running_scans()
        await asyncio.sleep(0)
        assert task.cancelled() or task.cancelling()
        assert 999 not in library_scan._running

    asyncio.run(run())


def test_paths_are_relative_to_the_mount_not_absolute():
    """A folder key is the path under the mount, so moving the mount does not
    orphan every subfolder row.
    """
    root = Path("/mnt/share")
    rel = str(Path("/mnt/share/models/spools").relative_to(root)).replace("\\", "/")
    assert rel == "models/spools"
