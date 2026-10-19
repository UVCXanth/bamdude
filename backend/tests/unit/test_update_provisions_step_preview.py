"""The in-app update keeps an enabled STEP component current (spec stage C R4, R6b; plan Task 4): the CHECKED-OUT
helper runs `install --if-enabled` as an owned tree under the update's budget, never prunes (the service is live),
and whatever it answers never fails the update — the closed code survives to the FINAL status, where the frontend
reads it, and to the log, without a path."""

from __future__ import annotations

import json
import logging
import sys
import time
from pathlib import Path
from unittest.mock import patch

import psutil
import pytest

from backend.app import step_runtime
from backend.app.api.routes import updates
from backend.app.services import render_runtime_child, step_runtime_child
from backend.tests.unit.test_update_provisions_render_runtime import _fake_exec, _fake_spawn

ROOT = Path(__file__).resolve().parents[3]
SLEEPY = ROOT / "backend" / "tests" / "fixtures" / "windows_build" / "sleepy_helper.py"


def _helper_answer(payload: dict, outcome: str = "ok", returncode: int | None = 0):
    calls = []

    async def run_owned(cmd, **kwargs):
        calls.append((cmd, kwargs))
        return step_runtime_child.OwnedRun(outcome, returncode, json.dumps(payload) + "\n")

    return calls, run_owned


async def _run_update(tmp_path: Path, run_owned) -> list:
    calls: list = []
    with (
        patch.object(updates.settings, "app_dir", tmp_path),
        patch.object(updates, "_find_executable", lambda name: "git" if name == "git" else None),
        patch.object(updates.asyncio, "create_subprocess_exec", _fake_exec(calls)),
        patch.object(render_runtime_child, "_spawn", _fake_spawn(calls, 0, b"")),
        patch.object(step_runtime_child, "run_owned", run_owned),
    ):
        await updates._perform_update("v0.7.0")
    return calls


@pytest.mark.asyncio
async def test_the_update_runs_the_checked_out_helper_if_enabled(tmp_path):
    calls, run_owned = _helper_answer({"ok": True, "bundle": "runtime/step-preview/k/d", "acceptance": "step_to_png"})
    await _run_update(tmp_path, run_owned)
    ((cmd, kwargs),) = calls
    assert cmd == [
        sys.executable,
        "-m",
        "backend.app.step_runtime",
        "install",
        "--if-enabled",
        "--app-dir",
        str(tmp_path),
    ]
    assert kwargs["cwd"] == tmp_path and kwargs["owner_root"] == step_runtime.bundle_root(tmp_path) / ".owner"
    assert kwargs["timeout"] == step_runtime.INSTALL_DEADLINE_SECONDS
    assert updates._update_status["status"] == "complete" and updates._update_status["step_preview"] == "ok"


@pytest.mark.asyncio
async def test_the_cad_result_survives_to_the_final_status(tmp_path, caplog):
    caplog.set_level(logging.INFO)
    reason = "smoke_failed:system_library:libGL.so.1"
    _calls, run_owned = _helper_answer({"ok": False, "reason": reason}, outcome="failed", returncode=1)
    await _run_update(tmp_path, run_owned)
    assert updates._update_status["status"] == "complete"  # the update itself went through
    assert updates._update_status["step_preview"] == reason
    assert any(reason in r.getMessage() for r in caplog.records)
    assert not any(str(tmp_path) in r.getMessage() for r in caplog.records if "STEP" in r.getMessage())


@pytest.mark.asyncio
async def test_an_install_without_the_choice_reports_skipped(tmp_path):
    _calls, run_owned = _helper_answer({"ok": True, "skipped": "not_enabled"})
    await _run_update(tmp_path, run_owned)
    assert updates._update_status["step_preview"] == "skipped"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("outcome", "payload", "code"),
    [
        ("failed", {"ok": False, "reason": "unsupported"}, "unsupported"),
        ("failed", {"ok": False, "reason": "lock_timeout"}, "lock_timeout"),
        ("timeout", {}, "timeout"),
        ("unproven", {}, "unproven"),
        ("helper_unproven", {}, "helper_unproven"),
        ("failed", {"ok": False, "reason": "permission", "detail": "/opt/bamdude/runtime"}, "permission"),
    ],
)
async def test_a_cad_that_fails_never_fails_the_update(tmp_path, outcome, payload, code):
    _calls, run_owned = _helper_answer(payload, outcome=outcome, returncode=1 if outcome == "failed" else None)
    await _run_update(tmp_path, run_owned)
    assert updates._update_status["status"] == "complete" and updates._update_status["step_preview"] == code
    assert "/opt" not in json.dumps(updates._update_status)  # a helper's detail never reaches the status


@pytest.mark.asyncio
async def test_a_helper_that_cannot_even_start_never_fails_the_update(tmp_path):
    async def broken(cmd, **kwargs):
        raise OSError("no such interpreter")

    await _run_update(tmp_path, broken)
    assert updates._update_status["status"] == "complete" and updates._update_status["step_preview"] == "failed"


@pytest.mark.asyncio
async def test_the_update_never_prunes(tmp_path):
    calls, run_owned = _helper_answer({"ok": True})
    await _run_update(tmp_path, run_owned)
    assert all("prune" not in cmd for cmd, _ in calls)


@pytest.mark.asyncio
async def test_a_slow_check_is_stopped_by_the_settings_budget_and_proven_over(tmp_path, monkeypatch):
    """The real owned run under the policy budget: a helper that outlives it is stopped, its whole tree proven gone
    before the update goes on, and the update completes with ``timeout``."""
    marker = tmp_path / "grandchild.pid"
    monkeypatch.setattr(step_runtime, "INSTALL_DEADLINE_SECONDS", 3)
    monkeypatch.setattr(updates, "_step_preview_command", lambda app_dir: [sys.executable, str(SLEEPY), str(marker)])
    begun = time.monotonic()
    code = await updates._provision_step_preview(tmp_path)
    assert code == "timeout" and time.monotonic() - begun < 90
    grandchild = int(marker.read_text(encoding="ascii"))
    assert not psutil.pid_exists(grandchild) or psutil.Process(grandchild).status() == psutil.STATUS_ZOMBIE
    owner_root = step_runtime.bundle_root(tmp_path) / ".owner"
    assert not owner_root.exists() or list(owner_root.iterdir()) == []
