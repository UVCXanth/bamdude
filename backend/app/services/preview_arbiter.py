"""The one local preview slot and who gets it next (spec §4.2).

Classes: ``high`` = sliced, ``normal`` = STL/OBJ, ``low`` = STEP. The best waiter is granted when the slot frees —
high before normal before low, FIFO inside a class by admission order (a requeued low brings its first order back,
so a preempted execution returns to the head of its class). A waiting low is overtaken by high and normal; ONLY a
high waiter revokes an ACTIVE low, and only until that low handed off its result. Then the high waits for the short
owned publication instead (the point of no return, ``hand_off``).

The time an ACTIVE low holds the slot does not spend a normal waiter's own budget: an STL picture behind a STEP
conversion waits for it — bounded by that low's own deadline (``until``) plus ``low_grace`` for its proven end — and
only then counts its own wait. Highs never need it (they revoke the low) and lows wait their ordinary turn.

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
    __slots__ = ("priority", "order", "granted", "revoke", "revoked", "until")

    def __init__(self, priority: str, order: int):
        if priority not in RANK:
            raise ValueError("unknown preview priority")
        self.priority, self.order = priority, order
        self.granted = asyncio.get_running_loop().create_future()
        self.revoke = threading.Event()  # thread-safe: checked by snapshot/describe/put/get chunk loops
        self.revoked = asyncio.Event()  # awaited by the attempt beside its run RPC
        self.until: float | None = None  # loop-clock deadline of the attempt holding this ticket, set once granted

    def request_revoke(self) -> None:
        self.revoke.set()
        self.revoked.set()


class Arbiter:
    def __init__(self, *, low_grace: float = 0.0):
        self.low_grace = low_grace
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
        loop = asyncio.get_running_loop()
        end = None if timeout is None else loop.time() + timeout
        try:
            while True:
                try:
                    async with asyncio.timeout_at(end):
                        await asyncio.shield(ticket.granted)
                    break
                except TimeoutError:
                    later = self._outlast_low(ticket, timeout)
                    if later is None or later <= loop.time():
                        raise
                    end = later
        except BaseException:
            if ticket in self._waiting:
                self._waiting.remove(ticket)
            elif self.holder is ticket:  # granted in the same instant the waiter gave up: never leave it held
                self.release(ticket)
            raise
        return ticket

    def _outlast_low(self, ticket: Ticket, own: float | None) -> float | None:
        """A normal waiter whose budget ran out while an active low holds the slot: the time to wait to — the low's
        deadline, its grace, then the waiter's own budget again. None when nothing extends the wait."""
        holder = self.holder
        if ticket.priority != "normal" or ticket not in self._waiting or own is None:
            return None
        if holder is None or holder.priority != "low" or holder.until is None:
            return None
        return holder.until + self.low_grace + own

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
