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
- :class:`SourceFact` -- a JOB's own declaration: taken at capture (:func:`archive_source` / :func:`library_source`),
  confirmed against the hash the worker computed (:func:`confirm`), kept in the job's ``source_snapshot``
  (:func:`snapshot_fact`, :func:`snapshot_with_fact`), and for a snapshot that predates the fix answered once from
  the job's own links (:func:`resolve_legacy`).
- :func:`decide` -- whether OUR swap macros may run for a job, and what an unknown source does to a request for them.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from copy import deepcopy
from dataclasses import dataclass
from types import SimpleNamespace
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
    classified yet -- the one state a late attach may finish. ``invalid``: a record is there and was rejected."""

    value: bool | None
    pending_external: bool = False
    recorded: bool = False
    invalid: bool = False


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
    rejected = ArchiveFact(None, invalid=True)
    if not isinstance(extra, Mapping):
        return rejected
    record = extra[CARRIER_KEY]
    if not isinstance(record, Mapping):
        return rejected
    version = record.get("version")
    value = record.get("value", ...)
    pending = record.get("pending_external")
    if type(version) is not int or version != CARRIER_VERSION:
        return rejected
    if value is ... or (value is not None and type(value) is not bool) or type(pending) is not bool:
        return rejected
    if pending and value is not None:
        return rejected
    if type(column) is not bool or column is not (value is True):
        return rejected
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


# --- git backup (§11) -----------------------------------------------------------------------------------------------

#: The projection's key in a backed-up archive entry; the record travels under :data:`CARRIER_KEY`.
BACKUP_PROJECTION_KEY = "swap_compatible"


def backup_fields(archive) -> dict:
    """What a git backup carries of an archive's declaration: the projection, and the record when there is one.

    Nothing else of ``extra_data`` -- no dispatch or pending authority travels with the metadata.
    """
    column = getattr(archive, "swap_compatible", None)
    fields = {BACKUP_PROJECTION_KEY: column if type(column) is bool else False}
    extra = getattr(archive, "extra_data", None)
    if isinstance(extra, Mapping) and CARRIER_KEY in extra:
        fields[CARRIER_KEY] = deepcopy(extra[CARRIER_KEY])
    return fields


def restored_declaration(entry: Mapping, existing=None) -> tuple[bool, bool | None]:
    """``(write, value)`` for the archive a backup entry restores -- ``existing`` is the local row it overwrites.

    A record in the backup is read strictly against its projection: valid keeps its value, pending comes back
    unknown and NOT pending (the backup proves no origin now), malformed or contradicted is unknown, and an
    explicit null is unknown. A backup with no record says nothing: unknown on insert, the local row untouched on
    overwrite -- except that an explicit strict True projection brings a legacy True across onto a row without a
    record of its own.
    """
    if CARRIER_KEY in entry:
        record = entry[CARRIER_KEY]
        if record is None:
            return True, None
        probe = SimpleNamespace(swap_compatible=entry.get(BACKUP_PROJECTION_KEY), extra_data={CARRIER_KEY: record})
        return True, archive_fact(probe).value
    legacy_true = entry.get(BACKUP_PROJECTION_KEY) is True
    if existing is None:
        return True, True if legacy_true else None
    if legacy_true and not archive_fact(existing).recorded:
        return True, True
    return False, None


# --- library --------------------------------------------------------------------------------------------------------


def valid_hash(value: Any) -> bool:
    return isinstance(value, str) and _SHA256.fullmatch(value) is not None


def library_fact(library_file) -> bool | None:
    """A library row's declaration -- only for a row with a valid content hash. Without one, nothing ties the
    declaration to the bytes a job will capture, so the operation's fact is unknown (§4)."""
    if not valid_hash(getattr(library_file, "file_hash", None)):
        return None
    return _strict_fact(getattr(library_file, "swap_compatible", None))


# --- a job's own fact: capture, snapshot, legacy (§5, §6) -----------------------------------------------------------

#: The keys of a job's ``source_snapshot`` this module owns: the fact (JSON true/false/null) and, for an unknown,
#: why -- diagnostics only, never a permission.
SNAPSHOT_FACT_KEY = "swap_compatible"
SNAPSHOT_REASON_KEY = "swap_reason"

REASON_HASH_MISSING = "hash_missing"
REASON_HASH_MISMATCH = "hash_mismatch"
REASON_SOURCE_UNKNOWN = "source_unknown"
REASON_RECORD_INVALID = "record_invalid"
UNKNOWN_REASONS = frozenset({REASON_HASH_MISSING, REASON_HASH_MISMATCH, REASON_SOURCE_UNKNOWN, REASON_RECORD_INVALID})


@dataclass(frozen=True)
class SourceFact:
    """A job's declaration as its source handed it over.

    ``reason`` says why an unknown is unknown and is ``None`` for a known value. ``missing`` is True only for a
    valid snapshot written before this fix, which has no key at all -- the one state §6's legacy resolution may
    answer; everything else, an explicit null included, is final.
    """

    value: bool | None
    reason: str | None = None
    missing: bool = False


UNKNOWN_SOURCE = SourceFact(None, REASON_SOURCE_UNKNOWN)


def _unknown(reason: str) -> SourceFact:
    return SourceFact(None, reason)


