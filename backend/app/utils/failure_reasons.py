"""The one failure-reason vocabulary (upstream 5211fd45, #2974).

``PrintArchive.failure_reason`` holds a KEY, rendered through
``t('editArchive.failureReasons.<key>')`` by the archive editor and the
Statistics breakdown — never a display label or a sentence. The Failure Analysis
widget groups on the raw value, so a second spelling of one cause is a second
bucket, and a label can never be translated because there is no key to resolve.
The list mirrors ``FAILURE_REASON_KEYS`` in ``frontend/src/components/EditArchiveModal.tsx``;
a test pins the two together. m186 folds the historical spellings onto these.
"""

from __future__ import annotations

from backend.app.i18n import current_language, t

FAILURE_REASON_KEYS = frozenset(
    {
        "adhesionFailure",
        "spaghettiDetached",
        "layerShift",
        "cloggedNozzle",
        "filamentRunout",
        "warping",
        "stringing",
        "underExtrusion",
        "powerFailure",
        "swapModeFailure",
        "printerError",
        "userCancelled",
        # No end-of-print status ever arrived (stale cleanup, reconnect
        # reconciliation); which situation it was is carried by ``status``.
        "noStatusUpdate",
        "other",
        # Dispatch classes (post-rebuild D-R6): the attempt to START the print
        # ended, which says nothing about a physical print — see
        # ``DISPATCH_FAILURE_REASONS``.
        "dispatchSourceUnavailable",
        "dispatchUploadFailed",
        "dispatchPrinterUnavailable",
        "dispatchStartRefused",
        "dispatchCommandRejected",
        "dispatchNoAcknowledgement",
        "dispatchAcceptedNotStarted",
        "dispatchPreparationError",
        "dispatchInternalError",
    }
)

USER_CANCELLED = "userCancelled"
NO_STATUS_UPDATE = "noStatusUpdate"
#: A physical failure the printer gave no recognisable cause for.
OTHER = "other"

DISPATCH_SOURCE_UNAVAILABLE = "dispatchSourceUnavailable"
DISPATCH_UPLOAD_FAILED = "dispatchUploadFailed"
DISPATCH_PRINTER_UNAVAILABLE = "dispatchPrinterUnavailable"
DISPATCH_START_REFUSED = "dispatchStartRefused"
DISPATCH_COMMAND_REJECTED = "dispatchCommandRejected"
DISPATCH_NO_ACKNOWLEDGEMENT = "dispatchNoAcknowledgement"
#: No active state although the printer took the file (Phase A, or its file name
#: changed): NOT our durable ``accepted`` — the printer may still start it.
DISPATCH_ACCEPTED_NOT_STARTED = "dispatchAcceptedNotStarted"
DISPATCH_PREPARATION_ERROR = "dispatchPreparationError"
DISPATCH_INTERNAL_ERROR = "dispatchInternalError"

#: The failures of a DISPATCH, not of a print: a failed archive carrying one of
#: these is a «Dispatch errors» attempt, counted apart and never in the success
#: or failure rate of physical printing (D-R7). A strict subset of the vocabulary.
DISPATCH_FAILURE_REASONS = frozenset(
    {
        DISPATCH_SOURCE_UNAVAILABLE,
        DISPATCH_UPLOAD_FAILED,
        DISPATCH_PRINTER_UNAVAILABLE,
        DISPATCH_START_REFUSED,
        DISPATCH_COMMAND_REJECTED,
        DISPATCH_NO_ACKNOWLEDGEMENT,
        DISPATCH_ACCEPTED_NOT_STARTED,
        DISPATCH_PREPARATION_ERROR,
        DISPATCH_INTERNAL_ERROR,
    }
)
if not DISPATCH_FAILURE_REASONS < FAILURE_REASON_KEYS:  # pragma: no cover - a module-level invariant
    raise RuntimeError("DISPATCH_FAILURE_REASONS must be a strict subset of FAILURE_REASON_KEYS")


def reason_label(value: str | None, lang: str | None = None) -> str:
    """The words for a stored reason, in ``lang`` (the system language by default).

    A key reads as its label (``data/failure_reasons_<lang>.json``, the frontend's
    ``editArchive.failureReasons``); anything else — free text an older build or a
    user left — is shown as it is.
    """
    if not value:
        return ""
    if value not in FAILURE_REASON_KEYS:
        return value
    return t(lang or current_language(), "failure_reasons", value)


def row_class(status: str | None, archive_reason: str | None) -> str | None:
    """The ``error_code`` a queue row closed with ``status`` carries: its run's own cause, ``other`` without one.

    Only for a failed row — a class names a failure, and nothing else has one.
    """
    if status != "failed":
        return None
    return archive_reason or OTHER


def dispatch_reason_text(code: str | None, detail: str | None, lang: str | None = None) -> str:
    """A failed attempt's class and its detail as one line for a notification: «<class>: <detail>»."""
    label = reason_label(code, lang) if code else ""
    detail = (detail or "").strip()
    if label and detail and label != detail:
        return f"{label}: {detail}"
    return label or detail
