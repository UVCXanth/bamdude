"""The one local preview slot and who gets it next (spec §4.2).

Classes: ``high`` = sliced, ``normal`` = STL/OBJ, ``low`` = STEP. The best waiter is granted when the slot frees —
high before normal before low, FIFO inside a class by admission order (a requeued low brings its first order back,
so a preempted execution returns to the head of its class). A waiting low is overtaken by high and normal; ONLY a
high waiter revokes an ACTIVE low, and only until that low handed off its result. Then the high waits for the short
owned publication instead (the point of no return, ``hand_off``).

A revoke is a typed token — a ``threading.Event`` the I/O threads check between chunks and an ``asyncio.Event`` the
attempt awaits beside its RPC — never ``Task.cancel``: a preempted attempt ends with an internal result, not a
cancellation of whoever is waiting on it. Everything runs on the event loop; check-and-set of the hand-off and of a
revoke have no await between them, so both sides can never believe they won.
"""

from __future__ import annotations

import asyncio
import itertools
import threading

RANK = {"high": 0, "normal": 1, "low": 2}


class Ticket:
    __slots__ = ("priority", "order", "granted", "revoke", "revoked")

    def __init__(self, priority: str, order: int):
        if priority not in RANK:
            raise ValueError("unknown preview priority")
        self.priority, self.order = priority, order
        self.granted = asyncio.get_running_loop().create_future()
        self.revoke = threading.Event()  # thread-safe: checked by snapshot/describe/put/get chunk loops
        self.revoked = asyncio.Event()  # awaited by the attempt beside its run RPC

    def request_revoke(self) -> None:
        self.revoke.set()
        self.revoked.set()


class Arbiter:
    def __init__(self):
        self.holder: Ticket | None = None
        self._waiting: list[Ticket] = []
        self._order = itertools.count()
        self._handed_off = False

    def locked(self) -> bool:
        return self.holder is not None

    def waiting_count(self) -> int:
        return len(self._waiting)

    def waiting(self, priority: str) -> int:
        return sum(1 for t in self._waiting if t.priority == priority)

    async def acquire(self, priority: str = "normal", timeout: float | None = None, *, order: int | None = None):
        ticket = Ticket(priority, next(self._order) if order is None else order)
        self._waiting.append(ticket)
        self._grant()
        if (
            priority == "high"
            and self.holder is not None
            and self.holder is not ticket
            and self.holder.priority == "low"
            and not self._handed_off
        ):
            self.holder.request_revoke()
        try:
            async with asyncio.timeout(timeout):
                await asyncio.shield(ticket.granted)
        except BaseException:
            if ticket in self._waiting:
                self._waiting.remove(ticket)
            elif self.holder is ticket:  # granted in the same instant the waiter gave up: never leave it held
                self.release(ticket)
            raise
        return ticket

    def hand_off(self, ticket: Ticket) -> bool:
        """The point of no return, under the arbiter's own (single-threaded) gate: False when a revoke came first."""
        if self.holder is not ticket or ticket.revoke.is_set():
            return False
        self._handed_off = True
        return True

    def release(self, ticket: Ticket | None = None) -> None:
        if ticket is not None and self.holder is not ticket:
            raise RuntimeError("release of a slot this ticket does not hold")
        self.holder = None
        self._handed_off = False
        self._grant()

    def _grant(self) -> None:
        if self.holder is not None or not self._waiting:
            return
        best = min(self._waiting, key=lambda t: (RANK[t.priority], t.order))
        self._waiting.remove(best)
        self.holder = best
        best.granted.set_result(True)
