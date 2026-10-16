"""File-backed preview transport. Owned I/O is joined even after cancellation."""

from __future__ import annotations

import asyncio
import hashlib
import os
import stat
import threading
import zipfile
from pathlib import Path

from backend.app.services.preview_protocol import (
    CHUNK_BYTES,
    CONTROL_SECONDS,
    OBJECT_BYTES,
    PNG_BYTES,
    PNG_PIXELS,
    ZIP_BYTES,
    Artifact,
    PreviewError,
    remaining,
)


class Revoked(PreviewError):
    """A higher-priority attempt revoked this one at a chunk boundary (spec §4.2). Typed, so the caller ends its
    attempt as internally preempted; on the wire it is a closed ``canceled``."""

    def __init__(self):
        super().__init__("canceled")


def _check(revoke) -> None:
    if revoke is not None and revoke.is_set():
        raise Revoked


async def owned(awaitable):
    task = asyncio.ensure_future(awaitable)
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        # A canceled executor Future does not stop the syscall. Do not release
        # its descriptor, staging or admission slot while it still owns them.
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                continue
            except Exception:
                break
        if not task.cancelled():
            task.exception()
        raise


async def disk(function, *args, **kwargs):
    return await owned(asyncio.to_thread(function, *args, **kwargs))


async def close_transfer(nc, *, seconds: float = CONTROL_SECONDS) -> bool:
    """Close one attempt's private transfer connection, bounded. An object transfer cut short (deadline, cancel)
    can leave both TCP sides blocked — the broker still pushing chunks nobody reads, this client's flow-control
    replies unsent — and a graceful close then waits for the broker's slow-consumer write deadline (~10 s, measured
    on the real chain). After ``seconds`` the socket is aborted: the connection owns no staging and no process, so
    dropping it removes nothing an end-of-attempt proof stands on. Returns whether the graceful close finished."""
    task = asyncio.ensure_future(nc.close())
    done, _ = await asyncio.wait({task}, timeout=seconds)
    graceful = bool(done)
    if not done:
        writer = getattr(getattr(nc, "_transport", None), "_io_writer", None)
        transport = getattr(writer, "transport", None)
        if transport is not None:
            transport.abort()
        done, _ = await asyncio.wait({task}, timeout=seconds)
    if not done:
        task.cancel()
        await asyncio.wait({task}, timeout=seconds)
    if task.done() and not task.cancelled():
        task.exception()  # an aborted socket makes close() raise; retrieved, never left unobserved
    return graceful


def signature(path: Path) -> tuple:
    info = path.stat()
    if not stat.S_ISREG(info.st_mode):
        raise PreviewError("render_failed")
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns


def snapshot(source: Path | bytes, destination: Path, deadline: int, *, revoke=None) -> None:
    before = signature(source) if isinstance(source, Path) else None
    size = before[2] if before else len(source)
    if size > OBJECT_BYTES:
        raise PreviewError("resource_limit")
    with destination.open("xb") as target:
        if isinstance(source, bytes):
            for offset in range(0, len(source), CHUNK_BYTES):
                remaining(deadline)
                _check(revoke)
                target.write(memoryview(source)[offset : offset + CHUNK_BYTES])
                _check(revoke)
        else:
            with source.open("rb") as stream:
                count = 0
                while True:
                    _check(revoke)
                    block = stream.read(CHUNK_BYTES)
                    if not block:
                        break
                    remaining(deadline)
                    count += len(block)
                    if count > OBJECT_BYTES:
                        raise PreviewError("resource_limit")
                    target.write(block)  # the next iteration checks again before reading on
            if signature(source) != before:
                raise PreviewError("render_failed")


def describe(path: Path, attempt: str, role: str, kind: str, deadline: int, *, revoke=None) -> Artifact:
    checksum = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while True:
            _check(revoke)
            block = stream.read(CHUNK_BYTES)
            if not block:
                break
            remaining(deadline)
            size += len(block)
            if size > OBJECT_BYTES:
                raise PreviewError("resource_limit")
            checksum.update(block)
    return Artifact.parse(
        {"role": role, "key": f"{attempt}_{role}", "kind": kind, "size": size, "digest": checksum.hexdigest()}, attempt
    )


