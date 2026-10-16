"""The one preview slot and its admission order (spec §4.2, plan A3).

high = sliced, normal = STL/OBJ, low = STEP. A waiting low is overtaken by high and normal; ONLY a high waiter
revokes an active low, and only before that low handed off its result. A revoke is a typed token (thread-safe for
the I/O threads), never Task.cancel.
"""

from __future__ import annotations

import asyncio

import pytest

from backend.app.services.preview_arbiter import Arbiter


@pytest.mark.asyncio
async def test_a_free_slot_is_granted_at_once():
    arbiter = Arbiter()
    ticket = await arbiter.acquire("normal", timeout=1)
    assert arbiter.locked() and arbiter.holder is ticket
    arbiter.release(ticket)
    assert not arbiter.locked()


@pytest.mark.asyncio
async def test_waiters_are_served_high_then_normal_then_low_fifo_within_a_class():
    arbiter = Arbiter()
    first = await arbiter.acquire("normal", timeout=1)
    order = []

    async def wait(priority, name):
        ticket = await arbiter.acquire(priority, timeout=5)
        order.append(name)
        arbiter.release(ticket)

    tasks = [
        asyncio.create_task(wait("low", "low-1")),
        asyncio.create_task(wait("normal", "normal-1")),
        asyncio.create_task(wait("low", "low-2")),
        asyncio.create_task(wait("high", "high-1")),
        asyncio.create_task(wait("normal", "normal-2")),
    ]
    await asyncio.sleep(0.05)
    arbiter.release(first)
    await asyncio.gather(*tasks)
    assert order == ["high-1", "normal-1", "normal-2", "low-1", "low-2"]


@pytest.mark.asyncio
async def test_only_a_high_waiter_revokes_an_active_low():
    arbiter = Arbiter()
    low = await arbiter.acquire("low", timeout=1)
    normal = asyncio.create_task(arbiter.acquire("normal", timeout=5))
    await asyncio.sleep(0.05)
    assert not low.revoke.is_set()  # a normal batch never kills the CAD between two STLs
    high = asyncio.create_task(arbiter.acquire("high", timeout=5))
    await asyncio.sleep(0.05)
    assert low.revoke.is_set() and low.revoked.is_set()
    arbiter.release(low)
    granted = await high
    assert arbiter.holder is granted  # high before the earlier normal
    arbiter.release(granted)
    arbiter.release(await normal)


@pytest.mark.asyncio
async def test_high_does_not_revoke_an_active_normal_or_high():
    arbiter = Arbiter()
    for priority in ("normal", "high"):
        holder = await arbiter.acquire(priority, timeout=1)
        waiter = asyncio.create_task(arbiter.acquire("high", timeout=5))
        await asyncio.sleep(0.05)
        assert not holder.revoke.is_set()
        arbiter.release(holder)
        arbiter.release(await waiter)


@pytest.mark.asyncio
async def test_after_hand_off_a_high_arrival_waits_instead_of_revoking():
    arbiter = Arbiter()
    low = await arbiter.acquire("low", timeout=1)
    assert arbiter.hand_off(low) is True  # the point of no return
    high = asyncio.create_task(arbiter.acquire("high", timeout=5))
    await asyncio.sleep(0.05)
    assert not low.revoke.is_set()
    arbiter.release(low)
    arbiter.release(await high)


@pytest.mark.asyncio
async def test_a_revoked_holder_cannot_hand_off():
    arbiter = Arbiter()
    low = await arbiter.acquire("low", timeout=1)
    high = asyncio.create_task(arbiter.acquire("high", timeout=5))
    await asyncio.sleep(0.05)
    assert arbiter.hand_off(low) is False  # neither side believes it won
    arbiter.release(low)
    arbiter.release(await high)


@pytest.mark.asyncio
async def test_a_waiter_that_times_out_leaves_no_ghost():
    arbiter = Arbiter()
    holder = await arbiter.acquire("normal", timeout=1)
    with pytest.raises(TimeoutError):
        await arbiter.acquire("normal", timeout=0.05)
    assert arbiter.waiting_count() == 0
    arbiter.release(holder)
    assert not arbiter.locked()


@pytest.mark.asyncio
async def test_a_cancelled_waiter_leaves_no_ghost_and_never_holds():
    arbiter = Arbiter()
    holder = await arbiter.acquire("normal", timeout=1)
    waiter = asyncio.create_task(arbiter.acquire("low", timeout=5))
    await asyncio.sleep(0.05)
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    arbiter.release(holder)
    assert not arbiter.locked() and arbiter.waiting_count() == 0


@pytest.mark.asyncio
async def test_a_low_keeps_its_original_admission_order_on_requeue():
    """A preempted execution returns to the HEAD of the low class with its first admission order (spec §4.1)."""
    arbiter = Arbiter()
    holder = await arbiter.acquire("normal", timeout=1)
    later = asyncio.create_task(arbiter.acquire("low", timeout=5))
    await asyncio.sleep(0.01)
    earlier = asyncio.create_task(arbiter.acquire("low", timeout=5, order=-1))  # requeued, admitted first
    await asyncio.sleep(0.05)
    arbiter.release(holder)
    first = await earlier
    assert arbiter.holder is first
    arbiter.release(first)
    arbiter.release(await later)


@pytest.mark.asyncio
async def test_legacy_lock_interface_still_works():
    arbiter = Arbiter()
    await arbiter.acquire()
    assert arbiter.locked()
    arbiter.release()
    assert not arbiter.locked()
