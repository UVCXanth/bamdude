"""The last AMS Backup group each slot was in while it held filament.

The firmware reports its backup groups as ``filam_bak``. Whether it keeps a slot
in its group once that slot runs dry is not measured — and routing needs the
answer exactly then: a job pinned to a slot that ran out prints from the slot
the firmware itself would switch to (owner, 2026-09-30). So this remembers, per
printer, the group every slot was last seen in WITH filament, and forgets it
only when the slot is loaded again and grouped differently, or not at all.

Memory only, for the life of the process, keyed by the printer's serial — not
by MQTT client, which ``connect_printer`` recreates, and not by printer id,
which the client does not know. A restart forgets it; a pinned empty slot then
waits, as it did before.

⚠️ Imports NOTHING from ``backend.app.services`` (``bambu_mqtt`` imports it on
the message path), like ``ams_advertised_overlay``. Written on the paho thread,
read by ``get_feed_snapshot`` — hence the lock.
"""

from __future__ import annotations

import threading

_lock = threading.Lock()
# {serial: {global slot id: the group it was last in while loaded}}
_store: dict[str, dict[int, frozenset[int]]] = {}


def observe(serial: str, groups: dict[int, list[list[int]]] | None, loaded: set[int]) -> None:
    """Fold one report in. ``groups`` is ``PrinterState.ams_backup_groups`` —
    ``None`` until the printer has reported ``filam_bak`` at all, which says
    nothing and changes nothing."""
    if groups is None:
        return
    current: dict[int, frozenset[int]] = {}
    for extruder_groups in groups.values():
        for group in extruder_groups:
            members = frozenset(group)
            if len(members) < 2:
                continue
            for member in members:
                current[member] = members
    with _lock:
        memory = _store.setdefault(serial, {})
        for member, members in current.items():
            if member in loaded:
                memory[member] = members
        for member in list(memory):
            if member in loaded and member not in current:
                del memory[member]


def membership(serial: str) -> dict[int, frozenset[int]]:
    with _lock:
        return dict(_store.get(serial, {}))


def forget_all() -> None:
    with _lock:
        _store.clear()