def archive_source(archive) -> tuple[SourceFact, str | None]:
    """An archive's declaration and the hash its bytes must have for it to count.

    The expected hash is the archive's unpatched source hash, and its ``content_hash`` only when it has none.
    """
    fact = archive_fact(archive)
    expected = getattr(archive, "source_content_hash", None) or getattr(archive, "content_hash", None)
    if fact.value is None:
        return _unknown(REASON_RECORD_INVALID if fact.invalid else REASON_SOURCE_UNKNOWN), expected
    return SourceFact(fact.value), expected


def library_source(library_file) -> tuple[SourceFact, str | None]:
    """A library row's declaration and its content hash. Without a valid hash nothing ties the declaration to
    the bytes a job will capture."""
    expected = getattr(library_file, "file_hash", None)
    if not valid_hash(expected):
        return _unknown(REASON_HASH_MISSING), expected
    value = library_fact(library_file)
    return (SourceFact(value) if value is not None else _unknown(REASON_RECORD_INVALID)), expected


def confirm(fact: SourceFact, expected: Any, actual: Any) -> SourceFact:
    """The declaration counts for the captured bytes only when the hash they really have is the one the source
    row recorded for them."""
    if fact.value is None:
        return fact if fact.reason in UNKNOWN_REASONS else UNKNOWN_SOURCE
    if not valid_hash(expected):
        return _unknown(REASON_HASH_MISSING)
    if not valid_hash(actual) or expected != actual:
        return _unknown(REASON_HASH_MISMATCH)
    return fact


def snapshot_fact(payload: Mapping) -> SourceFact:
    """Read the fact out of a snapshot payload of the known version, strictly.

    No key at all is the legacy state; a bool is the fact; null is unknown with its recorded reason (an old null
    without one is ``source_unknown``); anything else is ``record_invalid``. Never a fallback of its own.
    """
    if SNAPSHOT_FACT_KEY not in payload:
        return SourceFact(None, missing=True)
    value = payload[SNAPSHOT_FACT_KEY]
    if type(value) is bool:
        return SourceFact(value)
    if value is None:
        reason = payload.get(SNAPSHOT_REASON_KEY)
        return _unknown(reason if reason in UNKNOWN_REASONS else REASON_SOURCE_UNKNOWN)
    return _unknown(REASON_RECORD_INVALID)


def invalid_snapshot() -> SourceFact:
    """The fact of a snapshot this version cannot read: unknown, and final."""
    return _unknown(REASON_RECORD_INVALID)


def snapshot_fields(fact: SourceFact) -> dict:
    """The keys a snapshot carries for ``fact``. A still-missing legacy fact is written as an unknown: a copy
    records an answer, it never passes the question on."""
    if fact.value is not None:
        return {SNAPSHOT_FACT_KEY: fact.value}
    reason = fact.reason if fact.reason in UNKNOWN_REASONS else REASON_SOURCE_UNKNOWN
    return {SNAPSHOT_FACT_KEY: None, SNAPSHOT_REASON_KEY: reason}


def snapshot_with_fact(snapshot: Mapping, fact: SourceFact) -> dict:
    """A NEW snapshot dict for another job, carrying ``fact`` -- the parent's payload is never touched."""
    new = deepcopy(dict(snapshot))
    new.pop(SNAPSHOT_REASON_KEY, None)
    new.update(snapshot_fields(fact))
    return new


def resolve_legacy(*, provenance_kind: Any, archive, library_file, sha256: Any) -> SourceFact:
    """§6: the fact of a pre-fix snapshot, from the job's OWN live link whose hash matches the blob.

    ``archive`` / ``library_file`` are the rows behind the job's foreign keys (``None`` when the link is gone).
    The provenance's kind may narrow which link is meant; its id never authorises a lookup. Two candidate links
    that the kind does not decide between, or none, are unknown. A legacy archive's False stays unknown (D1).
    """
    candidates = []
    if archive is not None and provenance_kind in (None, "archive"):
        candidates.append(archive_source(archive))
    if library_file is not None and provenance_kind in (None, "library_file"):
        candidates.append(library_source(library_file))
    if len(candidates) != 1:
        return UNKNOWN_SOURCE
    fact, expected = candidates[0]
    return confirm(fact, expected, sha256)


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


class SwapRequestRefused(ValueError):
    """D2: our swap macros were asked for a source whose declaration is unknown."""

    def __init__(self, reason: str = UNKNOWN_SOURCE_REASON):
        super().__init__(reason)
        self.reason = reason


def resolve_request(fact: Any, *, execute: Any, events: Any, printer_swap_mode: bool) -> tuple[bool, list[str] | None]:
    """What a NEW job stores of a request for our swap macros: ``(execute, events)``, or :class:`SwapRequestRefused`.

    The stored fields say what will run -- never a request the job cannot honour (§8).
    """
    decision = decide(fact, execute=execute, events=events, printer_swap_mode=printer_swap_mode)
    if decision.refused:
        raise SwapRequestRefused(decision.reason)
    return decision.execute, (list(decision.events) if decision.execute else None)


def project(value: Any) -> tuple[bool, bool]:
    """The wire projection: ``(swap_compatible, swap_compatibility_known)``. The bool keeps its old meaning."""
    known = _strict_fact(value)
    return known is True, known is not None
