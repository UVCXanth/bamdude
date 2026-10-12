"""The in-app git update provisions the pinned Node.js, as update.sh does.

An install made before part thumbnails, updated by the button in Settings rather than update.sh, would otherwise
come up with ``runtime_missing``: the update ran git, pip and npm and never the provisioning step. It runs the
CHECKED-OUT module in a child process -- the running one is the old code with the old pin -- and a failure never
fails the update: a missing runtime is a missing feature, reported on the System page.
"""

import sys
from pathlib import Path
from unittest.mock import patch

import pytest

from backend.app.api.routes import updates

PROVISION = ["-m", "backend.app.services.render_runtime", "provision", "--runtime"]


class _Process:
    def __init__(self, returncode: int, stderr: bytes = b""):
        self.returncode = returncode
        self._stderr = stderr

    async def communicate(self):
        return b"", self._stderr


def _fake_exec(calls: list, provision_code: int, provision_stderr: bytes = b""):
    async def create_subprocess_exec(*args, **kwargs):
        calls.append((list(args), kwargs.get("cwd")))
        if list(args[1:5]) == PROVISION[:4]:
            return _Process(provision_code, provision_stderr)
        return _Process(0)

    return create_subprocess_exec


async def _run_update(tmp_path: Path, provision_code: int, provision_stderr: bytes = b"") -> list:
    calls: list = []
    with (
        patch.object(updates.settings, "app_dir", tmp_path),
        patch.object(updates, "_find_executable", lambda name: "git" if name == "git" else None),
        patch.object(updates.asyncio, "create_subprocess_exec", _fake_exec(calls, provision_code, provision_stderr)),
    ):
        await updates._perform_update("v0.7.0")
    return calls


def _provision_calls(calls: list) -> list:
    return [(args, cwd) for args, cwd in calls if args[1:5] == PROVISION[:4]]


@pytest.mark.asyncio
async def test_the_update_provisions_the_checked_out_pin_after_the_tree_moved(tmp_path):
    calls = await _run_update(tmp_path, provision_code=0)

    provisions = _provision_calls(calls)
    assert provisions == [([sys.executable, *PROVISION, str(tmp_path / "runtime")], str(tmp_path))]
    order = [args for args, _ in calls]
    reset = next(i for i, args in enumerate(order) if "reset" in args)
    pip = next(i for i, args in enumerate(order) if "pip" in args)
    assert reset < pip < order.index(provisions[0][0])
    assert updates._update_status["status"] == "complete"


@pytest.mark.asyncio
@pytest.mark.parametrize("code", [1, 3])
async def test_a_runtime_that_cannot_be_provisioned_never_fails_the_update(tmp_path, code, caplog):
    calls = await _run_update(tmp_path, provision_code=code, provision_stderr=b"render-runtime: blocked host\n")

    assert len(_provision_calls(calls)) == 1
    assert updates._update_status["status"] == "complete"
    if code == 1:
        assert "render-runtime: blocked host" in caplog.text


@pytest.mark.asyncio
async def test_the_provisioning_is_logged_with_its_start_its_time_and_no_install_path(tmp_path, caplog):
    # final review M9 (parent-log invariant): a start line, the outcome with its elapsed time, and a reason that
    # does not carry the installation's path
    reason = f"render-runtime: {tmp_path / 'runtime' / 'node'}: a tree still held after the retries\n".encode()
    with caplog.at_level("INFO", logger=updates.logger.name):
        await _run_update(tmp_path, provision_code=1, provision_stderr=reason)
    text = caplog.text
    assert "Render runtime provisioning started" in text
    assert "Render runtime update failed after" in text and "<install>" in text
    assert str(tmp_path) not in text
