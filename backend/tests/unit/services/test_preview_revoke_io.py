"""Revoke is checked before and after every chunk of every owned I/O phase (spec §4.2): snapshot, describe, put's
reader and get's writer stop at the next chunk boundary, never mid-syscall, and say so with a typed Revoked."""

from __future__ import annotations

import io
import threading
import time
import uuid

import pytest

from backend.app.services.preview_artifacts import (
    Revoked,
    _Reader,
    _Writer,
    describe,
    snapshot,
)
from backend.app.services.preview_protocol import CHUNK_BYTES, Artifact

DEADLINE = time.monotonic_ns() + int(60e9)


def revoked_after(chunks: int):
    """An Event that becomes set after ``chunks`` checks — a high waiter arriving mid-transfer."""
    event = threading.Event()
    calls = {"n": 0}
    original = event.is_set

    def is_set():
        calls["n"] += 1
        if calls["n"] > chunks:
            event.set()
        return original()

    event.is_set = is_set
    return event, calls


def test_snapshot_stops_at_the_next_chunk(tmp_path):
    source = tmp_path / "in.stl"
    source.write_bytes(b"x" * (CHUNK_BYTES * 8))
    revoke, _ = revoked_after(3)
    with pytest.raises(Revoked):
        snapshot(source, tmp_path / "out.stl", DEADLINE, revoke=revoke)
    assert (tmp_path / "out.stl").stat().st_size < CHUNK_BYTES * 8


def test_snapshot_of_bytes_stops_too(tmp_path):
    revoke, _ = revoked_after(2)
    with pytest.raises(Revoked):
        snapshot(b"y" * (CHUNK_BYTES * 8), tmp_path / "out.stl", DEADLINE, revoke=revoke)


def test_describe_stops_at_the_next_chunk(tmp_path):
    source = tmp_path / "in.stl"
    source.write_bytes(b"x" * (CHUNK_BYTES * 8))
    revoke, _ = revoked_after(3)
    with pytest.raises(Revoked):
        describe(source, uuid.uuid4().hex, "mesh", "stl", DEADLINE, revoke=revoke)


def test_snapshot_of_bytes_notices_a_revoke_during_its_last_chunk(tmp_path):
    revoke, _ = revoked_after(1)  # clear before the write, set by the time it is done
    with pytest.raises(Revoked):
        snapshot(b"y" * CHUNK_BYTES, tmp_path / "out.stl", DEADLINE, revoke=revoke)


def test_reader_and_writer_check_before_and_after_each_chunk():
    stream = io.BytesIO(b"z" * (CHUNK_BYTES * 4))
    pre = threading.Event()
    pre.set()
    with pytest.raises(Revoked):
        _Reader(stream, DEADLINE, pre).readinto(bytearray(CHUNK_BYTES))
    assert stream.tell() == 0  # nothing read once revoked
    during, _ = revoked_after(1)
    with pytest.raises(Revoked):
        _Reader(io.BytesIO(b"z" * CHUNK_BYTES), DEADLINE, during).readinto(bytearray(CHUNK_BYTES))
    attempt = uuid.uuid4().hex
    ref = Artifact(role="mesh", key=f"{attempt}_mesh", kind="stl", size=CHUNK_BYTES * 4, digest="a" * 64)
    sink = io.BytesIO()
    with pytest.raises(Revoked):
        _Writer(sink, ref, DEADLINE, pre).write(b"z" * CHUNK_BYTES)
    assert sink.getvalue() == b""  # nothing written once revoked
    during, _ = revoked_after(1)
    with pytest.raises(Revoked):
        _Writer(io.BytesIO(), ref, DEADLINE, during).write(b"z" * CHUNK_BYTES)


def test_put_reader_and_get_writer_check_each_chunk():
    revoke = threading.Event()
    reader = _Reader(io.BytesIO(b"z" * (CHUNK_BYTES * 4)), DEADLINE, revoke)
    buffer = bytearray(CHUNK_BYTES)
    assert reader.readinto(buffer) == CHUNK_BYTES
    revoke.set()
    with pytest.raises(Revoked):
        reader.readinto(buffer)
    attempt = uuid.uuid4().hex
    ref = Artifact(role="mesh", key=f"{attempt}_mesh", kind="stl", size=CHUNK_BYTES * 4, digest="a" * 64)
    writer = _Writer(io.BytesIO(), ref, DEADLINE, threading.Event())
    writer.write(b"z" * CHUNK_BYTES)
    writer.revoke.set()
    with pytest.raises(Revoked):
        writer.write(b"z" * CHUNK_BYTES)


def test_without_a_revoke_token_everything_is_as_before(tmp_path):
    source = tmp_path / "in.stl"
    source.write_bytes(b"x" * (CHUNK_BYTES * 3 + 7))
    snapshot(source, tmp_path / "out.stl", DEADLINE)
    assert (tmp_path / "out.stl").read_bytes() == source.read_bytes()
    assert describe(tmp_path / "out.stl", uuid.uuid4().hex, "mesh", "stl", DEADLINE).size == CHUNK_BYTES * 3 + 7


def test_revoked_is_a_closed_preview_error():
    from backend.app.services.preview_protocol import PreviewError

    assert issubclass(Revoked, PreviewError) and Revoked().outcome == "canceled"
