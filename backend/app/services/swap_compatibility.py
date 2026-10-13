"""A source's declaration of its own baked swap sequence (swap-source-lifecycle spec r4 §2-§4, §8).

``swap_compatible`` is what the SOURCE declares: that its bytes already carry a plate-swap sequence. It is not an
analysis of the G-code and not a bed sensor. The fact has three states that must survive the whole path -- capture,
queue, execution archive, reprint, backup: True, False and unknown (``None``). False is as authoritative as True;
unknown is not False.

One place answers each question:

- :func:`classify_external_name` -- the only filename rule, applied once, when NEW external bytes arrive (upload,
  ZIP member, scan, virtual printer, an observed external start). Never to an already known source: a display
  rename changes nothing.
- :func:`archive_fact` / :func:`write_archive_fact` -- the archive's record, ``extra_data["swap_source"]``, with the
  bool column kept as its projection (``column == (value is True)``). The column is for display and for legacy
  readers only; no macro or plate-clear gate may read it directly.
- :func:`library_fact` -- a library row's declaration counts only with a valid content hash.
- :func:`decide` -- whether OUR swap macros may run for a job, and what an unknown source does to a request for them.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

#: The reserved ``PrintArchive.extra_data`` key holding the record. Parsed 3MF metadata never writes it.
CARRIER_KEY = "swap_source"
CARRIER_VERSION = 1
#: The events BamDude's own swap macros fire on (``routes/macros.py``).
SWAP_EVENTS = frozenset({"swap_mode_start", "swap_mode_change_table"})
#: The refusal a request for our macros gets on a source whose declaration is unknown (D2).
UNKNOWN_SOURCE_REASON = "swap_source_unknown"

_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_MARKER = re.compile(r"\.swaps?\.", re.IGNORECASE)


@dataclass(frozen=True)
class ArchiveFact:
    """What an archive declares. ``recorded`` is False for a legacy row with no record (or an unreadable one);
    ``pending_external`` is True only for a valid record of an observed external start whose file has not been
    classified yet -- the one state a late attach may finish."""

    value: bool | None
    pending_external: bool = False
    recorded: bool = False


@dataclass(frozen=True)
class SwapDecision:
    """``execute`` / ``events``: what this job may fire of OUR swap macros. ``refused``: an effective request met an
    unknown source (D2) -- the job must not start silently without the swap the operator asked for."""

    execute: bool
    events: tuple[str, ...] | None
    refused: bool = False
    reason: str | None = None


# --- classifier -----------------------------------------------------------------------------------------------------


def classify_external_name(name: str | None) -> bool:
    """True when the basename of a NEW external file declares a baked swap sequence.

    The marker is dot-delimited on both sides -- ``.swap.`` or ``.swaps.``, in any case -- and only in the basename,
    split on both path separators: a marker in a directory, the bare word "swaps" or a stem that ends in ``.swap``
    with no further suffix declares nothing. This narrows the old substring match over the whole string.
    """
    if not isinstance(name, str):
        return False
    basename = re.split(r"[\\/]", name)[-1]
    return _MARKER.search(basename) is not None


# --- archive record -------------------------------------------------------------------------------------------------


def _strict_fact(value: Any) -> bool | None:
    return value if type(value) is bool else None


def archive_fact(archive) -> ArchiveFact:
    """The archive's declaration, read strictly.

    A valid record wins, provided the bool column agrees with it. A record that is malformed, of another version,
    or contradicted by the column is unknown -- with no fallback to the column and no attach right. With no record
    at all (a row from before this fix) only a strictly True column survives: dispatch never wrote the column, so
    a legacy False declares nothing (D1). ``extra_data`` that is not a mapping is unknown too.
    """
    column = getattr(archive, "swap_compatible", None)
    extra = getattr(archive, "extra_data", None)
    if extra is None or (isinstance(extra, Mapping) and CARRIER_KEY not in extra):
        return ArchiveFact(True if column is True else None)
    if not isinstance(extra, Mapping):
        return ArchiveFact(None)
    record = extra[CARRIER_KEY]
    if not isinstance(record, Mapping):
        return ArchiveFact(None)
    version = record.get("version")
    value = record.get("value", ...)
    pending = record.get("pending_external")
    if type(version) is not int or version != CARRIER_VERSION:
        return ArchiveFact(None)
    if value is ... or (value is not None and type(value) is not bool) or type(pending) is not bool:
        return ArchiveFact(None)
    if pending and value is not None:
        return ArchiveFact(None)
    if type(column) is not bool or column is not (value is True):
        return ArchiveFact(None)
    return ArchiveFact(value, pending_external=pending, recorded=True)


def write_archive_fact(archive, value: bool | None, *, pending_external: bool = False) -> None:
    """The one writer of an archive's declaration: the bool projection and the record, together.

    Only the reserved key is replaced; every other ``extra_data`` key is kept. A new dict is assigned, so the ORM
    sees the change and no other holder of the old dict is affected. What :func:`archive_fact` would reject is
    refused here instead of being written.
    """
    if value is not None and type(value) is not bool:
        raise ValueError(f"a swap declaration is True, False or None, not {value!r}")
    if type(pending_external) is not bool or (pending_external and value is not None):
        raise ValueError("pending_external is a bool, and True only while the declaration is unknown")
    extra = getattr(archive, "extra_data", None)
    merged = dict(extra) if isinstance(extra, Mapping) else {}
    merged[CARRIER_KEY] = {"version": CARRIER_VERSION, "value": value, "pending_external": pending_external}
    archive.swap_compatible = value is True
    archive.extra_data = merged


def strip_reserved(metadata: Mapping | None) -> dict:
    """``metadata`` without the reserved key: a parsed source file must not inject a declaration."""
    return {key: item for key, item in (metadata or {}).items() if key != CARRIER_KEY}


def public_extra_data(extra: Mapping | None) -> dict | None:
    """A copy of ``extra_data`` for an API response: the record is internal, everything else is returned as is."""
    if extra is None:
        return None
    return strip_reserved(extra) if isinstance(extra, Mapping) else extra


# --- library --------------------------------------------------------------------------------------------------------


def valid_hash(value: Any) -> bool:
    return isinstance(value, str) and _SHA256.fullmatch(value) is not None


def library_fact(library_file) -> bool | None:
    """A library row's declaration -- only for a row with a valid content hash. Without one, nothing ties the
    declaration to the bytes a job will capture, so the operation's fact is unknown (§4)."""
    if not valid_hash(getattr(library_file, "file_hash", None)):
        return None
    return _strict_fact(getattr(library_file, "swap_compatible", None))


