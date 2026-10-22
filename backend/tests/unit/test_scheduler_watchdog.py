"""Unit tests for ``PrintScheduler._watchdog_print_start``.

Regression coverage for upstream #1078: H2D Pro firmware (01.01.00.00)
keeps ``gcode_state=FINISH`` for 48–55 s after accepting a ``project_file``
command before transitioning to PREPARE. The old watchdog reverted items
the printer had already started physically printing, and the next
scheduler tick re-dispatched them — looked like a reprint.

The fix adds a second "command landed" signal: ``subtask_id`` advancing
past the pre-dispatch value. The printer echoes the submission_id we
minted (``bambu_mqtt._publish_project``, upstream #1042) in its next
``push_status.subtask_id``, well before the state transitions on slow
firmware. Timeout also bumped 45 → 90 s as belt-and-braces.

These tests use short `timeout=0.3` / `poll_interval=0.05` values to
keep the suite fast while still exercising the full poll loop.

A negative verdict FAILS the attempt with its closed class and halts the
queue (post-rebuild D-R4): the start was published, so it is never put back to
``pending`` to be sent a second time.
"""

from contextlib import contextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.app.services.print_scheduler import PrintScheduler


def _make_status(state: str = "FINISH", subtask_id: str | None = None, gcode_file: str | None = None):
    status = MagicMock()
    status.state = state
    status.subtask_id = subtask_id
    status.gcode_file = gcode_file
    status.ams = []
    return status


def _printing_row():
    item = MagicMock()
    item.status = "printing"
    item.started_at = "claim-token"
    item.archive_id = 77
    db = AsyncMock()
    db.get.return_value = item
    ctx = AsyncMock()
    ctx.__aenter__.return_value = db
    ctx.__aexit__.return_value = False
    return item, ctx


@contextmanager
def _verdict_spies():
    """The two writers a negative verdict calls: the queue row's and the execution archive's."""
    from backend.app.services.background_dispatch import BackgroundDispatchService
    from backend.app.services.print_scheduler import scheduler

    with (
        patch.object(scheduler, "_fail_attempt", AsyncMock(return_value=True)) as fail,
        patch.object(BackgroundDispatchService, "_mark_dispatch_archive_terminal", AsyncMock()) as archive,
    ):
        yield fail, archive