def validate(path: Path, kind: str, deadline: int) -> None:
    remaining(deadline)
    if path.stat().st_size > OBJECT_BYTES:
        raise PreviewError("resource_limit")
    if kind == "png":
        from PIL import Image

        if path.stat().st_size > PNG_BYTES:
            raise PreviewError("resource_limit")
        with Image.open(path) as img:
            if img.format != "PNG" or img.width * img.height > PNG_PIXELS:
                raise PreviewError("resource_limit")
            img.verify()
    elif kind == "3mf":
        with zipfile.ZipFile(path) as archive:
            entries = archive.infolist()
            if len(entries) > 10000 or len({x.filename for x in entries}) != len(entries):
                raise PreviewError("resource_limit")
            if sum(x.file_size for x in entries) > ZIP_BYTES:
                raise PreviewError("resource_limit")
            total = 0
            for entry in entries:
                with archive.open(entry) as stream:
                    while block := stream.read(CHUNK_BYTES):
                        remaining(deadline)
                        total += len(block)
                        if total > ZIP_BYTES:
                            raise PreviewError("resource_limit")


def validate_binary_stl(path: Path, triangle_limit: int, deadline: int) -> int:
    """The producer's checks repeated by the consumer before trimesh sees a byte (spec §7.7): header count within
    the cap, exactly 84 + 50·N bytes, every coordinate and normal finite. Returns N."""
    import math
    import struct

    remaining(deadline)
    size = path.stat().st_size
    if size < 84:
        raise PreviewError("render_failed")
    with path.open("rb") as stream:
        stream.seek(80)
        (count,) = struct.unpack("<I", stream.read(4))
        if count == 0 or count > triangle_limit:
            raise PreviewError("resource_limit" if count > triangle_limit else "render_failed")
        if size != 84 + 50 * count:
            raise PreviewError("render_failed")
        record = struct.Struct("<12fH")
        while block := stream.read(50 * 4096):
            remaining(deadline)
            for values in record.iter_unpack(block):
                if not all(math.isfinite(v) for v in values[:12]):
                    raise PreviewError("render_failed")
    return count


class _Reader:
    def __init__(self, stream, deadline: int, revoke=None):
        self.stream, self.deadline, self.revoke = stream, deadline, revoke
        self.count = 0
        self.lock = threading.Lock()

    def readinto(self, buffer):
        with self.lock:
            remaining(self.deadline)
            _check(self.revoke)
            count = self.stream.readinto(buffer)
            self.count += count
            if self.count > OBJECT_BYTES:
                raise PreviewError("resource_limit")
            _check(self.revoke)
            return count

    def close(self):
        with self.lock:
            self.stream.close()


class _Writer:
    def __init__(self, stream, ref: Artifact, deadline: int, revoke=None):
        self.stream, self.ref, self.deadline, self.revoke = stream, ref, deadline, revoke
        self.count = 0
        self.checksum = hashlib.sha256()
        self.lock = threading.Lock()

    def write(self, block):
        with self.lock:
            remaining(self.deadline)
            _check(self.revoke)
            self.count += len(block)
            if self.count > self.ref.size or len(block) > CHUNK_BYTES:
                raise PreviewError("resource_limit")
            self.checksum.update(block)
            written = self.stream.write(block)
            _check(self.revoke)
            return written

    def close(self):
        with self.lock:
            self.stream.close()


async def put(store, path: Path, ref: Artifact, deadline: int, *, revoke=None) -> None:
    from nats.js.api import ObjectMeta, ObjectMetaOptions
    from nats.js.errors import ObjectNotFoundError

    try:
        await store.get_info(ref.key)
    except ObjectNotFoundError:
        pass
    else:
        raise PreviewError("protocol_error")  # immutable, never overwrite
    _check(revoke)
    stream = await disk(path.open, "rb")
    reader = _Reader(stream, deadline, revoke)
    try:
        async with asyncio.timeout(remaining(deadline)):
            await store.put(ref.key, reader, meta=ObjectMeta(options=ObjectMetaOptions(max_chunk_size=CHUNK_BYTES)))
    finally:
        await disk(reader.close)
    remaining(deadline)


async def get(store, ref: Artifact, destination: Path, deadline: int, *, revoke=None) -> None:
    _check(revoke)
    info = await store.get_info(ref.key)
    # nats-py's link branch ignores writeinto; disallow it BEFORE get().
    if info.is_link() or info.size != ref.size:
        raise PreviewError("protocol_error")
    partial = destination.with_suffix(destination.suffix + ".part")
    stream = await disk(partial.open, "xb")
    sink = _Writer(stream, ref, deadline, revoke)
    try:
        async with asyncio.timeout(remaining(deadline)):
            await store.get(ref.key, writeinto=sink)
    finally:
        await disk(sink.close)
    if sink.count != ref.size or sink.checksum.hexdigest() != ref.digest:
        raise PreviewError("protocol_error")
    await disk(validate, partial, ref.kind, deadline)
    await disk(os.replace, partial, destination)
    remaining(deadline)