# --- policy ---------------------------------------------------------------------------------------------------------


def _requested_events(events: Any) -> tuple[str, ...] | None:
    if not isinstance(events, (list, tuple)) or not events:
        return None
    if not all(isinstance(event, str) and event in SWAP_EVENTS for event in events):
        return None
    return tuple(events)


def effective_request(*, execute: Any, events: Any, printer_swap_mode: bool) -> bool:
    """Whether a job really asks for our swap macros on this printer: ``execute`` strictly True, a non-empty list
    of known events, and a printer in swap mode. The default ``execute=True`` with no events asks for nothing, and
    an opt-out is never raised into a request."""
    return execute is True and printer_swap_mode is True and _requested_events(events) is not None


def decide(fact: Any, *, execute: Any, events: Any, printer_swap_mode: bool) -> SwapDecision:
    """What a job may fire of OUR swap macros, given its source's declaration (§2, §8).

    - True: the source carries its own sequence -- ours are muted, request or not.
    - False: exactly what was requested, under the printer's swap mode; nothing is ever added or raised.
    - Unknown with an effective request: refused (D2), never a silent strip. Unknown without one: nothing to run.
    """
    requested = effective_request(execute=execute, events=events, printer_swap_mode=printer_swap_mode)
    known = _strict_fact(fact)
    if known is False and requested:
        return SwapDecision(True, _requested_events(events))
    if known is None and requested:
        return SwapDecision(False, None, refused=True, reason=UNKNOWN_SOURCE_REASON)
    return SwapDecision(False, None)


def project(value: Any) -> tuple[bool, bool]:
    """The wire projection: ``(swap_compatible, swap_compatibility_known)``. The bool keeps its old meaning."""
    known = _strict_fact(value)
    return known is True, known is not None
