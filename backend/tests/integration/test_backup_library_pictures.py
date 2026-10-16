"""A backup and a background picture publication (Codex A-R5 / M13): the library is copied strictly, except its
thumbnails subtree, which is copied in a phase of its own, last, under a short pause of the publications — so a STEP
picture attached in the background never fails an ordinary backup, and a real change to any other file still does.

The pause waits for the publications already handed off, holds a new one before its hand-off (no ``.part`` can
appear while the pictures are copied), is lifted on success, error and cancel alike, and never reopens a gate a
restore closed. A pause that cannot drain fails the backup: an incomplete backup is never a success."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from backend.app.services import backup_files as b, library_preview as p


def _library(tmp_path: Path) -> Path:
    library = tmp_path / "library"
    (library / "thumbnails").mkdir(parents=True)
    (library / "model.step").write_bytes(b"unchanged source")
    (library / "thumbnails" / "old.png").write_bytes(b"a picture the database names")
    return library


def test_a_picture_published_while_the_library_is_copied_does_not_fail_the_bulk_copy(tmp_path, monkeypatch):
    library = _library(tmp_path)
    ready = tmp_path / "ready.png"
    ready.write_bytes(b"a finished picture")
    real_copy = b.copy_file

    def copy_then_publish(source, target):
        real_copy(source, target)
        if source.name == "model.step":
            p._publish(ready, library / "thumbnails" / "new.png")

    monkeypatch.setattr(b, "copy_file", copy_then_publish)
    b.copy_library(library, tmp_path / "copy")
    assert (tmp_path / "copy" / "model.step").read_bytes() == b"unchanged source"
    assert not (tmp_path / "copy" / "thumbnails").exists()  # delegated to its own phase, not ignored
    b.stage_library_thumbnails(library, tmp_path / "copy")
    assert sorted(x.name for x in (tmp_path / "copy" / "thumbnails").iterdir()) == ["new.png", "old.png"]


def test_a_real_change_to_another_library_file_still_fails_the_backup(tmp_path, monkeypatch):
    library = _library(tmp_path)
    (library / "other.step").write_bytes(b"x")
    real_copy = b.copy_file

    def copy_then_touch(source, target):
        real_copy(source, target)
        if source.name == "model.step":
            (library / "other.step").write_bytes(b"changed meanwhile")

    monkeypatch.setattr(b, "copy_file", copy_then_touch)
    with pytest.raises(ValueError):
        b.copy_library(library, tmp_path / "copy")


def test_a_library_without_a_thumbnails_dir_copies_and_its_creation_breaks_nothing(tmp_path, monkeypatch):
    library = tmp_path / "library"
    library.mkdir()
    (library / "model.step").write_bytes(b"source")
    real_copy = b.copy_file

    def copy_then_create(source, target):
        real_copy(source, target)
        (library / "thumbnails").mkdir(exist_ok=True)  # the first picture ever, mid-backup

    monkeypatch.setattr(b, "copy_file", copy_then_create)
    b.copy_library(library, tmp_path / "copy")
    b.stage_library_thumbnails(library, tmp_path / "copy")
    assert (tmp_path / "copy" / "thumbnails").is_dir()


@pytest.mark.asyncio
async def test_the_pause_waits_for_a_handed_off_publication_and_holds_a_new_one_before_its_hand_off():
    gate = p.PublicationGate()
    lease = gate.acquire()  # a publication already handed off
    paused = asyncio.Event()

    async def backup():
        async with gate.pause(5):
            paused.set()
            await asyncio.sleep(0.1)

    copy = asyncio.create_task(backup())
    await asyncio.sleep(0.1)
    assert not paused.is_set()  # it waits for the attach in flight
    lease.release()
    await asyncio.wait_for(paused.wait(), 5)
    waiter = asyncio.create_task(gate.until_unpaused())
    await asyncio.sleep(0.02)
    assert not waiter.done() and gate.acquire() is None  # a new hand-off waits; none slips through
    await copy
    await asyncio.wait_for(waiter, 5)
    assert gate.acquire() is not None  # lifted


@pytest.mark.asyncio
async def test_the_pause_is_lifted_on_error_and_cancel_and_never_reopens_a_restore_close():
    gate = p.PublicationGate()
    with pytest.raises(RuntimeError):
        async with gate.pause(1):
            raise RuntimeError("the copy failed")
    lease = gate.acquire()
    assert lease is not None
    lease.release()
    task = asyncio.create_task(_pause_forever(gate))
    await asyncio.sleep(0.05)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    assert not gate.paused()
    gate.close()  # a restore
    async with gate.pause(1):
        pass
    assert gate.acquire() is None  # still closed for good


async def _pause_forever(gate):
    async with gate.pause(1):
        await asyncio.sleep(3600)


@pytest.mark.asyncio
async def test_a_pause_that_cannot_drain_fails_the_backup():
    gate = p.PublicationGate()
    gate.acquire()  # an attach that never ends
    with pytest.raises(p.PublicationBusy):
        async with gate.pause(0.1):
            pass
    assert not gate.paused()


@pytest.mark.asyncio
async def test_the_backup_stages_the_pictures_last_under_the_pause(tmp_path, monkeypatch):
    """The route's staging: everything strictly, the thumbnails subtree last under the pause; a publisher that
    reaches its hand-off meanwhile publishes after it."""
    from backend.app.api.routes import settings as settings_routes

    library = _library(tmp_path)
    order = []
    real_stage = b.stage_library_thumbnails

    def staged(source, staging):
        order.append(("pictures", p.publication.paused()))
        return real_stage(source, staging)

    monkeypatch.setattr(b, "stage_library_thumbnails", staged)
    monkeypatch.setattr(b, "stage_files", lambda settings, data_dir, staging: order.append(("files", None)))
    monkeypatch.setattr(settings_routes.app_settings, "library_dir", library)
    await settings_routes._stage_files_and_pictures(tmp_path, tmp_path / "staging")
    assert order == [("files", None), ("pictures", True)]
    assert not p.publication.paused()
    assert (tmp_path / "staging" / "library" / "thumbnails" / "old.png").is_file()
