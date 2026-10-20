"""Durable crash hold, independent of database and printer transports."""

import json
import subprocess
import sys

import pytest

from backend.app.services.farm_startup_guard import FarmStartupGuard, FarmStartupRefused


def boot(tmp_path):
    guard = FarmStartupGuard()
    guard.start(tmp_path)
    guard.mark_ready()
    return guard


def release(guard):
    state = guard.status()
    return guard.resume(state["boot_id"], state["hold_id"], actor="user:1")


def test_first_boot_requires_durable_acknowledgement(tmp_path):
    guard = boot(tmp_path)
    try:
        assert guard.status()["reason"] == "previous_run_unknown"
        assert not guard.allowed()
        release(guard)
        assert guard.allowed()
        assert guard.state["last_ack"]["actor"] == "user:1"
        assert json.loads(guard.path.read_text())["hold"] is None
    finally:
        guard.finish(clean=True)


def test_clean_boot_opens_only_after_readiness(tmp_path):
    guard = boot(tmp_path)
    release(guard)
    guard.finish(clean=True)
    second = FarmStartupGuard()
    second.start(tmp_path)
    try:
        assert not second.allowed()
        assert second.status()["state"] == "starting"
        second.mark_ready()
        assert second.allowed()
    finally:
        second.finish(clean=True)


def test_clean_shutdown_does_not_erase_latch(tmp_path):
    first = boot(tmp_path)
    hold = first.status()["hold_id"]
    first.finish(clean=True)
    second = boot(tmp_path)
    try:
        assert second.status()["hold_id"] == hold
        assert not second.allowed()
    finally:
        second.finish(clean=True)


def test_interrupted_run_latches_and_stale_receipt_cannot_release(tmp_path):
    first = boot(tmp_path)
    old = first.status()
    release(first)
    first.finish(clean=False)  # process death releases the OS lock, never writes clean
    second = boot(tmp_path)
    try:
        assert second.status()["reason"] == "unclean_shutdown"
        with pytest.raises(FarmStartupRefused, match="stale"):
            second.resume(old["boot_id"], old["hold_id"], actor="user:1")
        assert not second.allowed()
        release(second)
        assert second.allowed()
    finally:
        second.finish(clean=True)


@pytest.mark.parametrize(
    "contents",
    [
        "{",
        '{"version":999}',
        '{"version":1,"lifecycle":"clean"}',
        '{"version":1,"lifecycle":"clean","boot_id":"broken","hold":null}',
        '{"version":1,"lifecycle":[],"boot_id":"00000000-0000-0000-0000-000000000001","hold":null}',
        '{"version":1,"lifecycle":{},"boot_id":"00000000-0000-0000-0000-000000000001","hold":null}',
        '{"version":true,"lifecycle":"clean","boot_id":"00000000-0000-0000-0000-000000000001","hold":null}',
        '{"version":1,"lifecycle":"clean","boot_id":"00000000-0000-0000-0000-000000000001","hold":null,"last_ack":"broken"}',
        '{"version":1,"lifecycle":"clean","boot_id":"00000000-0000-0000-0000-000000000001","hold":{"id":"broken","reason":"restore","since":"2026-10-20T00:00:00+00:00"}}',
        '{"version":1,"lifecycle":"clean","boot_id":"00000000-0000-0000-0000-000000000001","hold":{"id":"00000000-0000-0000-0000-000000000002","reason":"restore","since":"broken"}}',
    ],
)
def test_unreadable_or_invalid_record_is_held(tmp_path, contents):
    path = tmp_path / "runtime-state" / "farm-startup"
    path.mkdir(parents=True)
    (path / "state.json").write_text(contents)
    guard = boot(tmp_path)
    try:
        assert guard.status()["reason"] == "previous_run_unknown"
        assert not guard.allowed()
    finally:
        guard.finish(clean=True)


def test_failed_release_write_does_not_open_gate(tmp_path, monkeypatch):
    guard = boot(tmp_path)
    monkeypatch.setattr(guard, "_write", lambda state: (_ for _ in ()).throw(OSError("disk")))
    try:
        with pytest.raises(FarmStartupRefused, match="storage_unavailable"):
            release(guard)
        assert not guard.allowed()
    finally:
        guard.finish(clean=False)