class TestWatchdogGating:
    """State / subtask_id exit conditions — the core of the fix."""

    @pytest.mark.asyncio
    async def test_state_change_exits_early(self):
        """Classic signal: printer transitions out of pre_state → no revert."""
        # First poll shows RUNNING (state changed from FINISH), watchdog returns.
        with (
            patch("backend.app.services.print_scheduler.printer_manager") as pm,
            patch("backend.app.services.print_scheduler.async_session") as session,
        ):
            pm.get_status.return_value = _make_status(state="RUNNING", subtask_id="old")
            pm.get_client.return_value = None

            await PrintScheduler._watchdog_print_start(
                queue_item_id=1,
                printer_id=1,
                pre_state="FINISH",
                pre_subtask_id="old",
                swap_start_fired=False,
                timeout=0.3,
                poll_interval=0.05,
            )

            # Watchdog exited early — no DB session should have been opened.
            session.assert_not_called()

    @pytest.mark.asyncio
    async def test_finish_to_idle_user_dismissed_prompt_does_not_exit_early(self):
        """Regression for upstream Bambuddy #1370 / B.3.

        When a printer is in FINISH at dispatch time (un-dismissed post-print
        prompt from a prior job), the firmware silently rejects the new
        project_file. If the user then dismisses the screen prompt, the
        printer moves FINISH → IDLE — looks like a state change but is NOT
        acceptance of our command. The old `state != pre_state` check
        incorrectly exited early; the queue row would stay stuck at
        'printing' indefinitely and the scheduler would permanently mark the
        printer as busy. Now narrowed to an allow-list of active-print
        states (PREPARE / SLICING / RUNNING / PAUSE).
        """
        pre_state = "FINISH"
        pre_subtask = "sid-1"
        item, ctx = _printing_row()
        client = MagicMock()

        with (
            patch("backend.app.services.print_scheduler.printer_manager") as pm,
            patch("backend.app.services.print_scheduler.async_session", return_value=ctx),
            _verdict_spies() as (fail, archive),
        ):
            # IDLE is NOT in the active-print allow-list → the watchdog reaches
            # its verdict even though state != pre_state.
            pm.get_status.return_value = _make_status(state="IDLE", subtask_id=pre_subtask)
            pm.get_client.return_value = client

            await PrintScheduler._watchdog_print_start(
                queue_item_id=1,
                printer_id=1,
                pre_state=pre_state,
                pre_subtask_id=pre_subtask,
                swap_start_fired=False,
                timeout=0.3,
                poll_interval=0.05,
            )

            fail.assert_awaited_once()
            assert fail.await_args.kwargs["code"] == "dispatchNoAcknowledgement"
            assert fail.await_args.kwargs["claim_started_at"] == "claim-token"
            archive.assert_awaited_once()
            assert item.status == "printing"  # written by the addressed CAS, never by hand

    @pytest.mark.asyncio
    @pytest.mark.parametrize("active_state", ["PREPARE", "SLICING", "RUNNING", "PAUSE"])
    async def test_each_active_print_state_exits_early(self, active_state):
        """All four active-print states must be treated as "command landed"."""
        with (
            patch("backend.app.services.print_scheduler.printer_manager") as pm,
            patch("backend.app.services.print_scheduler.async_session") as session,
        ):
            pm.get_status.return_value = _make_status(state=active_state, subtask_id="old")
            pm.get_client.return_value = None

            await PrintScheduler._watchdog_print_start(
                queue_item_id=1,
                printer_id=1,
                pre_state="FINISH",
                pre_subtask_id="old",
                swap_start_fired=False,
                timeout=0.3,
                poll_interval=0.05,
            )

            session.assert_not_called(), f"{active_state} should be treated as 'command landed'"

    @pytest.mark.asyncio
    async def test_subtask_advance_exits_early_even_when_state_stuck(self):
        """New signal (upstream #1078): state stays FINISH but subtask_id advances.

        This is the H2D Pro case: state lags the accepted command by up to
        55 s, but subtask_id flips back in the first push_status.
        """
        with (
            patch("backend.app.services.print_scheduler.printer_manager") as pm,
            patch("backend.app.services.print_scheduler.async_session") as session,
        ):
            pm.get_status.return_value = _make_status(state="FINISH", subtask_id="new-submission-id")

            await PrintScheduler._watchdog_print_start(
                queue_item_id=1,
                printer_id=1,
                pre_state="FINISH",
                pre_subtask_id="prior-submission-id",
                swap_start_fired=False,
                timeout=0.3,
                poll_interval=0.05,
            )

            # subtask_id advanced → watchdog treats the command as landed.
            session.assert_not_called()

    @pytest.mark.asyncio
    async def test_both_signals_unchanged_fails_the_attempt(self):
        """Genuinely half-broken session: both signals unchanged across the full
        timeout → the attempt fails as unacknowledged; nothing goes back to pending.
        """
        pre_state = "FINISH"
        pre_subtask = "sid-1"
        item, ctx = _printing_row()

        with (
            patch("backend.app.services.print_scheduler.printer_manager") as pm,
            patch("backend.app.services.print_scheduler.async_session", return_value=ctx),
            _verdict_spies() as (fail, archive),
        ):
            pm.get_status.return_value = _make_status(state=pre_state, subtask_id=pre_subtask)
            pm.get_client.return_value = None

            await PrintScheduler._watchdog_print_start(
                queue_item_id=1,
                printer_id=1,
                pre_state=pre_state,
                pre_subtask_id=pre_subtask,
                swap_start_fired=False,
                timeout=0.15,
                poll_interval=0.05,
            )

            fail.assert_awaited_once()
            assert fail.await_args.kwargs["code"] == "dispatchNoAcknowledgement"
            assert archive.await_args.kwargs["failure_reason"] == "dispatchNoAcknowledgement"
            assert archive.await_args.args[:2] == (77, "failed")
            # The claim token is the attempt's address, not something to clear.
            assert item.started_at == "claim-token"

    @pytest.mark.asyncio
    async def test_a_changed_file_fails_as_accepted_not_started(self):
        """The printer's file changed without Phase A (a slow parse, #1150): it may
        still start, so the class says the file arrived."""
        item, ctx = _printing_row()

        with (
            patch("backend.app.services.print_scheduler.printer_manager") as pm,
            patch("backend.app.services.print_scheduler.async_session", return_value=ctx),
            _verdict_spies() as (fail, _archive),
        ):
            pm.get_status.return_value = _make_status(state="FINISH", subtask_id="sid", gcode_file="new.3mf")
            pm.get_client.return_value = None

            await PrintScheduler._watchdog_print_start(
                queue_item_id=1,
                printer_id=1,
                pre_state="FINISH",
                pre_subtask_id="sid",
                swap_start_fired=False,
                timeout=0.15,
                poll_interval=0.05,
                pre_gcode_file="old.3mf",
            )

            assert fail.await_args.kwargs["code"] == "dispatchAcceptedNotStarted"

    @pytest.mark.asyncio
    async def test_swap_fired_fails_with_a_plate_warning_and_is_never_resent(self):
        """swap_start_fired=True: the table already moved. The attempt fails like any
        other negative verdict — never back to pending, where a re-dispatch would fire
        swap_mode_start a second time — and the operator is told to check the plate.
        """
        item, ctx = _printing_row()

        with (
            patch("backend.app.services.print_scheduler.printer_manager") as pm,
            patch("backend.app.services.print_scheduler.async_session", return_value=ctx),
            _verdict_spies() as (fail, _archive),
        ):
            pm.get_status.return_value = _make_status(state="FINISH", subtask_id="sid")
            pm.get_client.return_value = None

            await PrintScheduler._watchdog_print_start(
                queue_item_id=1,
                printer_id=1,
                pre_state="FINISH",
                pre_subtask_id="sid",
                swap_start_fired=True,
                timeout=0.15,
                poll_interval=0.05,
            )

            fail.assert_awaited_once()
            assert "swap start macro ran" in fail.await_args.kwargs["message"]
            assert item.status == "printing"

    @pytest.mark.asyncio
    async def test_no_subtask_id_baseline_falls_back_to_state_only(self):
        """When pre_subtask_id is None (printer hadn't emitted one yet), the
        new guard must not short-circuit on a None→"any" transition. Only
        state-change should count in that case.
        """
        item, ctx = _printing_row()

        with (
            patch("backend.app.services.print_scheduler.printer_manager") as pm,
            patch("backend.app.services.print_scheduler.async_session", return_value=ctx),
            _verdict_spies() as (fail, _archive),
        ):
            # state unchanged; subtask transitions None → "first-ever-id" — MUST
            # NOT be mistaken as advance since pre_subtask_id was None.
            pm.get_status.return_value = _make_status(state="FINISH", subtask_id="first-ever-id")
            pm.get_client.return_value = None

            await PrintScheduler._watchdog_print_start(
                queue_item_id=1,
                printer_id=1,
                pre_state="FINISH",
                pre_subtask_id=None,
                swap_start_fired=False,
                timeout=0.15,
                poll_interval=0.05,
            )

            # The verdict fired — state never changed, None pre_subtask
            # disables the subtask-advance guard.
            fail.assert_awaited_once()
