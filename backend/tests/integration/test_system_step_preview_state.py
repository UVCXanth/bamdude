"""The System page names the STEP component's state (spec stage C R11; plan Task 8): the cheap status — the
administrator's choice and what the receipt says, never "works" — read off the event loop, with the install's
kind so the page knows whether to show the administrator's commands."""

from __future__ import annotations

import pytest

from backend.app import step_runtime
from backend.app.api.routes import system


@pytest.mark.asyncio
async def test_the_system_info_names_the_step_component_state(tmp_path, monkeypatch):
    seen = []

    async def fake_disk(function, *args, **kwargs):
        seen.append((function, args, kwargs))
        return function(*args, **kwargs)

    monkeypatch.setattr(system.settings, "app_dir", tmp_path)
    monkeypatch.setattr(system, "disk", fake_disk)
    monkeypatch.setattr(system.install_kind, "kind", lambda app_dir: "native")
    step_runtime.write_choice(tmp_path, "disabled", by="install")
    state = await system.step_preview_state()
    assert state == {"choice": "disabled", "bundle": "missing", "install_kind": "native"}
    assert [(f, kw.get("check", False)) for f, _a, kw in seen] == [(step_runtime.status, False)]


@pytest.mark.asyncio
async def test_a_status_that_cannot_be_read_says_unknown(tmp_path, monkeypatch):
    async def broken(function, *args, **kwargs):
        raise OSError("unreadable")

    monkeypatch.setattr(system.settings, "app_dir", tmp_path)
    monkeypatch.setattr(system, "disk", broken)
    monkeypatch.setattr(system.install_kind, "kind", lambda app_dir: "native")
    assert await system.step_preview_state() == {"choice": "none", "bundle": "unknown", "install_kind": "native"}