def test_old_session_cannot_make_replacement_ready(tmp_path):
    guard = boot(tmp_path)
    try:
        release(guard)
        guard.printer_connecting(1, 1)
        assert not guard.allowed(1)
        guard.printer_connecting(1, 2)
        guard.printer_reconciled(1, 1)
        assert not guard.allowed(1)
        guard.printer_reconciled(1, 2)
        assert guard.allowed(1)
    finally:
        guard.finish(clean=True)


def test_restore_invalidates_a_confirmation_opened_under_an_existing_hold(tmp_path):
    guard = boot(tmp_path)
    before = guard.status()
    try:
        guard.hold("restore")
        assert guard.status()["hold_id"] != before["hold_id"]
        with pytest.raises(FarmStartupRefused, match="stale"):
            guard.resume(before["boot_id"], before["hold_id"], actor="operator")
        assert not guard.allowed()
    finally:
        guard.finish(clean=True)


def test_late_connection_and_disconnect_from_old_client_do_not_change_new_owner(tmp_path):
    guard = boot(tmp_path)
    try:
        release(guard)
        guard.register_printer_owner(1, 1)
        guard.printer_connecting(1, 10, owner=1)
        guard.register_printer_owner(1, 2)
        guard.printer_connecting(1, 20, owner=2)
        guard.printer_reconciled(1, 20)
        guard.printer_disconnected(1, 10)
        guard.printer_connecting(1, 30, owner=1)
        assert guard.allowed(1)
    finally:
        guard.finish(clean=True)


def test_generation_invalidates_unsent_permit(tmp_path):
    guard = boot(tmp_path)
    try:
        release(guard)
        generation = guard.generation
        guard.hold("restore")
        assert not guard.allowed(generation=generation)
        release(guard)
        assert guard.allowed()
        assert not guard.allowed(generation=generation)
    finally:
        guard.finish(clean=True)


def test_second_process_cannot_change_live_owners_record(tmp_path):
    guard = boot(tmp_path)
    before = guard.path.read_bytes()
    code = """
import sys
from pathlib import Path
from backend.app.services.farm_startup_guard import FarmStartupGuard, FarmStartupRefused
g=FarmStartupGuard()
try:
    g.start(Path(sys.argv[1]))
except FarmStartupRefused:
    print('refused')
else:
    raise SystemExit('second owner admitted')
"""
    try:
        result = subprocess.run([sys.executable, "-c", code, str(tmp_path)], capture_output=True, timeout=15)
        assert result.returncode == 0, result.stderr
        assert b"refused" in result.stdout
        assert guard.path.read_bytes() == before
    finally:
        guard.finish(clean=True)


def test_same_ack_is_idempotent_and_shutdown_revokes_admission(tmp_path):
    guard = boot(tmp_path)
    state = guard.status()
    try:
        assert guard.resume(state["boot_id"], state["hold_id"], actor="user:1") == "released"
        assert guard.resume(state["boot_id"], state["hold_id"], actor="user:1") == "already_released"
        guard.close_admission()
        assert not guard.allowed()
    finally:
        guard.finish(clean=True)


def test_killed_process_leaves_running_record_and_releases_os_lock(tmp_path):
    code = """
import sys
from pathlib import Path
from backend.app.services.farm_startup_guard import FarmStartupGuard
g=FarmStartupGuard()
g.start(Path(sys.argv[1]))
g.mark_ready()
s=g.status()
g.resume(s['boot_id'],s['hold_id'],actor='test')
print('READY',flush=True)
sys.stdin.read()
"""
    process = subprocess.Popen(
        [sys.executable, "-u", "-c", code, str(tmp_path)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        assert process.stdout.readline().strip() == b"READY"
        import psutil

        children = psutil.Process(process.pid).children(recursive=True)
        for child in children:
            child.kill()
        process.kill()
        process.wait(timeout=15)
        psutil.wait_procs(children, timeout=15)
        second = boot(tmp_path)
        try:
            assert second.status()["reason"] == "unclean_shutdown"
            assert not second.allowed()
        finally:
            second.finish(clean=True)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=15)


def test_readiness_failure_cannot_be_acknowledged(tmp_path):
    guard = FarmStartupGuard()
    guard.start(tmp_path)
    guard.readiness_failed = True
    try:
        guard.mark_ready()
        assert not guard.status()["can_resume"]
        with pytest.raises(FarmStartupRefused, match="not_ready"):
            release(guard)
    finally:
        guard.finish(clean=False)
