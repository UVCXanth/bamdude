"""A product card reuses a mounted file's stored hash while the file has not moved.

The scan stores ``fs_modified_at`` from the whole nanoseconds of the file's mtime; the card
must compare with the same conversion, or about one file in sixteen — those whose float
seconds round to another microsecond — looks moved and is read in full for nothing.
"""

import os

from backend.app.api.routes.library import _mtime_to_utc
from backend.app.services.product_card import _digest_of, _FileSpec

#: 2026-09-21 14:13:20.0000006 UTC — `st_mtime` and `st_mtime_ns / 1e9` round it to
#: different microseconds.
_SPLIT_MTIME_NS = 1_790_000_000_000_000_600


def test_an_unmoved_mounted_file_keeps_its_stored_hash(tmp_path):
    target = tmp_path / "part.3mf"
    target.write_bytes(b"not what the stored hash says")
    os.utime(target, ns=(_SPLIT_MTIME_NS, _SPLIT_MTIME_NS))
    stat = target.stat()
    spec = _FileSpec(
        library_file_id=1,
        path=target,
        filename=target.name,
        file_hash="stored-hash",
        is_external=True,
        file_size=stat.st_size,
        # What the scan wrote for this file.
        fs_modified_at=_mtime_to_utc(stat.st_mtime_ns / 1e9),
    )
    assert _digest_of(spec) == "stored-hash"
