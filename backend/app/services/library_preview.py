"""Main-only preview publication. The service never sees a DB or final path."""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import shutil
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.models.library import LibraryFile
from backend.app.services.mesh_preview_types import CAD_TYPES
from backend.app.services.preview_artifacts import disk, owned
from backend.app.services.preview_protocol import PREVIEW_OWNER
from backend.app.services.preview_runtime import preview_attempt

logger = logging.getLogger(__name__)

#: what one attach did (spec §5): attached; superseded (the CAS matched no row: trash, new bytes or type, a newer
#: picture); unavailable (the PNG could not be written, or the commit's outcome is unknown); authority_missing
ATTACH_RESULTS = ("attached", "superseded", "unavailable", "authority_missing")


class _Lease:
    def __init__(self, gate: PublicationGate):
        self._gate = gate

    def release(self) -> None:
        gate, self._gate = self._gate, None
        if gate is not None:
            gate._released()


class PublicationGate:
    """Every library preview publication in main holds a lease from its hand-off to the end of its attach. A
    restore closes the gate -- a result reaching its hand-off afterwards is revoked -- and waits for the leases
    already given to drain before any file or database is replaced (spec §4.3, §5). Closed for good: a restore
    is followed by a restart."""

    def __init__(self):
        self.open = True
        self.leases = 0
        self._idle = asyncio.Event()
        self._idle.set()

    def acquire(self) -> _Lease | None:
        if not self.open:
            return None
        self.leases += 1
        self._idle.clear()
        return _Lease(self)

    def _released(self) -> None:
        self.leases -= 1
        if self.leases == 0:
            self._idle.set()

    def close(self) -> None:
        self.open = False

    async def drain(self, timeout: float) -> bool:
        """True once no lease is held; False after ``timeout`` with one still held (no proof)."""
        try:
            await asyncio.wait_for(self._idle.wait(), timeout)
        except TimeoutError:
            return False
        return self.leases == 0


publication = PublicationGate()


@dataclass(frozen=True)
class Source:
    id: int
    filename: str
    file_type: str
    file_path: str
    file_hash: str | None
    thumbnail_path: str | None
    fs_modified_at: datetime | None

    @classmethod
    def capture(cls, row: LibraryFile):
        return cls(**{name: getattr(row, name) for name in cls.__dataclass_fields__})


def _publish(source: Path, target: Path):
    temporary = target.with_suffix(".part")
    try:
        with source.open("rb") as reader, temporary.open("xb") as writer:
            shutil.copyfileobj(reader, writer, 128 * 1024)
            writer.flush()
            os.fsync(writer.fileno())
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


async def attach_result(db: AsyncSession, source: Source, png: Path, *, authorize=None) -> str:
    """Own a fresh short transaction; never commit the caller's pending work. The CAS -- live row, same path,
    bytes, type, mtime and picture -- and, when given, ``authorize(session)`` (the actor's rights read again) run
    inside that one transaction before the write. Returns one of ATTACH_RESULTS."""
    from backend.app.api.routes.library import get_library_thumbnails_dir, to_relative_path

    factory = async_sessionmaker(db.bind, expire_on_commit=False)
    try:
        final = get_library_thumbnails_dir() / f"{uuid.uuid4().hex}.png"
        relative = to_relative_path(final)
        await disk(_publish, png, final)
    except OSError:
        logger.warning("Preview picture could not be written for library file %s", source.id)
        return "unavailable"  # a publication failure, never file_missing: the source was read

    async def finish():
        outcome = "unavailable"
        try:
            async with factory() as session:
                if authorize is not None and not await authorize(session):
                    outcome = "authority_missing"
                else:
                    result = await session.execute(
                        update(LibraryFile)
                        .where(
                            LibraryFile.id == source.id,
                            LibraryFile.deleted_at.is_(None),
                            LibraryFile.file_type == source.file_type,
                            LibraryFile.file_path == source.file_path,
                            LibraryFile.file_hash == source.file_hash,
                            LibraryFile.fs_modified_at == source.fs_modified_at,
                            LibraryFile.thumbnail_path == source.thumbnail_path,
                        )
                        .values(thumbnail_path=relative)
                        .execution_options(synchronize_session=False)
                    )
                    await session.commit()
                    outcome = "attached" if result.rowcount == 1 else "superseded"
        except Exception:
            logger.warning("Preview attachment uncertain for library file %s", source.id)
        # Includes trash: a concurrently trashed row is still a durable owner.
        try:
            async with factory() as session:
                referenced = await session.scalar(
                    select(LibraryFile.id).where(LibraryFile.thumbnail_path == relative).limit(1)
                )
            if referenced is None:
                await disk(final.unlink, True)
        except Exception:
            logger.warning("Retaining preview with unknown durable reference for library file %s", source.id)
        return outcome

    return await owned(finish())


async def attach(db: AsyncSession, source: Source, png: Path) -> bool:
    """The existing callers' answer: attached or not."""
    return await attach_result(db, source, png) == "attached"


async def generate(db: AsyncSession, source: Source) -> bool:
    from backend.app.api.routes.library import to_absolute_path

    path = to_absolute_path(source.file_path)
    if path is None:
        return False
    # The kind is the row's file_type (a rename never changes it), never the display name's suffix.
    owner = PREVIEW_OWNER.set(f"file={source.id}")  # the attempt's log lines name the file it serves
    try:
        return await _generate(db, source, path)
    finally:
        PREVIEW_OWNER.reset(owner)


async def _generate(db: AsyncSession, source: Source, path: Path) -> bool:
    async with preview_attempt({"mesh": (path, source.file_type)}, publication=publication) as result:
        png = result.files.get("preview")
        if not png or result.outcome != "ok":
            return False
        # Snapshot digest binds this result to the DB source, not merely its name; a STEP needs that binding.
        digest = result.input_digests.get("mesh")
        if (source.file_hash or source.file_type in CAD_TYPES) and digest != source.file_hash:
            return False
        return await attach_result(db, source, png) == "attached"


async def sliced_preview(
    db: AsyncSession, content: bytes, *, model_bytes: bytes | None = None, source: Source | None = None
) -> bytes:
    from backend.app.api.routes.library import to_absolute_path

    inputs = {"sliced": (content, "3mf")}
    if source and model_bytes is not None and source.filename.lower().endswith(".stl"):
        # The immutable bytes are exactly what went to the slicer. Never render
        # a newly replaced library path for an already finished old slice.
        digest = await disk(lambda: hashlib.sha256(model_bytes).hexdigest())
        if source.file_hash == digest:
            inputs["mesh"] = (model_bytes, "stl")
            if source.thumbnail_path:
                png = to_absolute_path(source.thumbnail_path)
                if png and await disk(png.is_file):
                    inputs["source_png"] = (png, "png")
        else:
            source = None
    async with preview_attempt(inputs, publication=publication) as result:
        if source and "preview" in result.files:
            try:
                await attach_result(db, source, result.files["preview"])
            except Exception:
                logger.warning("Source preview attachment skipped for library file %s", source.id)
        output = result.files.get("output") or result.files.get("checkpoint")
        try:
            return await disk(output.read_bytes) if output else content
        except OSError:
            return content
