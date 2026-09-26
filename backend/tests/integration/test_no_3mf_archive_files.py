"""The files of an archive with no 3MF: where they go, where they are found,
and that they leave with the row (audit 1.2.5.3-1.2.5.6, D14).

Such an archive's folder is ``archive/no_source/<id>/``. It used to be
``archive/<id>/`` — the namespace of the PRINTER folders
(``archive/<printer id>/<dated folder>/``), so archive 3's files sat in
printer 3's folder, and removing them with the row was not safe. So they were
never removed: a deleted archive left its photos, timelapse and design file
behind.
"""

from __future__ import annotations

import pytest

from backend.app.core.config import settings


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setattr(settings, "base_dir", data)
    monkeypatch.setattr(settings, "archive_dir", data / "archive")
    return data


def _write(path, body: bytes = b"jpg"):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)
    return path


@pytest.mark.asyncio
@pytest.mark.integration
async def test_a_photo_can_be_uploaded_before_the_archive_has_a_folder(
    async_client, printer_factory, archive_factory, data_dir
):
    printer = await printer_factory()
    archive = await archive_factory(printer.id, file_path="")

    response = await async_client.post(
        f"/api/v1/archives/{archive.id}/photos", files={"file": ("result.jpg", b"jpg", "image/jpeg")}
    )

    assert response.status_code == 200, response.text
    name = response.json()["filename"]
    assert (data_dir / "archive" / "no_source" / str(archive.id) / "photos" / name).exists()


@pytest.mark.asyncio
@pytest.mark.integration
async def test_a_photo_taken_before_the_3mf_arrived_is_still_served(
    async_client, db_session, printer_factory, archive_factory, data_dir
):
    """The finish photo is taken at completion; the 3MF can be attached later
    (retry sweep, reconnect). After that the archive's folder is the 3MF's."""
    printer = await printer_factory()
    archive = await archive_factory(printer.id, file_path="", photos=["early.jpg"])
    _write(data_dir / "archive" / "no_source" / str(archive.id) / "photos" / "early.jpg")
    archive.file_path = f"archive/{printer.id}/20260924_120000_job/job.gcode.3mf"
    await db_session.commit()

    response = await async_client.get(f"/api/v1/archives/{archive.id}/photos/early.jpg")

    assert response.status_code == 200
    assert response.content == b"jpg"


@pytest.mark.asyncio
@pytest.mark.integration
async def test_a_photo_in_the_old_per_id_folder_is_still_served(
    async_client, printer_factory, archive_factory, data_dir
):
    printer = await printer_factory()
    archive = await archive_factory(printer.id, file_path="", photos=["old.jpg"])
    _write(data_dir / "archive" / str(archive.id) / "photos" / "old.jpg")

    response = await async_client.get(f"/api/v1/archives/{archive.id}/photos/old.jpg")

    assert response.status_code == 200


@pytest.mark.asyncio
@pytest.mark.integration
async def test_deleting_a_photo_removes_it_wherever_it_was_written(
    async_client, db_session, printer_factory, archive_factory, data_dir
):
    printer = await printer_factory()
    archive = await archive_factory(printer.id, file_path="", photos=["old.jpg"])
    old = _write(data_dir / "archive" / str(archive.id) / "photos" / "old.jpg")

    response = await async_client.delete(f"/api/v1/archives/{archive.id}/photos/old.jpg")

    assert response.status_code == 200, response.text
    assert not old.exists()


@pytest.mark.asyncio
@pytest.mark.integration
async def test_a_hard_delete_takes_the_archives_own_folders_and_nothing_else(
    db_session, printer_factory, archive_factory, data_dir
):
    """``no_source/<id>`` and the old ``<id>/photos`` belong to this archive
    alone; ``archive/<id>/`` itself may be a printer's folder full of other
    archives, and must survive."""
    from backend.app.services.archive import ArchiveService

    printer = await printer_factory()
    archive = await archive_factory(printer.id, file_path="")
    own = _write(data_dir / "archive" / "no_source" / str(archive.id) / "timelapse.mp4")
    old_photos = _write(data_dir / "archive" / str(archive.id) / "photos" / "old.jpg")
    # A printer whose id happens to equal this archive's, with an archive of its own.
    neighbour = _write(data_dir / "archive" / str(archive.id) / "20260924_120000_other" / "other.gcode.3mf")

    assert await ArchiveService(db_session).delete_archive(archive.id) is True

    assert not own.parent.exists()
    assert not old_photos.parent.exists()
    assert neighbour.exists()


@pytest.mark.asyncio
@pytest.mark.integration
async def test_deleting_an_archive_without_a_3mf_raises_no_security_alarm(
    db_session, printer_factory, archive_factory, data_dir, caplog
):
    """An empty ``file_path`` is a normal archive (created at print start, or a
    job that never yields a 3MF), not an attack: its folders go through
    ``_remove_id_owned_folders``. It used to log an ERROR under a SECURITY
    banner on every such delete (upstream #2968)."""
    import logging

    from backend.app.services.archive import ArchiveService

    printer = await printer_factory()
    archive = await archive_factory(printer.id, file_path="")

    with caplog.at_level(logging.INFO, logger="backend.app.services.archive"):
        assert await ArchiveService(db_session).delete_archive(archive.id) is True

    assert not [r for r in caplog.records if "SECURITY" in r.getMessage()]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_a_file_path_one_level_deep_never_takes_a_printer_folder(
    db_session, printer_factory, archive_factory, data_dir
):
    """Every archive folder is two levels deep (``<printer>/<dated folder>/``,
    ``no_source/<id>/``). A row whose ``file_path`` lost a component points at
    ``archive/<printer id>/`` — deleting that folder would take every print the
    printer made (upstream #2968: the depth guard was ``< 1``)."""
    from backend.app.services.archive import ArchiveService

    printer = await printer_factory()
    stray = _write(data_dir / "archive" / str(printer.id) / "lost.gcode.3mf")
    neighbour = _write(data_dir / "archive" / str(printer.id) / "20260924_120000_other" / "other.gcode.3mf")
    archive = await archive_factory(printer.id, file_path=f"archive/{printer.id}/lost.gcode.3mf")

    assert await ArchiveService(db_session).delete_archive(archive.id) is True

    assert neighbour.exists()
    assert stray.exists()
