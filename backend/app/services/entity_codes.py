"""The Workshop's entity codes — derived from the id, never stored (spec workshop-customers, part A).

A code is ``<PREFIX>-<id zero-padded to four digits>`` and grows past four with
no limit (``OR-12345``). Latin and never translated: it is an identifier, the
same in either interface language, on paper and in speech. Every entity of the
Projects section gets its prefix HERE and nowhere else; ``test_entity_codes``
pins that they are two letters and unique. The frontend never builds a code —
it shows the ``code`` the responses carry.
"""

PREFIXES: dict[str, str] = {
    "customer": "CU",
    "contact": "CT",
    "order": "OR",
    "product": "PR",
    "stock_item": "SK",  # WS-09 — reserved
    "dispatch_note": "DN",  # WS-12 — an issue IS its dispatch note
}
_WIDTH = 4
# The largest id a search may name. Past it SQLite's parameter binder raises
# instead of simply finding nothing, so a long digit string must stay text.
_MAX_ID = 2**31 - 1


def code_for(kind: str, entity_id: int) -> str:
    """``OR-0042`` for order 42."""
    return f"{PREFIXES[kind]}-{entity_id:0{_WIDTH}d}"


def id_from_query(kind: str, text: str | None, *, require_prefix: bool = False) -> int | None:
    """The id ``text`` names as a code of ``kind``, or None.

    ``OR-0042``, ``or42``, ``OR 42``, ``0042`` and ``42`` all name order 42. A
    prefix of another kind names nothing here (``CU-7`` in the orders' search is
    just text). ``require_prefix`` refuses the bare number: a customer search
    reads ``7`` as ``CU-0007``, never as contact 7 (spec rule 3).
    """
    if not text:
        return None
    rest = text.strip()
    prefix = None
    if len(rest) >= 2 and rest[:2].isascii() and rest[:2].isalpha():
        prefix, rest = rest[:2], rest[2:].lstrip()
    if rest.startswith("-"):
        rest = rest[1:].lstrip()
    if not rest or not rest.isdecimal():
        return None
    if prefix is None:
        if require_prefix:
            return None
    elif prefix.upper() != PREFIXES[kind]:
        return None
    # Avoid Python's large-integer digit limit on arbitrarily long searches.
    digits = rest.lstrip("0")
    if len(digits) > len(str(_MAX_ID)):
        return None
    value = int(digits) if digits else 0
    return value if 0 < value <= _MAX_ID else None
