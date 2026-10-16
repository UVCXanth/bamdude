"""A backup restore arriving while a STEP picture is being published (spec §4.3, plan A5): the real restore route,
FileRestore and the database swap, in a fresh process whose DATA_DIR holds only test files. Prints one JSON report.

The library holds one STEP file with no picture; the backup is taken of exactly that. Then a real STEP conversion
runs and its publication is held at the attach, inside the lease. The restore must wait for that publication before
any file work, and afterwards the library must be the backup's: no picture on the row, no PNG left behind, the
publication closed until the restart the restore asks for.
"""

import asyncio
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "step" / "authored" / "box_mm.step"


async def main(out_dir: Path) -> dict:
    from fastapi import UploadFile

    from backend.app.api.routes.library import get_library_thumbnails_dir, to_relative_path
    from backend.app.api.routes.settings import create_backup_zip, restore_backup
    from backend.app.core import database
    from backend.app.core.config import settings
    from backend.app.models.library import LibraryFile
    from backend.app.services import library_preview
    from backend.app.services.library_preview import Source
    from backend.app.services.preview_runtime import start_preview_runtime, stop_preview_runtime

    report: dict = {}
    try:
        await database.init_db()
        library = settings.library_dir
        library.mkdir(parents=True, exist_ok=True)
        step = library / "box.step"
        shutil.copyfile(FIXTURE, step)
        async with database.async_session() as db:
            row = LibraryFile(
                filename="box.step",
                file_path=to_relative_path(step),
                file_type="step",
                file_size=step.stat().st_size,
                file_hash=hashlib.sha256(step.read_bytes()).hexdigest(),
                thumbnail_path=None,
            )
            db.add(row)
            await db.commit()
            source = Source.capture(row)
        backup, _ = await create_backup_zip(out_dir)  # the library as it is: one STEP, no picture
        (library / "after-backup.bin").write_bytes(b"old")  # the restore must take this away

        await start_preview_runtime(Path(settings.base_dir), Path(os.environ["BAMDUDE_STEP_TEST_APP_DIR"]))
        attaching, release = asyncio.Event(), asyncio.Event()
        real = library_preview.attach_result

        async def held(db, src, png, **kwargs):
            attaching.set()
            await release.wait()  # inside the lease: the hand-off happened, the publication is in flight
            return await real(db, src, png, **kwargs)

        library_preview.attach_result = held

        async def publish():
            async with database.async_session() as db:
                return await library_preview.generate(db, source)

        task = asyncio.create_task(publish())
        await asyncio.wait_for(attaching.wait(), 300)
        async with database.async_session() as db:
            with backup.open("rb") as stream:
                restore = asyncio.create_task(
                    restore_backup(file=UploadFile(file=stream, filename="backup.zip"), db=db, _=None)
                )
                await asyncio.sleep(1.5)
                report["restore_waited_for_the_publication"] = not restore.done()
                report["no_file_work_before_it"] = (library / "after-backup.bin").exists()
                release.set()
                report["publication_in_flight_completed"] = await task
                response = await restore
        report["restored"] = isinstance(response, dict) and response.get("success") is True
        library_preview.attach_result = real
        async with database.async_session() as db:
            row = await db.get(LibraryFile, source.id)
            report["thumbnail_path"] = row.thumbnail_path
            report["pngs"] = sorted(p.name for p in get_library_thumbnails_dir().glob("*.png"))
            report["old_file_gone"] = not (library / "after-backup.bin").exists()
            report["step_restored"] = step.is_file()
            report["publication_after_restore"] = await library_preview.generate(db, Source.capture(row))
        report["pngs_after"] = sorted(p.name for p in get_library_thumbnails_dir().glob("*.png"))
        report["dialect"] = database.engine.dialect.name
        return report
    finally:
        await stop_preview_runtime()
        await database.engine.dispose()


if __name__ == "__main__":
    print(json.dumps(asyncio.run(main(Path(sys.argv[1])))))
